import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import bcrypt from "bcrypt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminPasswordService } from "../../src/auth/AdminPasswordService.js";
import { AUTH_ERROR_CODES, type AuthError } from "../../src/auth/authErrors.js";

describe("AdminPasswordService", () => {
  let testDir: string;
  let filePath: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "admin-password-test-"));
    filePath = path.join(testDir, "admin.json");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("uses one system-user path regardless of Profile environment", () => {
    vi.stubEnv("YEP_ANYWHERE_PROFILE", "dev");
    vi.stubEnv("YEP_ANYWHERE_DATA_DIR", path.join(testDir, "profile-data"));
    const expected = path.join(os.homedir(), ".yep-anywhere", "admin.json");

    expect(AdminPasswordService.getDefaultFilePath()).toBe(expected);
    expect(new AdminPasswordService().getFilePath()).toBe(expected);
  });

  it("stores and verifies only a bcrypt administrator hash", async () => {
    const service = new AdminPasswordService({ filePath });

    await expect(service.isConfigured()).resolves.toBe(false);
    await service.setPassword("admin-password");
    await expect(service.isConfigured()).resolves.toBe(true);
    await expect(service.verifyPassword("admin-password")).resolves.toBe(true);
    await expect(service.verifyPassword("wrong-password")).resolves.toBe(false);

    const stored = JSON.parse(await fs.readFile(filePath, "utf8"));
    expect(stored).toEqual({ version: 1, passwordHash: expect.any(String) });
    expect(stored.passwordHash).not.toContain("admin-password");
    expect(await bcrypt.getRounds(stored.passwordHash)).toBe(12);
  });

  it("creates its private parent directory on first setup", async () => {
    filePath = path.join(testDir, "fresh", ".yep-anywhere", "admin.json");
    const service = new AdminPasswordService({ filePath });

    await service.setPassword("admin-password");

    await expect(service.verifyPassword("admin-password")).resolves.toBe(true);
  });

  it("resets the shared hash without touching Profile data", async () => {
    const profilePath = path.join(testDir, "profiles", "dev", "auth.json");
    const profileState = '{"version":2,"sessions":{}}';
    await fs.mkdir(path.dirname(profilePath), { recursive: true });
    await fs.writeFile(profilePath, profileState, "utf8");
    const service = new AdminPasswordService({ filePath });

    await service.setPassword("old-admin-password");
    await service.setPassword("new-admin-password");

    await expect(service.verifyPassword("old-admin-password")).resolves.toBe(
      false,
    );
    await expect(service.verifyPassword("new-admin-password")).resolves.toBe(
      true,
    );
    await expect(fs.readFile(profilePath, "utf8")).resolves.toBe(profileState);
  });

  it("rejects a short administrator password without creating a file", async () => {
    const service = new AdminPasswordService({ filePath });

    await expect(service.setPassword("short")).rejects.toMatchObject<
      Partial<AuthError>
    >({ code: AUTH_ERROR_CODES.passwordInvalid });
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["malformed JSON", "not-json"],
    [
      "unsupported version",
      JSON.stringify({ version: 2, passwordHash: "hash" }),
    ],
    ["missing hash", JSON.stringify({ version: 1 })],
  ])("fails safely for %s", async (_label, content) => {
    await fs.writeFile(filePath, content, "utf8");
    const service = new AdminPasswordService({ filePath });

    await expect(service.isConfigured()).rejects.toMatchObject<
      Partial<AuthError>
    >({ code: AUTH_ERROR_CODES.configError });
    await expect(
      service.verifyPassword("admin-password"),
    ).rejects.toMatchObject<Partial<AuthError>>({
      code: AUTH_ERROR_CODES.configError,
    });
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe(content);
  });

  it("maps write failures to a safe configuration error", async () => {
    await fs.writeFile(filePath, "occupied", "utf8");
    filePath = path.join(filePath, "admin.json");
    const failingService = new AdminPasswordService({ filePath });

    const error = await failingService
      .setPassword("admin-password")
      .catch((cause) => cause);

    expect(error).toMatchObject<Partial<AuthError>>({
      code: AUTH_ERROR_CODES.configError,
    });
    expect(String(error)).not.toContain("admin-password");
  });
});
