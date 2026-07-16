import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  getProjectDirFromCwd,
  materializeRemoteSessionFile,
  rewriteSessionCwds,
} from "../../src/sdk/session-sync.js";

describe("remote Claude session sync", () => {
  it("uses Claude's encoded project directory format", () => {
    expect(getProjectDirFromCwd("/mnt/utm/projects/yep")).toBe(
      "-mnt-utm-projects-yep",
    );
  });

  it("rewrites only top-level cwd fields in the local replica", () => {
    const first = {
      type: "user",
      cwd: "/mnt/utm/projects/yep",
      message: {
        content: "keep /mnt/utm/projects/yep in transcript text",
      },
    };
    const second = {
      type: "assistant",
      cwd: "/mnt/utm/projects/yep/packages/server",
      tool: { path: "/mnt/utm/projects/yep/package.json" },
    };
    const content = `${JSON.stringify(first)}\n${JSON.stringify(second)}\npartial {\n`;

    const rewritten = rewriteSessionCwds(
      content,
      "/mnt/utm/projects/yep",
      "/Users/yueyuan/Desktop/file/UTM/projects/yep",
    );
    const lines = rewritten.trimEnd().split("\n");
    const rewrittenFirst = JSON.parse(lines[0] ?? "{}") as typeof first;
    const rewrittenSecond = JSON.parse(lines[1] ?? "{}") as typeof second;

    expect(rewrittenFirst.cwd).toBe(
      "/Users/yueyuan/Desktop/file/UTM/projects/yep",
    );
    expect(rewrittenFirst.message.content).toContain("/mnt/utm/projects/yep");
    expect(rewrittenSecond.cwd).toBe(
      "/Users/yueyuan/Desktop/file/UTM/projects/yep/packages/server",
    );
    expect(rewrittenSecond.tool.path).toBe(
      "/mnt/utm/projects/yep/package.json",
    );
    expect(lines[2]).toBe("partial {");
    expect(rewritten.endsWith("\n")).toBe(true);
  });

  it("reads a shared JSONL in place without invoking SSH replica sync", async () => {
    const root = await mkdtemp(join(tmpdir(), "yep-shared-session-"));
    const projectsDir = join(root, "claude", "projects");
    const remoteCwd = "/mnt/utm/projects/中文";
    const sessionId = "shared-session";
    const sessionDir = join(projectsDir, getProjectDirFromCwd(remoteCwd));
    const sessionPath = join(sessionDir, `${sessionId}.jsonl`);
    const content = `${JSON.stringify({ type: "user", cwd: remoteCwd, text: "你好😀" })}\n`;
    await mkdir(sessionDir, { recursive: true });
    await writeFile(sessionPath, content);

    const syncReplica = vi.fn();
    try {
      const result = await materializeRemoteSessionFile(
        {
          executor: {
            host: "unreachable.example",
            localRoot: root,
            remoteRoot: "/mnt/utm",
            sessionStorage: {
              mode: "shared",
              localProjectsDir: projectsDir,
              remoteProjectsDir: "/mnt/utm/claude/projects",
            },
          },
          localCwd: join(root, "projects", "中文"),
          remoteCwd,
          sessionId,
          sharedVisibilityTimeoutMs: 0,
        },
        { syncReplica },
      );

      expect(result).toMatchObject({
        success: true,
        mode: "shared",
        localPath: sessionPath,
        bytesTransferred: 0,
      });
      expect(syncReplica).not.toHaveBeenCalled();
      expect(await readFile(sessionPath, "utf8")).toBe(content);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns a warning result instead of falling back when a shared file is late", async () => {
    const root = await mkdtemp(join(tmpdir(), "yep-shared-session-"));
    const syncReplica = vi.fn();
    try {
      const result = await materializeRemoteSessionFile(
        {
          executor: {
            host: "utm",
            localRoot: root,
            remoteRoot: "/mnt/utm",
            sessionStorage: {
              mode: "shared",
              localProjectsDir: join(root, "claude", "projects"),
              remoteProjectsDir: "/mnt/utm/claude/projects",
            },
          },
          localCwd: join(root, "projects", "demo"),
          remoteCwd: "/mnt/utm/projects/demo",
          sessionId: "missing",
          sharedVisibilityTimeoutMs: 0,
        },
        { syncReplica },
      );

      expect(result.success).toBe(false);
      expect(result.mode).toBe("shared");
      expect(result.error).toContain("not visible");
      expect(syncReplica).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
