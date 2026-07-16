import { describe, expect, it } from "vitest";
import {
  parseRemoteExecutorConfig,
  parseRemoteExecutorConfigs,
} from "../../src/sdk/remote-executor-config.js";

describe("remote executor config", () => {
  it("normalizes a valid UTM mapping", () => {
    expect(
      parseRemoteExecutorConfig({
        host: " 192.168.64.4 ",
        user: " yueyuan ",
        port: "22",
        localRoot: "/Users/yueyuan/Desktop/file/UTM/",
        remoteRoot: "/mnt/utm/",
        claudePath: "/home/yueyuan/.local/bin/claude",
      }),
    ).toEqual({
      executor: {
        host: "192.168.64.4",
        user: "yueyuan",
        port: 22,
        localRoot: "/Users/yueyuan/Desktop/file/UTM",
        remoteRoot: "/mnt/utm",
        claudePath: "/home/yueyuan/.local/bin/claude",
      },
    });
  });

  it("rejects unsafe hosts and non-absolute roots", () => {
    expect(
      parseRemoteExecutorConfig({
        host: "-oProxyCommand=bad",
        localRoot: "relative",
        remoteRoot: "/mnt/utm",
      }).error,
    ).toContain("Invalid remote executor host");
    expect(
      parseRemoteExecutorConfig({
        host: "utm",
        localRoot: "/local",
        remoteRoot: "relative",
      }).error,
    ).toContain("absolute POSIX path");
  });

  it("rejects duplicate hosts", () => {
    const item = {
      host: "utm",
      localRoot: "/local",
      remoteRoot: "/remote",
    };
    expect(parseRemoteExecutorConfigs([item, item]).error).toContain(
      "configured more than once",
    );
  });

  it("normalizes a shared session store that maps to one physical directory", () => {
    expect(
      parseRemoteExecutorConfig({
        host: "utm",
        localRoot: "/Users/me/UTM/",
        remoteRoot: "/mnt/utm/",
        sessionStorage: {
          mode: "shared",
          localProjectsDir: "/Users/me/UTM/claude/projects/",
          remoteProjectsDir: "/mnt/utm/claude/projects/",
        },
      }),
    ).toEqual({
      executor: {
        host: "utm",
        localRoot: "/Users/me/UTM",
        remoteRoot: "/mnt/utm",
        sessionStorage: {
          mode: "shared",
          localProjectsDir: "/Users/me/UTM/claude/projects",
          remoteProjectsDir: "/mnt/utm/claude/projects",
        },
      },
    });
  });

  it("rejects mismatched shared stores and shared CLAUDE_CONFIG_DIR", () => {
    const base = {
      host: "utm",
      localRoot: "/local",
      remoteRoot: "/remote",
      sessionStorage: {
        mode: "shared",
        localProjectsDir: "/local/claude/projects",
        remoteProjectsDir: "/remote/wrong/projects",
      },
    };
    expect(parseRemoteExecutorConfig(base).error).toContain("same mapped path");
    expect(
      parseRemoteExecutorConfig({
        ...base,
        remoteClaudeConfigDir: "/home/me/.claude",
        sessionStorage: {
          ...base.sessionStorage,
          remoteProjectsDir: "/remote/claude/projects",
        },
      }).error,
    ).toContain("cannot set remoteClaudeConfigDir");
  });

  it("rejects two executors claiming the same shared local store", () => {
    const storage = {
      mode: "shared",
      localProjectsDir: "/local/claude/projects",
      remoteProjectsDir: "/remote/claude/projects",
    };
    expect(
      parseRemoteExecutorConfigs([
        {
          host: "utm-a",
          localRoot: "/local",
          remoteRoot: "/remote",
          sessionStorage: storage,
        },
        {
          host: "utm-b",
          localRoot: "/local",
          remoteRoot: "/remote",
          sessionStorage: storage,
        },
      ]).error,
    ).toContain("configured more than once");
  });
});
