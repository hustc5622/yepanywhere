import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../src/supervisor/types.js";
import {
  type FocusedSessionWatchEvent,
  FocusedSessionWatchManager,
} from "../../src/watcher/FocusedSessionWatchManager.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForChange(
  collector: FocusedSessionWatchEvent[],
  timeoutMs = 3000,
): Promise<FocusedSessionWatchEvent> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      const first = collector[0];
      if (first) {
        clearInterval(interval);
        resolve(first);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        reject(new Error("Timed out waiting for focused watch change event"));
      }
    }, 25);
  });
}

describe("FocusedSessionWatchManager", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.map(async (dir) => {
        try {
          await rm(dir, { recursive: true, force: true });
        } catch {
          // ignore cleanup errors
        }
      }),
    );
    tempDirs.length = 0;
  });

  it("emits change events for a watched claude session file", async () => {
    const root = await mkdtemp(join(tmpdir(), "focused-watch-claude-"));
    tempDirs.push(root);
    const sessionDir = join(root, "projects", "demo");
    await mkdir(sessionDir, { recursive: true });

    const sessionId = "session-claude-1";
    const filePath = join(sessionDir, `${sessionId}.jsonl`);
    await writeFile(filePath, '{"type":"user","message":"hello"}\n');

    const projectId = "L3RtcC9kZW1v" as UrlProjectId;
    const project: Project = {
      id: projectId,
      path: "/tmp/demo",
      name: "demo",
      sessionCount: 1,
      sessionDir,
      activeOwnedCount: 0,
      activeExternalCount: 0,
      lastActivity: null,
      provider: "claude",
    };

    const manager = new FocusedSessionWatchManager({
      scanner: {
        getProject: async () => project,
        getOrCreateProject: async () => project,
      },
      codexScanner: {
        getSessionsForProject: async () => [],
      },
      geminiScanner: {
        getSessionsForProject: async () => [],
      },
      pollMs: 100,
      debounceMs: 30,
    });

    const events: FocusedSessionWatchEvent[] = [];
    const unsubscribe = manager.subscribe({ sessionId, projectId }, (event) =>
      events.push(event),
    );

    await delay(250);
    await appendFile(filePath, '{"type":"assistant","message":"world"}\n');

    const event = await waitForChange(events);
    expect(event.type).toBe("session-watch-change");
    expect(event.sessionId).toBe(sessionId);
    expect(event.projectId).toBe(projectId);
    expect(event.provider).toBe("claude");
    expect(event.path).toBe(filePath);

    unsubscribe();
    manager.dispose();
  });

  it("uses providerHint=codex to resolve codex session files", async () => {
    const root = await mkdtemp(join(tmpdir(), "focused-watch-codex-"));
    tempDirs.push(root);
    const codexDir = join(root, "codex", "sessions", "2026", "02", "18");
    await mkdir(codexDir, { recursive: true });

    const sessionId = "7e0cd95f-8f16-4a8d-b96f-938b3ca42ad8";
    const filePath = join(
      codexDir,
      `rollout-2026-02-18T00-00-00-${sessionId}.jsonl`,
    );
    await writeFile(filePath, '{"type":"session_meta","payload":{"id":"x"}}\n');

    const projectId = "L3RtcC9kZW1vLWNvZGV4" as UrlProjectId;
    const project: Project = {
      id: projectId,
      path: "/tmp/demo-codex",
      name: "demo-codex",
      sessionCount: 1,
      sessionDir: join(root, "projects", "unused"),
      activeOwnedCount: 0,
      activeExternalCount: 0,
      lastActivity: null,
      provider: "claude",
    };

    const codexScanner = {
      getSessionsForProject: vi
        .fn<() => Promise<Array<{ id: string; filePath: string }>>>()
        .mockResolvedValue([{ id: sessionId, filePath }]),
    };

    const manager = new FocusedSessionWatchManager({
      scanner: {
        getProject: async () => project,
        getOrCreateProject: async () => project,
      },
      codexScanner,
      geminiScanner: {
        getSessionsForProject: async () => [],
      },
      pollMs: 100,
      debounceMs: 30,
    });

    const events: FocusedSessionWatchEvent[] = [];
    const unsubscribe = manager.subscribe(
      { sessionId, projectId, providerHint: "codex" },
      (event) => events.push(event),
    );

    await delay(250);
    await appendFile(
      filePath,
      '{"type":"response_item","payload":{"ok":true}}\n',
    );

    const event = await waitForChange(events);
    expect(event.provider).toBe("codex");
    expect(event.path).toBe(filePath);
    expect(codexScanner.getSessionsForProject).toHaveBeenCalledWith(
      project.path,
    );

    unsubscribe();
    manager.dispose();
  });
});
