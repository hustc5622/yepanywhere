import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
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

describe("CodexAccountsService activation", () => {
  let dir: string;
  let machineHome: string;
  afterEach(async () => {
    vi.resetAllMocks();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const setup = async () => {
    dir = await mkdtemp(join(tmpdir(), "yep-account-switch-"));
    machineHome = join(dir, "machine");
    return new CodexAccountsService({
      dataDir: dir,
      defaultCodexHome: machineHome,
    });
  };

  const signIn = async (home: string, id: string, refresh = "first") => {
    await mkdir(home, { recursive: true });
    const auth = JSON.stringify({
      tokens: {
        account_id: id,
        // Deliberately share an email: workspace identities must stay separate.
        id_token: `header.${Buffer.from(
          JSON.stringify({ sub: "user", email: "same@example.com" }),
        ).toString("base64url")}.signature`,
        refresh_token: refresh,
      },
    });
    await writeFile(join(home, "auth.json"), auth);
    return auth;
  };
  const authAt = (home: string) => readFile(join(home, "auth.json"), "utf8");

  it("preserves the initial account and keeps both profiles through repeated switches", async () => {
    const service = await setup();
    const originalAuth = await signIn(machineHome, "original");
    const second = service.addAccount();
    const secondAuth = await signIn(second.codexHome, "second");

    await service.activate(second.id);
    const original = service
      .listProfiles()
      .find((profile) => profile.id !== "default" && profile.id !== second.id);
    expect(original).toBeDefined();
    if (!original) throw new Error("Missing saved original account");
    expect(await authAt(original.codexHome)).toBe(originalAuth);
    expect(await authAt(machineHome)).toBe(secondAuth);

    await service.activate(original.id);
    expect(await authAt(machineHome)).toBe(originalAuth);
    expect(await authAt(second.codexHome)).toBe(secondAuth);
    await service.activate(second.id);
    expect(await authAt(machineHome)).toBe(secondAuth);
    expect(service.listProfiles()).toHaveLength(3);
  });

  it("mirrors refreshed outgoing credentials to the same saved identity", async () => {
    const service = await setup();
    await signIn(machineHome, "original");
    const original = service.addAccount();
    await signIn(original.codexHome, "original");
    const second = service.addAccount();
    await signIn(second.codexHome, "second");
    const renewed = await signIn(machineHome, "original", "renewed");
    await service.activate(second.id);
    expect(await authAt(original.codexHome)).toBe(renewed);
    expect(service.listProfiles()).toHaveLength(3);
  });

  it("matches active credentials by identity instead of email", async () => {
    const service = await setup();
    await signIn(machineHome, "second");
    const original = service.addAccount();
    await signIn(original.codexHome, "original");
    const second = service.addAccount();
    await signIn(second.codexHome, "second");
    mocks.request.mockResolvedValue({
      account: { type: "chatgpt", email: "same@example.com", planType: "pro" },
    });
    const entries = await service.list();
    expect(entries.find((entry) => entry.id === original.id)?.isActive).toBe(
      false,
    );
    expect(entries.find((entry) => entry.id === second.id)?.isActive).toBe(
      true,
    );
  });

  it("serializes simultaneous switches without losing the initial login", async () => {
    const service = await setup();
    const initial = await signIn(machineHome, "initial");
    const second = service.addAccount();
    await signIn(second.codexHome, "second");
    const third = service.addAccount();
    const last = await signIn(third.codexHome, "third");
    await Promise.all([
      service.activate(second.id),
      service.activate(third.id),
    ]);
    expect(await authAt(machineHome)).toBe(last);
    const profiles = service.listProfiles();
    expect(profiles).toHaveLength(4);
    expect(
      await Promise.all(profiles.map((profile) => authAt(profile.codexHome))),
    ).toContain(initial);
    expect(await readdir(join(dir, "codex-homes", "_backups"))).toHaveLength(2);
  });

  it("keeps the login on invalid activation and allows a later valid switch", async () => {
    const service = await setup();
    const initial = await signIn(machineHome, "initial");
    const second = service.addAccount();
    await expect(service.activate(second.id)).rejects.toThrow("not signed in");
    expect(await authAt(machineHome)).toBe(initial);
    const next = await signIn(second.codexHome, "second");
    await service.activate(second.id);
    expect(await authAt(machineHome)).toBe(next);
  });
});
