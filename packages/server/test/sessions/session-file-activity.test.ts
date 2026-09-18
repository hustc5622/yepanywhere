import { describe, expect, it } from "vitest";
import { buildSessionFileActivity } from "../../src/sessions/session-file-activity.js";
import type { Message } from "../../src/supervisor/types.js";

function assistant(uuid: string, tools: unknown[]): Message {
  return {
    uuid,
    type: "assistant",
    message: { role: "assistant", content: tools },
  } as unknown as Message;
}

function toolUse(name: string, input: unknown, id = `${name}-1`) {
  return { type: "tool_use", id, name, input };
}

function userPrompt(uuid: string, text: string): Message {
  return {
    uuid,
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  } as unknown as Message;
}

describe("buildSessionFileActivity", () => {
  it("indexes tool paths across the whole session and relativizes them", () => {
    const { files } = buildSessionFileActivity(
      [
        userPrompt("q1", "do it"),
        assistant("a1", [toolUse("Read", { file_path: "/repo/src/a.ts" })]),
        assistant("a2", [toolUse("Edit", { file_path: "src/a.ts" })]),
      ],
      { projectPath: "/repo" },
    );

    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      path: "src/a.ts",
      kind: "modified",
      count: 2,
      tools: ["Read", "Edit"],
      confidence: "high",
      messageId: "q1",
    });
  });

  it("recovers shell writes that no tool input declares", () => {
    const { files } = buildSessionFileActivity(
      [
        userPrompt("q1", "go"),
        assistant("a1", [
          toolUse("Bash", { command: "sed -i '' 's/a/b/' docs/README.md" }),
        ]),
      ],
      { projectPath: "/repo" },
    );

    expect(files).toEqual([
      expect.objectContaining({
        path: "docs/README.md",
        kind: "modified",
        source: "shell",
        confidence: "low",
      }),
    ]);
  });

  it("upgrades confidence when a structured tool later touches the same file", () => {
    const { files } = buildSessionFileActivity(
      [
        assistant("a1", [toolUse("Bash", { command: "echo x > out.md" })]),
        assistant("a2", [toolUse("Write", { file_path: "out.md" })]),
      ],
      { projectPath: "/repo" },
    );

    expect(files[0]).toMatchObject({
      path: "out.md",
      source: "tool",
      confidence: "high",
      count: 2,
    });
  });

  it("caps the number of distinct files and reports truncation", () => {
    const messages = Array.from({ length: 5 }, (_, index) =>
      assistant(`a${index}`, [
        toolUse("Read", { file_path: `src/f${index}.ts` }, `t${index}`),
      ]),
    );
    const { files, truncated } = buildSessionFileActivity(messages, {
      projectPath: "/repo",
      maxFiles: 3,
    });

    expect(files).toHaveLength(3);
    expect(truncated).toBe(true);
  });

  it("marks paths outside the project", () => {
    const { files } = buildSessionFileActivity(
      [assistant("a1", [toolUse("Read", { file_path: "/tmp/scratch.txt" })])],
      { projectPath: "/repo" },
    );

    expect(files[0]).toMatchObject({
      path: "/tmp/scratch.txt",
      outsideProject: true,
    });
  });
});
