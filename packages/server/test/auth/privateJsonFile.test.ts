import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writePrivateJsonAtomic } from "../../src/auth/privateJsonFile.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: vi.fn(actual.rename),
  };
});

describe("writePrivateJsonAtomic", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "private-json-test-"));
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("atomically writes valid private JSON", async () => {
    const filePath = path.join(testDir, "credentials.json");

    await writePrivateJsonAtomic(filePath, { version: 1, value: "stored" });

    await expect(fs.readFile(filePath, "utf8")).resolves.toBe(
      '{\n  "version": 1,\n  "value": "stored"\n}',
    );
    if (process.platform !== "win32") {
      const stat = await fs.stat(filePath);
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it("preserves an existing target and removes its temp file when rename fails", async () => {
    const filePath = path.join(testDir, "credentials.json");
    const oldBytes = '{"version":1,"value":"old"}';
    await fs.writeFile(filePath, oldBytes, "utf8");
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error("rename failed"));

    await expect(
      writePrivateJsonAtomic(filePath, { version: 1, value: "new" }),
    ).rejects.toThrow("rename failed");

    await expect(fs.readFile(filePath, "utf8")).resolves.toBe(oldBytes);
    await expect(fs.readdir(testDir)).resolves.toEqual(["credentials.json"]);
  });
});
