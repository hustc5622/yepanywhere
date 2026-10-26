import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readPiCommandCache,
  writePiCommandCache,
} from "../../src/sdk/providers/pi-command-cache.js";

describe("Pi command cache", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = join(tmpdir(), `pi-command-cache-${randomUUID()}`);
    vi.stubEnv("YEP_ANYWHERE_DATA_DIR", dataDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("remembers the last list per working directory", async () => {
    await expect(readPiCommandCache("/repo/a")).resolves.toBeNull();

    await writePiCommandCache("/repo/a", [
      { name: "review", description: "Review", source: "extension" },
    ]);
    await writePiCommandCache("/repo/b", [
      { name: "skill:x", description: "", source: "skill" },
    ]);
    await writePiCommandCache("/repo/a", [
      { name: "fix", description: "Fix", source: "prompt" },
    ]);

    await expect(readPiCommandCache("/repo/a")).resolves.toEqual([
      { name: "fix", description: "Fix", source: "prompt" },
    ]);
    await expect(readPiCommandCache("/repo/b")).resolves.toEqual([
      { name: "skill:x", description: "", source: "skill" },
    ]);
    const file = JSON.parse(
      await readFile(join(dataDir, "pi-commands.json"), "utf8"),
    );
    expect(file.version).toBe(1);
    expect(Object.keys(file.byCwd).sort()).toEqual(["/repo/a", "/repo/b"]);
  });
});
