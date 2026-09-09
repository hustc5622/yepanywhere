import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { MobileServerSwitcher } from "../MobileServerSwitcher";

const mocks = vi.hoisted(() => ({
  mobile: true,
  setNode: vi.fn(),
  getNotifications: vi.fn(),
}));

vi.mock("../../hooks/useMobileShellChannel", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../hooks/useMobileShellChannel")
  >()),
  useMobileShellChannel: () => ({
    isMobileShell: mocks.mobile,
    nodeOrigin: "http://47.95.254.240:5750",
    setNode: mocks.setNode,
  }),
}));
vi.mock("../../lib/nativePushBridge", () => ({
  getMobileNodeNotifications: mocks.getNotifications,
}));

function view(visible = true) {
  return (
    <I18nProvider>
      <MobileServerSwitcher visible={visible} />
    </I18nProvider>
  );
}

describe("APK server shortcuts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.mobile = true;
    mocks.getNotifications.mockResolvedValue({
      nodes: [
        { alias: "home", status: "online", finishedUnreadCount: 3 },
        { alias: "mini", status: "online", finishedUnreadCount: 2 },
      ],
    });
  });
  afterEach(() => vi.useRealTimers());

  it("shows independent counts and switches only when choosing another server", async () => {
    render(view());
    await act(async () => {});
    const home = screen.getByRole("button", { name: /Home.*3/ });
    const mini = screen.getByRole("button", { name: /Mini.*2/ });
    expect(home.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("button", { name: /air/i })).toBeNull();
    fireEvent.click(home);
    expect(mocks.setNode).not.toHaveBeenCalled();
    fireEvent.click(mini);
    expect(mocks.setNode).toHaveBeenCalledWith(
      expect.objectContaining({ origin: "http://39.106.189.88:18022" }),
    );
  });

  it("refreshes counts after reading and pauses when the sidebar closes", async () => {
    const rendered = render(view());
    await act(async () => {});
    mocks.getNotifications.mockResolvedValue({
      nodes: [
        { alias: "home", status: "online", finishedUnreadCount: 0 },
        { alias: "mini", status: "offline" },
      ],
    });
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(screen.getByRole("button", { name: /Home.*0/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Mini.*Offline/ })).toBeTruthy();
    rendered.rerender(view(false));
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(mocks.getNotifications).toHaveBeenCalledTimes(2);
  });

  it("keeps a healthy server count when the other server needs login", async () => {
    mocks.getNotifications.mockResolvedValue({
      nodes: [
        { alias: "home", status: "online", finishedUnreadCount: 3 },
        { alias: "mini", status: "login-required" },
      ],
    });
    render(view());
    await act(async () => {});
    expect(screen.getByRole("button", { name: /Home.*3/ })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Mini.*Sign in required/ }),
    ).toBeTruthy();
  });

  it("keeps shortcuts usable on an older APK without the notification bridge", async () => {
    mocks.getNotifications.mockRejectedValue(
      new Error("Unsupported native push method"),
    );
    render(view());
    await act(async () => {});
    fireEvent.click(
      screen.getByRole("button", { name: /Mini.*Notifications unavailable/ }),
    );
    expect(mocks.setNode).toHaveBeenCalledOnce();
  });

  it("does not render or query outside the APK", () => {
    mocks.mobile = false;
    render(view());
    expect(screen.queryByRole("button")).toBeNull();
    expect(mocks.getNotifications).not.toHaveBeenCalled();
  });
});
