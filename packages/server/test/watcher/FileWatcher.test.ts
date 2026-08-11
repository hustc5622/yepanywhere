import { describe, expect, it } from "vitest";
import { EventBus } from "../../src/watcher/EventBus.js";
import { FileWatcher } from "../../src/watcher/FileWatcher.js";

function classifyKimiPath(relativePath: string): string {
  const watcher = new FileWatcher({
    watchDir: "/tmp/kimi-sessions",
    provider: "kimi",
    eventBus: new EventBus(),
  });
  return (
    watcher as unknown as {
      parseFileType(path: string): string;
    }
  ).parseFileType(relativePath);
}

describe("FileWatcher Kimi classification", () => {
  it.each([
    "wd_project/session_1/state.json",
    "wd_project/session_1/agents/main/wire.jsonl",
    "wd_project/session_1/agents/agent-0/wire.jsonl",
  ])("treats %s as a session change", (relativePath) => {
    expect(classifyKimiPath(relativePath)).toBe("session");
  });

  it("leaves unrelated Kimi files out of session invalidation", () => {
    expect(classifyKimiPath("wd_project/session_1/other.json")).toBe("other");
  });
});
