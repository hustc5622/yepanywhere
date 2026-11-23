import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthService } from "../../src/auth/AuthService.js";

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
});

describe("AuthService credential reload", () => {
  let service: AuthService;
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-reload-test-"));
    service = new AuthService({
      dataDir: testDir,
      cookieSecret: "test-secret",
    });
    await service.initialize();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  /** A second AuthService on the same data dir stands in for `yepanywhere --setup-auth`. */
  async function runCliReset(password: string): Promise<void> {
    const cli = new AuthService({ dataDir: testDir, cookieSecret: "cli" });
    await cli.initialize();
    await cli.enableAuth(password);
  }

  it("reports no change when auth.json has not been rewritten", async () => {
    await service.enableAuth("initial-password");

    await expect(service.refreshAccountFromDisk()).resolves.toEqual({
      reloaded: false,
      credentialChanged: false,
    });
  });

  it("adopts a password written by another process and keeps live sessions", async () => {
    await service.enableAuth("initial-password");
    const liveSession = await service.createSession("test-agent", {
      authMethod: "password",
    });

    await runCliReset("rotated-password");

    await expect(service.refreshAccountFromDisk()).resolves.toEqual({
      reloaded: true,
      credentialChanged: true,
    });
    expect(await service.verifyPassword("rotated-password")).toBe(true);
    expect(await service.verifyPassword("initial-password")).toBe(false);
    // The running server keeps its own session table instead of adopting the
    // one written by the short-lived CLI process.
    expect(await service.validateSession(liveSession)).toBe(true);
  });

  it("reloads unrelated state without flagging a credential change", async () => {
    await service.enableAuth("initial-password");
    const cli = new AuthService({ dataDir: testDir, cookieSecret: "cli" });
    await cli.initialize();
    await cli.setLocalhostOpen(true);

    await expect(service.refreshAccountFromDisk()).resolves.toEqual({
      reloaded: true,
      credentialChanged: false,
    });
    expect(service.isLocalhostOpen()).toBe(true);
  });

  it("ignores an unreadable auth.json instead of losing the active account", async () => {
    await service.enableAuth("initial-password");
    await fs.writeFile(
      path.join(testDir, "auth.json"),
      "{not valid json",
      "utf-8",
    );

    await expect(service.refreshAccountFromDisk()).resolves.toEqual({
      reloaded: false,
      credentialChanged: false,
    });
    expect(await service.verifyPassword("initial-password")).toBe(true);
  });
});
