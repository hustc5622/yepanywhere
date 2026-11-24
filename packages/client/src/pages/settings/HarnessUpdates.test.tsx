import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { HarnessUpdateInfo } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { HarnessUpdates } from "./HarnessUpdates";

vi.mock("../../api/client", () => ({
  api: {
    getHarnessUpdates: vi.fn(),
    checkHarnessUpdate: vi.fn(),
    checkAllHarnessUpdates: vi.fn(),
    updateHarness: vi.fn(),
    updateAllHarnesses: vi.fn(),
    stopDshWeb: vi.fn(),
    launchDshWeb: vi.fn(),
  },
}));
vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string>) =>
      [key, ...Object.values(values ?? {})].join(" "),
  }),
}));

const installed: HarnessUpdateInfo = {
  id: "codex",
  displayName: "Codex CLI",
  path: "/nvm/bin/codex",
  currentVersion: "0.1.0",
  manager: "npm",
  canUpdate: true,
  updateAvailable: false,
};
const available: HarnessUpdateInfo = {
  ...installed,
  latestVersion: "0.2.0",
  updateAvailable: true,
};

describe("HarnessUpdates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getHarnessUpdates).mockResolvedValue({
      harnesses: [installed],
    });
    vi.mocked(api.checkHarnessUpdate).mockResolvedValue({ harness: available });
    vi.mocked(api.checkAllHarnessUpdates).mockResolvedValue({
      harnesses: [available],
    });
    vi.mocked(api.updateHarness).mockResolvedValue({
      job: { id: "job-1", status: "running", startedAt: "2026-10-08", log: "" },
    });
    vi.mocked(api.updateAllHarnesses).mockResolvedValue({
      started: ["codex"],
      jobs: {
        codex: {
          id: "job-1",
          status: "running",
          startedAt: "2026-10-08",
          log: "",
        },
      },
    });
  });
  afterEach(() => vi.useRealTimers());

  it("checks for updates on demand and disables duplicate updates", async () => {
    render(<HarnessUpdates />);
    const update = await screen.findByRole("button", {
      name: "harnessUpdatesUpdateFor Codex CLI",
    });
    expect(update.hasAttribute("disabled")).toBe(true);
    expect(api.checkHarnessUpdate).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "harnessUpdatesCheckFor Codex CLI" }),
    );
    await screen.findByText("harnessUpdatesAvailable 0.2.0");
    expect(update.hasAttribute("disabled")).toBe(false);
    fireEvent.click(update);
    await screen.findByText("harnessUpdatesContinues");
    expect(update.hasAttribute("disabled")).toBe(true);
    expect(api.updateHarness).toHaveBeenCalledTimes(1);
    expect(api.updateHarness).toHaveBeenCalledWith("codex");
  });

  it("restores a running job on remount and polls through a transient error", async () => {
    vi.useFakeTimers();
    const running: HarnessUpdateInfo = {
      ...available,
      job: {
        id: "job-1",
        status: "running",
        startedAt: "2026-10-08",
        log: "installing",
      },
    };
    vi.mocked(api.getHarnessUpdates).mockResolvedValueOnce({
      harnesses: [running],
    });
    const first = render(<HarnessUpdates />);
    await act(async () => {});
    expect(screen.getByText("harnessUpdatesContinues")).toBeTruthy();
    first.unmount();
    vi.mocked(api.getHarnessUpdates)
      .mockResolvedValueOnce({ harnesses: [running] })
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockResolvedValue({
        harnesses: [
          {
            ...available,
            currentVersion: "0.2.0",
            updateAvailable: false,
            job: {
              id: "job-1",
              startedAt: "2026-10-08",
              log: "installed",
              status: "completed",
              toVersion: "0.2.0",
            },
          },
        ],
      });
    render(<HarnessUpdates />);
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(screen.getByText("connection lost")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(screen.getByText("harnessUpdatesCompleted 0.2.0")).toBeTruthy();
    expect(screen.queryByText("connection lost")).toBeNull();
  });

  it("explains unsupported installations and busy harnesses", async () => {
    vi.mocked(api.getHarnessUpdates).mockResolvedValue({
      harnesses: [
        {
          ...available,
          canUpdate: false,
          blockedReason: "unsupported_install",
        },
        {
          ...available,
          id: "pi",
          displayName: "Pi Agent",
          canUpdate: false,
          blockedReason: "busy",
        },
      ],
    });
    render(<HarnessUpdates />);
    await screen.findByText("harnessUpdatesUnsupported");
    expect(screen.getByText("harnessUpdatesBusy")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "harnessUpdatesUpdateFor Codex CLI" }),
    ).toHaveProperty("disabled", true);
    expect(
      screen.getByRole("button", { name: "harnessUpdatesUpdateFor Pi Agent" }),
    ).toHaveProperty("disabled", true);
    expect(
      screen.getByRole("button", { name: "harnessUpdatesCheckFor Pi Agent" }),
    ).toHaveProperty("disabled", false);
  });

  it("allows retrying a failed update and keeps diagnostics visible", async () => {
    vi.mocked(api.getHarnessUpdates).mockResolvedValue({
      harnesses: [
        {
          ...installed,
          job: {
            id: "failed",
            status: "failed",
            startedAt: "2026-10-08",
            log: "npm failed",
            error: "EACCES",
          },
        },
      ],
    });
    render(<HarnessUpdates />);
    await screen.findByText("harnessUpdatesFailed EACCES");
    fireEvent.click(screen.getByText("harnessUpdatesRetry"));
    await waitFor(() =>
      expect(api.updateHarness).toHaveBeenCalledWith("codex"),
    );
  });

  it("requires confirmation to stop DSH, then permits updating without automatically restarting", async () => {
    const dsh: HarnessUpdateInfo = {
      ...available,
      id: "dsh",
      displayName: "dsh",
      currentVersion: "0.2.1-rc.2",
      latestVersion: "0.2.1-rc.3",
      canUpdate: false,
      blockedReason: "busy",
      webRunning: true,
    };
    vi.mocked(api.getHarnessUpdates).mockResolvedValue({ harnesses: [dsh] });
    vi.mocked(api.stopDshWeb).mockImplementation(async () => {
      vi.mocked(api.getHarnessUpdates).mockResolvedValue({
        harnesses: [
          {
            ...dsh,
            webRunning: false,
            canUpdate: true,
            blockedReason: undefined,
          },
        ],
      });
      return { stopped: true };
    });
    render(<HarnessUpdates />);
    const stop = await screen.findByRole("button", {
      name: "harnessUpdatesDshStop",
    });
    expect(
      screen.getByRole("button", { name: "harnessUpdatesUpdateFor dsh" }),
    ).toHaveProperty("disabled", true);
    fireEvent.click(stop);
    expect(api.stopDshWeb).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "harnessUpdatesDshCancel" }),
    );
    expect(api.stopDshWeb).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "harnessUpdatesDshStop" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "harnessUpdatesDshConfirmStop" }),
    );
    await screen.findByText("harnessUpdatesDshStopped");
    expect(api.stopDshWeb).toHaveBeenCalledOnce();
    const update = screen.getByRole("button", {
      name: "harnessUpdatesUpdateFor dsh",
    });
    expect(update).toHaveProperty("disabled", false);
    fireEvent.click(update);
    await waitFor(() => expect(api.updateHarness).toHaveBeenCalledWith("dsh"));
    expect(api.launchDshWeb).not.toHaveBeenCalled();
  });

  it("starts a stopped DSH process only on request", async () => {
    const dsh: HarnessUpdateInfo = {
      ...installed,
      id: "dsh",
      displayName: "dsh",
      webRunning: false,
    };
    vi.mocked(api.getHarnessUpdates).mockResolvedValue({ harnesses: [dsh] });
    vi.mocked(api.launchDshWeb).mockImplementation(async () => {
      vi.mocked(api.getHarnessUpdates).mockResolvedValue({
        harnesses: [
          { ...dsh, webRunning: true, canUpdate: false, blockedReason: "busy" },
        ],
      });
      return { url: "/yep/apps/dsh/" };
    });
    render(<HarnessUpdates />);
    fireEvent.click(
      await screen.findByRole("button", { name: "harnessUpdatesDshStart" }),
    );
    await screen.findByText("harnessUpdatesDshRunning");
    expect(api.launchDshWeb).toHaveBeenCalledOnce();
    expect(api.updateHarness).not.toHaveBeenCalled();
  });

  it("supports self-updating CLIs and one-click check-all / update-all actions", async () => {
    const agy: HarnessUpdateInfo = {
      id: "agy",
      displayName: "Antigravity CLI",
      path: "/local/bin/agy",
      currentVersion: "1.5.15",
      manager: "self",
      supportsCheck: false,
      canUpdate: true,
      updateAvailable: false,
    };
    const wrappedCodex: HarnessUpdateInfo = {
      ...installed,
      path: "/local/bin/yep-codex-proxy",
      resolvedPath: "/nvm/bin/codex",
    };
    vi.mocked(api.getHarnessUpdates).mockResolvedValue({
      harnesses: [wrappedCodex, agy],
    });
    vi.mocked(api.checkAllHarnessUpdates).mockResolvedValue({
      harnesses: [
        { ...wrappedCodex, latestVersion: "0.2.0", updateAvailable: true },
        agy,
      ],
    });
    vi.mocked(api.updateAllHarnesses).mockResolvedValue({
      started: ["codex", "agy"],
      jobs: {
        codex: {
          id: "job-1",
          status: "running",
          startedAt: "2026-10-08",
          log: "",
        },
        agy: {
          id: "job-2",
          status: "queued",
          startedAt: "2026-10-08",
          log: "",
        },
      },
    });

    render(<HarnessUpdates />);
    const agyUpdate = await screen.findByRole("button", {
      name: "harnessUpdatesUpdateFor Antigravity CLI",
    });
    // Self-updating CLIs don't have a separate Check button and can update directly.
    expect(
      screen.queryByRole("button", {
        name: "harnessUpdatesCheckFor Antigravity CLI",
      }),
    ).toBeNull();
    expect(agyUpdate.hasAttribute("disabled")).toBe(false);
    expect(screen.getByText("/nvm/bin/codex")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "harnessUpdatesCheckAll" }),
    );
    await screen.findByText("harnessUpdatesAvailable 0.2.0");
    expect(api.checkAllHarnessUpdates).toHaveBeenCalledOnce();

    fireEvent.click(
      screen.getByRole("button", { name: "harnessUpdatesUpdateAll" }),
    );
    await screen.findByText("harnessUpdatesQueuedHint");
    expect(api.updateAllHarnesses).toHaveBeenCalledOnce();
  });
});
