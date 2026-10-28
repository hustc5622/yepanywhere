import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACPClient } from "../../../src/sdk/providers/acp/client.js";
import { MCODE_FALLBACK_MODELS } from "../../../src/sdk/providers/mcode-models.js";
import { McodeProvider } from "../../../src/sdk/providers/mcode.js";
import * as store from "../../../src/sessions/mcode-store.js";
import fixture from "../../fixtures/mcode-model-config-options.json";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  readFile: vi.fn(),
}));

// Captured from installed mcode 0.6.12: the retired-model session only
// advertises permissionMode; a valid idle session advertises the new M78.
const current = fixture.current as SessionConfigOption[];
const retired = fixture.retiredModel as SessionConfigOption[];
const old = current.map((option) =>
  option.id === "model"
    ? JSON.parse(
        JSON.stringify(option).replaceAll("MiniMax-M78", "MiniMax-M3-Pro"),
      )
    : option,
) as SessionConfigOption[];

function record(sessionId: string, status = "idle", cwd = tmpdir()) {
  return {
    sessionId,
    status,
    cwd,
    title: null,
    createdAtMs: 0,
    updatedAtMs: 0,
    historyDir: tmpdir(),
    messagesPath: join(tmpdir(), "unused-mcode-messages.jsonl"),
  };
}

let revision: number;
let provider: McodeProvider;
beforeEach(() => {
  revision = 1;
  vi.mocked(fs.readFile).mockImplementation(async () =>
    Buffer.from(`config revision: ${revision}`),
  );
  vi.spyOn(store, "listMcodeSessionRecords").mockResolvedValue([
    record("valid"),
  ]);
  vi.spyOn(ACPClient.prototype, "connect").mockResolvedValue();
  vi.spyOn(ACPClient.prototype, "initialize").mockResolvedValue({
    protocolVersion: 1,
  });
  vi.spyOn(ACPClient.prototype, "resumeSession").mockImplementation(
    async (id) => id,
  );
  vi.spyOn(ACPClient.prototype, "requestExtension").mockResolvedValue({});
  vi.spyOn(ACPClient.prototype, "getSessionConfigOptions").mockReturnValue(
    current,
  );
  vi.spyOn(ACPClient.prototype, "close").mockImplementation(() => {});
  provider = new McodeProvider({ mcodePath: process.execPath });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("MiniMax Code catalog refresh", () => {
  it("skips active, missing, failed and retired-model sessions to read the current catalog", async () => {
    vi.mocked(store.listMcodeSessionRecords).mockResolvedValue([
      record("active", "started"),
      record("missing", "idle", "/nonexistent/mcode-catalog-test"),
      record("failed"),
      record("retired"),
      record("valid"),
    ]);
    vi.mocked(ACPClient.prototype.resumeSession).mockRejectedValueOnce(
      new Error("unavailable"),
    );
    vi.mocked(ACPClient.prototype.getSessionConfigOptions).mockImplementation(
      (id) => (id === "retired" ? retired : current),
    );
    const create = vi.spyOn(ACPClient.prototype, "newSession");
    const models = await provider.getAvailableModels();
    expect(models.some((model) => model.id.endsWith("/MiniMax-M78"))).toBe(
      true,
    );
    expect(models.some((model) => model.id.endsWith("/MiniMax-M3-Pro"))).toBe(
      false,
    );
    expect(
      vi.mocked(ACPClient.prototype.resumeSession).mock.calls.map(([id]) => id),
    ).toEqual(["failed", "retired", "valid"]);
    expect(vi.mocked(ACPClient.prototype.requestExtension).mock.calls).toEqual([
      ["session/close", { sessionId: "retired" }],
      ["session/close", { sessionId: "valid" }],
    ]);
    expect(create).not.toHaveBeenCalled();
    expect(ACPClient.prototype.close).toHaveBeenCalledOnce();
  });

  it("invalidates a warm cache immediately on config changes and shares the refresh", async () => {
    vi.mocked(ACPClient.prototype.getSessionConfigOptions).mockReturnValueOnce(
      old,
    );
    const before = await provider.getAvailableModels();
    expect(before.some((model) => model.id.endsWith("/MiniMax-M3-Pro"))).toBe(
      true,
    );
    expect(await provider.getAvailableModels()).toEqual(before);
    expect(ACPClient.prototype.connect).toHaveBeenCalledOnce();
    revision++;
    const [left, right] = await Promise.all([
      provider.getAvailableModels(),
      provider.getAvailableModels({ waitForRefresh: true }),
    ]);
    expect(left).toEqual(right);
    expect(left.some((model) => model.id.endsWith("/MiniMax-M78"))).toBe(true);
    expect(left.some((model) => model.id.endsWith("/MiniMax-M3-Pro"))).toBe(
      false,
    );
    expect(ACPClient.prototype.connect).toHaveBeenCalledTimes(2);
  });

  it("does not reuse deleted models if the changed config cannot be probed", async () => {
    vi.mocked(ACPClient.prototype.getSessionConfigOptions).mockReturnValueOnce(
      old,
    );
    await provider.getAvailableModels();
    revision++;
    vi.mocked(ACPClient.prototype.getSessionConfigOptions).mockReturnValue(
      retired,
    );
    expect(await provider.getAvailableModels()).toEqual(MCODE_FALLBACK_MODELS);
    vi.mocked(ACPClient.prototype.getSessionConfigOptions).mockReturnValue(
      current,
    );
    // An empty probe is not cached as a successful refresh.
    expect(
      (await provider.getAvailableModels()).some((model) =>
        model.id.endsWith("/MiniMax-M78"),
      ),
    ).toBe(true);
  });

  it("discards results if the config changes while a probe is running", async () => {
    vi.mocked(ACPClient.prototype.resumeSession).mockImplementationOnce(
      async (id) => {
        revision++;
        return id;
      },
    );
    expect(await provider.getAvailableModels()).toEqual(MCODE_FALLBACK_MODELS);
    await provider.getAvailableModels();
    expect(ACPClient.prototype.connect).toHaveBeenCalledTimes(2);
  });

  it("keeps discovery nonblocking and lets a waiting request consume the background result", async () => {
    let finish!: () => void;
    const connected = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.mocked(ACPClient.prototype.connect).mockReturnValue(connected);
    expect(
      await provider.getAvailableModels({ waitForRefresh: false }),
    ).toEqual(MCODE_FALLBACK_MODELS);
    const waiting = provider.getAvailableModels({ waitForRefresh: true });
    finish();
    expect(
      (await waiting).some((model) => model.id.endsWith("/MiniMax-M78")),
    ).toBe(true);
    expect(ACPClient.prototype.connect).toHaveBeenCalledOnce();
  });

  it("uses one timeout budget and stops trying sessions after the discovery client closes", async () => {
    vi.useFakeTimers();
    vi.mocked(store.listMcodeSessionRecords).mockResolvedValue([
      record("slow"),
      record("valid"),
    ]);
    let reject!: (error: Error) => void;
    vi.mocked(ACPClient.prototype.resumeSession).mockReturnValue(
      new Promise((_resolve, rejectPromise) => {
        reject = rejectPromise;
      }),
    );
    vi.mocked(ACPClient.prototype.close).mockImplementation(() =>
      reject(new Error("closed")),
    );
    const result = provider.getAvailableModels();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await result).toEqual(MCODE_FALLBACK_MODELS);
    expect(ACPClient.prototype.resumeSession).toHaveBeenCalledTimes(1);
  });
});
