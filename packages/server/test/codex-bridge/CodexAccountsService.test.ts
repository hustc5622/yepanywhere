import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAccountsService } from "../../src/codex-bridge/CodexAccountsService.js";

const mocks = vi.hoisted(() => ({
  construct: vi.fn(),
  start: vi.fn(),
  request: vi.fn(),
  close: vi.fn(),
}));
vi.mock("../../src/codex-bridge/CodexAppServerClient.js", () => ({
  CodexAppServerClient: class {
    constructor(options: unknown) {
      mocks.construct(options);
    }
    start = mocks.start;
    request = mocks.request;
    close = mocks.close;
  },
}));

describe("CodexAccountsService reset", () => {
  let dir: string;
  afterEach(async () => {
    vi.resetAllMocks();
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  const setup = async () => {
    dir = await mkdtemp(join(tmpdir(), "yep-reset-test-"));
    return new CodexAccountsService({
      dataDir: dir,
      defaultCodexHome: join(dir, "default"),
    });
  };

  it.each(["reset", "alreadyRedeemed", "nothingToReset", "noCredit"])(
    "uses the selected account's home and returns %s",
    async (outcome) => {
      const service = await setup();
      const account = service.addAccount();
      mocks.request.mockResolvedValue({ outcome });
      const params = { creditId: "credit-1", idempotencyKey: "same-attempt" };
      expect(await service.resetUsage(account.id, params)).toEqual({ outcome });
      expect(mocks.construct).toHaveBeenCalledWith(
        expect.objectContaining({ codexHome: account.codexHome }),
      );
      expect(mocks.request).toHaveBeenCalledOnce();
      expect(mocks.request).toHaveBeenCalledWith(
        "account/rateLimitResetCredit/consume",
        params,
      );
      expect(mocks.close).toHaveBeenCalledOnce();
    },
  );

  it("does not fall back to the default account for unknown IDs", async () => {
    const service = await setup();
    await expect(
      service.resetUsage("missing", { idempotencyKey: "key" }),
    ).rejects.toThrow("Unknown Codex account");
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("closes its own client on failure and does not retry", async () => {
    const service = await setup();
    mocks.request.mockRejectedValue(new Error("timeout"));
    await expect(
      service.resetUsage("default", { idempotencyKey: "key" }),
    ).rejects.toThrow("timeout");
    expect(mocks.request).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
