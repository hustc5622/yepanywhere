import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ProjectGitStatusSummary } from "@yep-anywhere/shared";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { I18nProvider } from "../../i18n";
import { writeClipboardText } from "../../lib/clipboard";
import { UI_KEYS } from "../../lib/storageKeys";
import { ProjectGitStatusButton } from "../ProjectGitStatusButton";

vi.mock("../../lib/clipboard", () => ({
  writeClipboardText: vi.fn(),
}));

const STATUS: ProjectGitStatusSummary = {
  isGitRepo: true,
  branch: "feature/sidebar-git-details",
  head: "abc1234",
  upstream: "origin/feature/sidebar-git-details",
  ahead: 2,
  behind: 1,
  isClean: false,
  stagedCount: 2,
  unstagedCount: 14,
  deletedCount: 1,
  untrackedCount: 3,
  conflictedCount: 0,
  stashCount: 1,
};

const originalPointerEvent = window.PointerEvent;

class MockPointerEvent extends MouseEvent {
  readonly pointerType: string;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? "";
  }
}

function renderButton(status = STATUS, locale: "en" | "zh-CN" = "en") {
  localStorage.setItem(UI_KEYS.locale, locale);
  return render(
    <I18nProvider>
      <ProjectGitStatusButton status={status} projectName="Yep Anywhere" />
    </I18nProvider>,
  );
}

describe("ProjectGitStatusButton", () => {
  beforeEach(() => {
    vi.mocked(writeClipboardText).mockReset().mockResolvedValue(undefined);
  });

  beforeAll(() => {
    Object.defineProperty(window, "PointerEvent", {
      configurable: true,
      value: MockPointerEvent,
    });
  });

  afterAll(() => {
    Object.defineProperty(window, "PointerEvent", {
      configurable: true,
      value: originalPointerEvent,
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    localStorage.removeItem(UI_KEYS.locale);
  });

  it("shows the complete Git summary on mouse hover", () => {
    vi.useFakeTimers();
    renderButton();
    const button = screen.getByRole("button", {
      name: "Show Git details for Yep Anywhere",
    });

    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.pointerEnter(button, { pointerType: "mouse" });

    const popover = screen.getByRole("dialog");
    expect(popover.textContent).toContain("feature/sidebar-git-details");
    expect(popover.textContent).toContain("Ahead 2");
    expect(popover.textContent).toContain("Behind 1");
    expect(popover.textContent).toContain("Changes14");
    expect(popover.textContent).toContain("Untracked3");

    fireEvent.pointerLeave(button, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("pins the summary after a touch long-press without closing on its click", () => {
    vi.useFakeTimers();
    renderButton();
    const button = screen.getByRole("button", {
      name: "Show Git details for Yep Anywhere",
    });

    fireEvent.pointerDown(button, {
      pointerType: "touch",
      clientX: 20,
      clientY: 20,
    });
    act(() => vi.advanceTimersByTime(500));

    expect(screen.getByRole("dialog")).not.toBeNull();
    fireEvent.pointerUp(button, { pointerType: "touch" });
    fireEvent.click(button);
    expect(screen.getByRole("dialog")).not.toBeNull();
  });

  it("opens on tap/click and closes when clicking outside", () => {
    renderButton();
    const button = screen.getByRole("button", {
      name: "Show Git details for Yep Anywhere",
    });

    fireEvent.click(button);
    expect(screen.getByRole("dialog")).not.toBeNull();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the summary open while moving across the gap to a copy button", async () => {
    vi.useFakeTimers();
    renderButton();
    const button = screen.getByRole("button");
    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    const popover = screen.getByRole("dialog");

    fireEvent.pointerLeave(button, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(100));
    fireEvent.pointerEnter(popover, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(200));

    const copyButton = screen.getByRole("button", {
      name: "Copy full branch name",
    });
    fireEvent.pointerDown(copyButton, { pointerType: "mouse" });
    await act(async () => fireEvent.click(copyButton));
    expect(writeClipboardText).toHaveBeenCalledWith(STATUS.branch);
    expect(screen.getByRole("dialog")).toBe(popover);

    act(() => vi.advanceTimersByTime(1500));
    expect(copyButton.getAttribute("aria-label")).toBe("Copy full branch name");
    fireEvent.pointerLeave(popover, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each([
    {
      locale: "en" as const,
      branchLabel: "Copy full branch name",
      upstreamLabel: "Copy full upstream branch name",
      copiedLabel: "Copied!",
    },
    {
      locale: "zh-CN" as const,
      branchLabel: "复制完整分支名",
      upstreamLabel: "复制完整上游分支名",
      copiedLabel: "已复制！",
    },
  ])(
    "copies complete long branch names with $locale feedback",
    async ({ locale, branchLabel, upstreamLabel, copiedLabel }) => {
      const branch =
        "integrate/823-casespec-v2-preview-launch-and-streaming-support-with-a-very-long-branch-name";
      const upstream = `origin/${branch}`;
      renderButton({ ...STATUS, branch, upstream }, locale);
      fireEvent.click(screen.getByRole("button"));
      const branchButton = await screen.findByRole("button", {
        name: branchLabel,
      });
      const upstreamButton = screen.getByRole("button", {
        name: upstreamLabel,
      });

      fireEvent.click(branchButton);
      await waitFor(() =>
        expect(branchButton.getAttribute("aria-label")).toBe(copiedLabel),
      );
      expect(writeClipboardText).toHaveBeenNthCalledWith(1, branch);
      expect(upstreamButton.getAttribute("aria-label")).toBe(upstreamLabel);

      fireEvent.click(upstreamButton);
      await waitFor(() =>
        expect(upstreamButton.getAttribute("aria-label")).toBe(copiedLabel),
      );
      expect(writeClipboardText).toHaveBeenNthCalledWith(2, upstream);
      expect(screen.getByRole("dialog")).not.toBeNull();
    },
  );

  it("shows a copy failure and allows retrying without closing the summary", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(writeClipboardText).mockRejectedValueOnce(
      new Error("Clipboard unavailable"),
    );
    renderButton();
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(
      screen.getByRole("button", { name: "Copy full branch name" }),
    );

    const retryButton = await screen.findByRole("button", {
      name: "Copy failed, try again",
    });
    fireEvent.click(retryButton);

    expect(
      await screen.findByRole("button", { name: "Copied!" }),
    ).not.toBeNull();
    expect(writeClipboardText).toHaveBeenCalledTimes(2);
    expect(writeClipboardText).toHaveBeenLastCalledWith(STATUS.branch);
    expect(screen.getByRole("dialog")).not.toBeNull();
  });

  it("allows keyboard access to copy controls and restores focus on Escape", () => {
    vi.useFakeTimers();
    renderButton();
    const button = screen.getByRole("button");
    act(() => button.focus());
    fireEvent.keyDown(button, { key: "Tab" });
    const copyButton = screen.getByRole("button", {
      name: "Copy full branch name",
    });

    expect(document.activeElement).toBe(copyButton);
    fireEvent.pointerLeave(button, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByRole("dialog")).not.toBeNull();

    fireEvent.keyDown(copyButton, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(button);
    fireEvent.keyDown(button, { key: "ArrowDown" });
    expect(document.activeElement).toBe(copyButton);

    fireEvent.keyDown(copyButton, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("continues the sidebar tab order after the last copy control", () => {
    renderButton();
    const button = screen.getByRole("button");
    act(() => button.focus());
    const upstreamButton = screen.getByRole("button", {
      name: "Copy full upstream branch name",
    });
    act(() => upstreamButton.focus());

    expect(fireEvent.keyDown(upstreamButton, { key: "Tab" })).toBe(true);
    expect(document.activeElement).toBe(button);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not offer branch copy controls for a detached HEAD without an upstream", () => {
    renderButton({ ...STATUS, branch: null, upstream: null });
    fireEvent.click(screen.getByRole("button"));

    expect(screen.getByRole("dialog").textContent).toContain(`:${STATUS.head}`);
    expect(
      screen.queryByRole("button", { name: "Copy full branch name" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Copy full upstream branch name" }),
    ).toBeNull();
  });
});
