import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileWatcher } from "../../src/watcher/FileWatcher.js";
import type { FileChangeEvent } from "../../src/watcher/index.js";

describe("FileWatcher periodic rescan", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it("reports create, modify and delete in nested directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "file-watcher-"));
    const events: FileChangeEvent[] = [];
    const watcher = new FileWatcher({
      watchDir: root,
      provider: "pi",
      eventBus: {
        emit: (event: FileChangeEvent) => events.push(event),
      } as never,
      debounceMs: 10,
      periodicRescanMs: 40,
    });
    watcher.start();
    cleanups.push(async () => {
      watcher.stop();
      await rm(root, { recursive: true, force: true });
    });

    const file = join(root, "project", "session.jsonl");
    await mkdir(join(root, "project"));
    await writeFile(file, "{}\n");
    const ofType = (changeType: string) =>
      events.filter((e) => e.path === file && e.changeType === changeType);
    await vi.waitFor(() => expect(ofType("create")).toHaveLength(1));

    const later = new Date(Date.now() + 5_000);
    await utimes(file, later, later);
    await vi.waitFor(() => expect(ofType("modify").length).toBeGreaterThan(0));

    await rm(file);
    await vi.waitFor(() => expect(ofType("delete")).toHaveLength(1));
    expect(ofType("create")).toHaveLength(1);
  });
});
