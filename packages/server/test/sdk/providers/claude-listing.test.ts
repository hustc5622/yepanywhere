import type { ModelInfo, RemoteExecutorConfig } from "@yep-anywhere/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { probeRemoteClaudeControl } = vi.hoisted(() => ({
  probeRemoteClaudeControl: vi.fn(),
}));

vi.mock(
  "../../../src/sdk/providers/claude-control.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../src/sdk/providers/claude-control.js")
      >();
    return { ...actual, probeRemoteClaudeControl };
  },
);

import { ClaudeProvider } from "../../../src/sdk/providers/claude.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const executor: RemoteExecutorConfig = {
  host: "claude-vm",
  localRoot: "/tmp/yep-local",
  remoteRoot: "/tmp/yep-remote",
};

describe("Claude provider catalog loading", () => {
  beforeEach(() => {
    probeRemoteClaudeControl.mockReset();
  });

  it("returns fallback models immediately and refreshes the remote catalog once", async () => {
    const probe = deferred<{
      models: ModelInfo[];
      usage: null;
      modelsError: null;
      usageError: string;
    }>();
    probeRemoteClaudeControl.mockReturnValueOnce(probe.promise);
    const provider = new ClaudeProvider({ remoteExecutors: [executor] });

    const first = await provider.getAvailableModels({
      waitForRefresh: false,
    });
    const second = await provider.getAvailableModels({
      waitForRefresh: false,
    });

    expect(first[0]?.id).toBe("default");
    expect(second[0]?.id).toBe("default");
    expect(probeRemoteClaudeControl).toHaveBeenCalledTimes(1);

    probe.resolve({
      models: [{ id: "remote-model", name: "Remote model" }],
      usage: null,
      modelsError: null,
      usageError: "unavailable",
    });
    await vi.waitFor(async () => {
      await expect(provider.getAvailableModels()).resolves.toEqual([
        { id: "remote-model", name: "Remote model" },
      ]);
    });
  });

  it("caches a failed probe instead of retrying it on every listing", async () => {
    probeRemoteClaudeControl.mockRejectedValueOnce(new Error("SSH offline"));
    const provider = new ClaudeProvider({ remoteExecutors: [executor] });

    await provider.getAvailableModels({ waitForRefresh: false });
    await vi.waitFor(() => {
      expect(probeRemoteClaudeControl).toHaveBeenCalledTimes(1);
    });
    // Let the rejected background probe update the retry window.
    await Promise.resolve();
    await Promise.resolve();

    const models = await provider.getAvailableModels();

    expect(models[0]?.id).toBe("default");
    expect(probeRemoteClaudeControl).toHaveBeenCalledTimes(1);
  });
});
