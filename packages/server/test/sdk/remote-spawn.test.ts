import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

import {
  buildRemoteClaudeCommand,
  buildSshArgs,
  quoteShell,
  runRemoteCommand,
  translateSharedPath,
} from "../../src/sdk/remote-spawn.js";

const executor = {
  host: "192.168.64.4",
  user: "yueyuan",
  port: 2222,
  localRoot: "/Users/yueyuan/Desktop/file/UTM",
  remoteRoot: "/mnt/utm",
  claudePath: "/home/yueyuan/.local/bin/claude",
  remoteClaudeConfigDir: "/home/yueyuan/.claude",
};

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    exitCode: null,
    killed: false,
    kill: vi.fn(() => true),
  });
  return child;
}

describe("remote Claude spawn", () => {
  it("maps only paths beneath the configured shared root", () => {
    expect(
      translateSharedPath(
        "/Users/yueyuan/Desktop/file/UTM/projects/yep",
        executor,
      ),
    ).toBe("/mnt/utm/projects/yep");
    expect(() =>
      translateSharedPath("/Users/yueyuan/Desktop/work/yepanywhere", executor),
    ).toThrow("outside the configured shared root");
  });

  it("passes SSH target data as argv after the option terminator", () => {
    expect(buildSshArgs(executor, "true", 5_000)).toEqual([
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=5",
      "-o",
      "ServerAliveInterval=30",
      "-o",
      "ServerAliveCountMax=3",
      "-p",
      "2222",
      "-l",
      "yueyuan",
      "--",
      "192.168.64.4",
      "true",
    ]);
  });

  it("quotes POSIX shell values", () => {
    expect(quoteShell("a'b")).toBe("'a'\\''b'");
  });

  it("rewrites the bundled SDK CLI and forwards no macOS credential", () => {
    const spawnOptions: SpawnOptions = {
      command: "node",
      args: [
        "/local/node_modules/claude-agent-sdk/cli.js",
        "--output-format",
        "stream-json",
      ],
      cwd: "/mnt/utm/projects/yep",
      env: {
        CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
        CLAUDE_AGENT_SDK_VERSION: "0.3.202",
        ANTHROPIC_API_KEY: "must-not-leave-the-mac",
      },
      signal: new AbortController().signal,
    };

    const built = buildRemoteClaudeCommand(executor, spawnOptions);
    expect(built.cli).toBe("/home/yueyuan/.local/bin/claude");
    expect(built.args).toEqual(["--output-format", "stream-json"]);
    expect(built.remoteCommand).toContain("CLAUDE_CODE_ENTRYPOINT");
    expect(built.remoteCommand).toContain("CLAUDE_AGENT_SDK_VERSION");
    expect(built.remoteCommand).toContain("CLAUDE_CONFIG_DIR");
    expect(built.remoteCommand).not.toContain("must-not-leave-the-mac");
    expect(built.remoteCommand).toContain("exec env");
  });

  it("never sets CLAUDE_CONFIG_DIR for shared session-only storage", () => {
    const spawnOptions: SpawnOptions = {
      command: "node",
      args: ["/local/node_modules/claude-agent-sdk/cli.js"],
      cwd: "/mnt/utm/projects/yep",
      env: {},
      signal: new AbortController().signal,
    };
    const built = buildRemoteClaudeCommand(
      {
        ...executor,
        sessionStorage: {
          mode: "shared",
          localProjectsDir: "/Users/yueyuan/Desktop/file/UTM/claude/projects",
          remoteProjectsDir: "/mnt/utm/claude/projects",
        },
      },
      spawnOptions,
    );
    expect(built.remoteCommand).not.toContain("CLAUDE_CONFIG_DIR");
  });

  it("preserves split UTF-8 code points and trailing newlines", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    const resultPromise = runRemoteCommand(executor, "cat file");
    const payload = Buffer.from("汉😀\n", "utf8");
    child.stdout?.emit("data", payload.subarray(0, 1));
    child.stdout?.emit("data", payload.subarray(1, 5));
    child.stdout?.emit("data", payload.subarray(5));
    child.emit("exit", 0);

    await expect(resultPromise).resolves.toMatchObject({
      success: true,
      stdout: "汉😀\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("terminates an SSH child when either output stream exceeds its byte limit", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    const resultPromise = runRemoteCommand(executor, "large-output", 1_000, 3);
    child.stdout?.emit("data", Buffer.from("four"));

    const result = await resultPromise;
    expect(result.success).toBe(false);
    expect(result.error).toContain("stdout exceeded 3 bytes");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("terminates an SSH child on command timeout", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    try {
      const resultPromise = runRemoteCommand(executor, "hang", 25);
      await vi.advanceTimersByTimeAsync(25);
      await expect(resultPromise).resolves.toMatchObject({
        success: false,
        exitCode: null,
        error: "Remote command timed out after 25ms",
      });
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });
});
