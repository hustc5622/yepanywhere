import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import bcrypt from "bcrypt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "../../src/auth/AuthService.js";
import { AUTH_ERROR_CODES, type AuthError } from "../../src/auth/authErrors.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: vi.fn(actual.rename),
  };
});

const realFs =
  await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

describe("AuthService file permissions", () => {
  let service: AuthService;
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-service-test-"));
    service = new AuthService({
      dataDir: testDir,
      cookieSecret: "test-secret",
    });
    await service.initialize();
  });

  afterEach(async () => {
    vi.mocked(fs.rename).mockImplementation(realFs.rename);
    vi.mocked(fs.rename).mockClear();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("writes auth.json with 0600 permissions", async () => {
    if (process.platform === "win32") {
      return;
    }

    await service.createSession("test-agent");

    const filePath = path.join(testDir, "auth.json");
    const stat = await fs.stat(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("tightens permissions on existing auth.json files at startup", async () => {
    if (process.platform === "win32") {
      return;
    }

    const filePath = path.join(testDir, "auth.json");
    await fs.writeFile(
      filePath,
      JSON.stringify({ version: 1, sessions: {} }, null, 2),
      "utf-8",
    );
    await fs.chmod(filePath, 0o644);

    const newService = new AuthService({
      dataDir: testDir,
      cookieSecret: "test-secret",
    });
    await newService.initialize();

    const stat = await fs.stat(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("uses a v2 two-state login password and clears sessions on each transition", async () => {
    expect(service.isEnabled()).toBe(false);
    expect(service.hasAccount()).toBe(false);
    await service.createSession("test-agent");

    await service.setLoginPassword("login-password");

    expect(service.isEnabled()).toBe(true);
    expect(service.hasAccount()).toBe(true);
    await expect(service.verifyPassword("login-password")).resolves.toBe(true);
    const enabledState = JSON.parse(
      await fs.readFile(path.join(testDir, "auth.json"), "utf8"),
    );
    expect(enabledState).toMatchObject({ version: 2, sessions: {} });
    expect(enabledState).not.toHaveProperty("enabled");

    await service.disableAuth();

    expect(service.isEnabled()).toBe(false);
    expect(service.hasAccount()).toBe(false);
    await expect(service.verifyPassword("login-password")).resolves.toBe(false);
    const disabledState = JSON.parse(
      await fs.readFile(path.join(testDir, "auth.json"), "utf8"),
    );
    expect(disabledState).toEqual({ version: 2, sessions: {} });
  });

  it("migrates an enabled v1 state without losing credentials, localhostOpen, or sessions", async () => {
    const passwordHash = await bcrypt.hash("login-password", 12);
    const session = {
      createdAt: "2026-08-12T00:00:00.000Z",
      lastActiveAt: "2026-08-12T00:00:00.000Z",
      userAgent: "test-agent",
    };
    const filePath = path.join(testDir, "auth.json");
    await fs.writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        enabled: true,
        localhostOpen: true,
        account: {
          passwordHash,
          createdAt: "2026-08-12T00:00:00.000Z",
        },
        sessions: { existing: session },
      }),
      "utf8",
    );
    const migrated = new AuthService({
      dataDir: testDir,
      cookieSecret: "test-secret",
    });

    await migrated.initialize();

    expect(migrated.isEnabled()).toBe(true);
    expect(migrated.isLocalhostOpen()).toBe(true);
    await expect(migrated.verifyPassword("login-password")).resolves.toBe(true);
    const stored = JSON.parse(await fs.readFile(filePath, "utf8"));
    expect(stored).toMatchObject({
      version: 2,
      localhostOpen: true,
      account: { passwordHash },
      sessions: { existing: expect.any(Object) },
    });
    expect(stored.sessions.existing).toEqual(session);
    expect(stored).not.toHaveProperty("enabled");
  });

  it("migrates a disabled v1 state by dropping credentials and sessions", async () => {
    const filePath = path.join(testDir, "auth.json");
    await fs.writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        enabled: false,
        localhostOpen: true,
        account: {
          passwordHash: "legacy-hash",
          createdAt: "2026-08-12T00:00:00.000Z",
        },
        sessions: {
          existing: {
            createdAt: "2026-08-12T00:00:00.000Z",
            lastActiveAt: "2026-08-12T00:00:00.000Z",
          },
        },
      }),
      "utf8",
    );
    const migrated = new AuthService({
      dataDir: testDir,
      cookieSecret: "test-secret",
    });

    await migrated.initialize();

    expect(migrated.isEnabled()).toBe(false);
    expect(migrated.isLocalhostOpen()).toBe(true);
    const stored = JSON.parse(await fs.readFile(filePath, "utf8"));
    expect(stored).toEqual({
      version: 2,
      localhostOpen: true,
      sessions: {},
    });
  });

  it.each([
    ["malformed JSON", "not-json"],
    ["unknown version", JSON.stringify({ version: 3, sessions: {} })],
    [
      "invalid account",
      JSON.stringify({
        version: 2,
        account: { passwordHash: 7 },
        sessions: {},
      }),
    ],
    ["invalid sessions", JSON.stringify({ version: 2, sessions: [] })],
  ])(
    "fails safely for %s without replacing the source",
    async (_label, content) => {
      const filePath = path.join(testDir, "auth.json");
      await fs.writeFile(filePath, content, "utf8");
      const invalid = new AuthService({
        dataDir: testDir,
        cookieSecret: "test-secret",
      });

      await expect(invalid.initialize()).rejects.toMatchObject<
        Partial<AuthError>
      >({ code: AUTH_ERROR_CODES.configError });
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe(content);
    },
  );

  it("rejects a short login password without changing state", async () => {
    await expect(service.setLoginPassword("short")).rejects.toMatchObject<
      Partial<AuthError>
    >({ code: AUTH_ERROR_CODES.passwordInvalid });
    expect(service.isEnabled()).toBe(false);
    await expect(
      fs.stat(path.join(testDir, "auth.json")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps the previous disk and memory state when a password write fails", async () => {
    await service.setLoginPassword("old-password");
    const filePath = path.join(testDir, "auth.json");
    const oldBytes = await fs.readFile(filePath, "utf8");
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error("rename failed"));

    await expect(service.setLoginPassword("new-password")).rejects.toThrow(
      "rename failed",
    );

    await expect(service.verifyPassword("old-password")).resolves.toBe(true);
    await expect(service.verifyPassword("new-password")).resolves.toBe(false);
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe(oldBytes);
  });

  it("recovers session persistence after a transient write failure", async () => {
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error("rename failed"));

    await expect(service.createSession("first-agent")).rejects.toThrow(
      "rename failed",
    );
    const recoveredSessionId = await service.createSession("second-agent");

    const stored = JSON.parse(
      await fs.readFile(path.join(testDir, "auth.json"), "utf8"),
    );
    expect(stored.sessions[recoveredSessionId]).toMatchObject({
      userAgent: "second-agent",
    });
  });

  it("makes each concurrent session save observe its own write failure", async () => {
    let releaseFirstRename: (() => void) | undefined;
    let firstRenameStarted: (() => void) | undefined;
    const firstRename = new Promise<void>((resolve) => {
      firstRenameStarted = resolve;
    });
    const releaseFirst = new Promise<void>((resolve) => {
      releaseFirstRename = resolve;
    });
    let renameCount = 0;
    vi.mocked(fs.rename).mockImplementation(async (oldPath, newPath) => {
      renameCount += 1;
      if (renameCount === 1) {
        firstRenameStarted?.();
        await releaseFirst;
        await realFs.rename(oldPath, newPath);
        return;
      }
      throw new Error("second rename failed");
    });

    const firstSession = service.createSession("first-agent");
    await firstRename;
    const secondSession = service.createSession("second-agent");
    releaseFirstRename?.();

    const [firstResult, secondResult] = await Promise.allSettled([
      firstSession,
      secondSession,
    ]);
    expect(firstResult.status).toBe("fulfilled");
    expect(secondResult).toMatchObject({
      status: "rejected",
      reason: new Error("second rename failed"),
    });
  });

  it("does not let an in-flight session save overwrite a password transition", async () => {
    await service.setLoginPassword("login-password");
    let releaseFirstRename: (() => void) | undefined;
    let firstRenameStarted: (() => void) | undefined;
    const firstRename = new Promise<void>((resolve) => {
      firstRenameStarted = resolve;
    });
    const releaseFirst = new Promise<void>((resolve) => {
      releaseFirstRename = resolve;
    });
    let renameCount = 0;
    vi.mocked(fs.rename).mockImplementation(async (oldPath, newPath) => {
      renameCount += 1;
      if (renameCount === 1) {
        firstRenameStarted?.();
        await releaseFirst;
      }
      await realFs.rename(oldPath, newPath);
    });

    const sessionSave = service.createSession("test-agent");
    await firstRename;
    const passwordTransition = service.disableAuth();
    releaseFirstRename?.();
    await Promise.all([sessionSave, passwordTransition]);

    const stored = JSON.parse(
      await fs.readFile(path.join(testDir, "auth.json"), "utf8"),
    );
    expect(stored).toEqual({ version: 2, sessions: {} });
    await expect(service.verifyPassword("login-password")).resolves.toBe(false);
  });

  it("persists a session created during an in-flight password transition", async () => {
    await service.setLoginPassword("login-password");
    let releaseTransitionRename: (() => void) | undefined;
    let transitionRenameStarted: (() => void) | undefined;
    const transitionRename = new Promise<void>((resolve) => {
      transitionRenameStarted = resolve;
    });
    const releaseTransition = new Promise<void>((resolve) => {
      releaseTransitionRename = resolve;
    });
    let renameCount = 0;
    vi.mocked(fs.rename).mockImplementation(async (oldPath, newPath) => {
      renameCount += 1;
      if (renameCount === 1) {
        transitionRenameStarted?.();
        await releaseTransition;
      }
      await realFs.rename(oldPath, newPath);
    });

    const passwordTransition = service.disableAuth();
    await transitionRename;
    const session = service.createSession("test-agent");
    releaseTransitionRename?.();
    const [, sessionId] = await Promise.all([passwordTransition, session]);

    const stored = JSON.parse(
      await fs.readFile(path.join(testDir, "auth.json"), "utf8"),
    );
    expect(stored.sessions[sessionId]).toMatchObject({
      userAgent: "test-agent",
    });
  });

  it("does not revive a logged-out session during an in-flight session write", async () => {
    const oldSessionId = await service.createSession("old-agent");
    let releaseRename: (() => void) | undefined;
    let renameStarted: (() => void) | undefined;
    const rename = new Promise<void>((resolve) => {
      renameStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseRename = resolve;
    });
    vi.mocked(fs.rename).mockImplementationOnce(async (oldPath, newPath) => {
      renameStarted?.();
      await release;
      await realFs.rename(oldPath, newPath);
    });

    const sessionWrite = service.createSession("new-agent");
    await rename;
    const logout = service.invalidateSession(oldSessionId);
    releaseRename?.();
    await Promise.all([sessionWrite, logout]);

    const stored = JSON.parse(
      await fs.readFile(path.join(testDir, "auth.json"), "utf8"),
    );
    expect(stored.sessions[oldSessionId]).toBeUndefined();
  });

  it("does not create a session from a password verified before a password transition", async () => {
    await service.setLoginPassword("old-password");
    let releaseCompare: (() => void) | undefined;
    let compareStarted: (() => void) | undefined;
    const compare = new Promise<void>((resolve) => {
      compareStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseCompare = resolve;
    });
    const realCompare = bcrypt.compare.bind(bcrypt);
    const compareSpy = vi
      .spyOn(bcrypt, "compare")
      .mockImplementationOnce(async (password, hash) => {
        const valid = await realCompare(password, hash);
        compareStarted?.();
        await release;
        return valid;
      });

    const login = service.createSessionForPassword("old-password", "old-agent");
    await compare;
    await service.setLoginPassword("new-password");
    releaseCompare?.();

    await expect(login).resolves.toBeNull();
    compareSpy.mockRestore();
    const stored = JSON.parse(
      await fs.readFile(path.join(testDir, "auth.json"), "utf8"),
    );
    expect(stored.sessions).toEqual({});
  });

  it("does not write auth.json while validating an active session", async () => {
    const sessionId = await service.createSession("test-agent");
    vi.mocked(fs.rename).mockClear();

    await expect(service.validateSession(sessionId)).resolves.toBe(true);

    expect(fs.rename).not.toHaveBeenCalled();
  });

  it("preserves a localhost setting queued after an in-flight password transition", async () => {
    await service.setLoginPassword("login-password");
    let releaseFirstRename: (() => void) | undefined;
    let firstRenameStarted: (() => void) | undefined;
    const firstRename = new Promise<void>((resolve) => {
      firstRenameStarted = resolve;
    });
    const releaseFirst = new Promise<void>((resolve) => {
      releaseFirstRename = resolve;
    });
    let renameCount = 0;
    vi.mocked(fs.rename).mockImplementation(async (oldPath, newPath) => {
      renameCount += 1;
      if (renameCount === 1) {
        firstRenameStarted?.();
        await releaseFirst;
      }
      await realFs.rename(oldPath, newPath);
    });

    const passwordTransition = service.disableAuth();
    await firstRename;
    const localhostTransition = service.setLocalhostOpen(true);
    releaseFirstRename?.();
    await Promise.all([passwordTransition, localhostTransition]);

    expect(service.isLocalhostOpen()).toBe(true);
    const stored = JSON.parse(
      await fs.readFile(path.join(testDir, "auth.json"), "utf8"),
    );
    expect(stored).toEqual({
      version: 2,
      localhostOpen: true,
      sessions: {},
    });
  });
});
