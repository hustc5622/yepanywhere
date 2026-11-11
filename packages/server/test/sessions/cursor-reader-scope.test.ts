import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CursorSessionReader } from "../../src/sessions/cursor-reader.js";

describe("Cursor session reader project scope", () => {
  let sessionsDir: string;

  beforeEach(async () => {
    sessionsDir = await mkdtemp(join(tmpdir(), "cursor-scope-"));
    for (const [id, cwd] of [
      ["mine", "/tmp/project-a"],
      ["theirs", "/tmp/project-b"],
    ]) {
      const dir = join(sessionsDir, id);
      await mkdir(dir);
      await writeFile(join(dir, "meta.json"), JSON.stringify({ cwd }));
      await writeFile(join(dir, "store.db"), "not a database");
    }
  });

  afterEach(async () => {
    await rm(sessionsDir, { recursive: true, force: true });
  });

  it("lists only this project's sessions so other projects never dirty its index", async () => {
    const reader = new CursorSessionReader({
      sessionsDir,
      projectPath: "/tmp/project-a",
    });
    const files = await reader.listSessionFiles(sessionsDir);
    expect(files.map((file) => file.sessionId)).toEqual(["mine"]);
  });

  it("lists every session for an unscoped reader", async () => {
    const reader = new CursorSessionReader({ sessionsDir });
    const files = await reader.listSessionFiles(sessionsDir);
    expect(files.map((file) => file.sessionId).sort()).toEqual([
      "mine",
      "theirs",
    ]);
  });
});
