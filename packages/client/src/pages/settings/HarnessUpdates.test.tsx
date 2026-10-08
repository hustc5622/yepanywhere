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
    updateHarness: vi.fn(),
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
    vi.mocked(api.updateHarness).mockResolvedValue({
      job: { id: "job-1", status: "running", startedAt: "2026-10-08", log: "" },
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
});
