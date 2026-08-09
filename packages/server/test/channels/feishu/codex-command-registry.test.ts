import { describe, expect, it } from "vitest";
import {
  CODEX_REMOTE_COMMAND_CAPABILITIES,
  getCodexRemoteCommandCapability,
} from "../../../src/channels/feishu/codex-command-registry.js";

const PINNED_CODEX_COMMANDS = [
  "model",
  "ide",
  "permissions",
  "keymap",
  "vim",
  "setup-default-sandbox",
  "sandbox-add-read-dir",
  "experimental",
  "approve",
  "memories",
  "skills",
  "import",
  "hooks",
  "review",
  "rename",
  "new",
  "archive",
  "delete",
  "resume",
  "fork",
  "app",
  "init",
  "compact",
  "plan",
  "goal",
  "agent",
  "side",
  "btw",
  "copy",
  "export",
  "raw",
  "diff",
  "mention",
  "status",
  "usage",
  "debug-config",
  "title",
  "statusline",
  "theme",
  "pets",
  "mcp",
  "apps",
  "plugins",
  "logout",
  "quit",
  "exit",
  "feedback",
  "rollout",
  "ps",
  "stop",
  "clear",
  "personality",
  "test-approval",
  "subagents",
  "debug-m-drop",
  "debug-m-update",
] as const;

describe("Codex remote command capability registry", () => {
  it("classifies every command in the pinned SlashCommand enum", () => {
    expect(
      CODEX_REMOTE_COMMAND_CAPABILITIES.map((entry) => entry.command),
    ).toEqual(PINNED_CODEX_COMMANDS);
    expect(new Set(PINNED_CODEX_COMMANDS).size).toBe(
      PINNED_CODEX_COMMANDS.length,
    );
    for (const entry of CODEX_REMOTE_COMMAND_CAPABILITIES) {
      if (
        entry.yep === "blocked-with-reason" ||
        entry.feishu === "blocked-with-reason" ||
        entry.yep === "not-applicable" ||
        entry.feishu === "not-applicable"
      ) {
        expect(entry.reasonCode, entry.command).toBeTruthy();
      }
    }
  });

  it("resolves canonical commands and source aliases", () => {
    expect(getCodexRemoteCommandCapability("/new")?.feishu).toBe("implemented");
    expect(getCodexRemoteCommandCapability("clean")?.command).toBe("stop");
    expect(getCodexRemoteCommandCapability("pet")?.command).toBe("pets");
    expect(getCodexRemoteCommandCapability("unknown")).toBeUndefined();
  });

  it("only marks the implemented Feishu Codex controls as available", () => {
    for (const command of ["skills", "review", "compact", "goal"]) {
      expect(getCodexRemoteCommandCapability(command)?.feishu).toBe(
        "implemented",
      );
    }
    expect(getCodexRemoteCommandCapability("diff")).toMatchObject({
      feishu: "equivalent",
      reasonCode: "RICH_DIFF_PROJECTION",
    });
    for (const command of ["ps", "stop"]) {
      expect(getCodexRemoteCommandCapability(command)).toMatchObject({
        feishu: "blocked-with-reason",
        reasonCode: expect.any(String),
      });
    }
  });

  it("records the structured Skills picker in Yep and Feishu", () => {
    expect(getCodexRemoteCommandCapability("skills")).toMatchObject({
      yep: "implemented",
      feishu: "implemented",
    });
  });

  it("exposes canonical export in Yep without overclaiming a Feishu upload flow", () => {
    expect(getCodexRemoteCommandCapability("export")).toMatchObject({
      yep: "implemented",
      feishu: "blocked-with-reason",
      reasonCode: "FEISHU_EXPORT_UPLOAD_PENDING",
    });
  });

  it("records implemented source forks without claiming a Feishu command", () => {
    expect(getCodexRemoteCommandCapability("fork")).toMatchObject({
      yep: "equivalent",
      feishu: "blocked-with-reason",
      reasonCode: "FEISHU_SOURCE_FORK_COMMAND_PENDING",
    });
  });
});
