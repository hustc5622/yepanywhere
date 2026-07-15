import { describe, expect, it } from "vitest";
import {
  normalizeWrappingTextFence,
  renderMarkdownToHtml,
} from "../../src/augments/markdown-augments.js";

describe("normalizeWrappingTextFence", () => {
  it("repairs a text wrapper containing nested fenced examples", () => {
    const markdown = [
      "Copy this prompt:",
      "",
      "```text",
      "Read the implementation:",
      "",
      "```ts",
      "const ready = true",
      "```",
      "",
      "Then run:",
      "",
      "```bash",
      "pnpm test",
      "```",
      "```",
    ].join("\n");

    expect(normalizeWrappingTextFence(markdown)).toBe(
      markdown.replace("```text", "````text").replace(/```$/, "````"),
    );
  });

  it("renders a repaired prompt as one continuous code box", async () => {
    const markdown = [
      "Copy this prompt:",
      "",
      "```text",
      "Read the implementation:",
      "```ts",
      "const ready = true",
      "```",
      "Continue after the example.",
      "```",
    ].join("\n");

    const html = await renderMarkdownToHtml(markdown);

    expect(html.match(/<pre\b/g)).toHaveLength(1);
    expect(html).toContain("```ts");
    expect(html).toContain("Continue after the example.");
  });

  it("leaves ordinary adjacent code blocks unchanged", () => {
    const markdown = [
      "```text",
      "plain output",
      "```",
      "",
      "```ts",
      "const ready = true",
      "```",
    ].join("\n");

    expect(normalizeWrappingTextFence(markdown)).toBe(markdown);
  });

  it("uses a fence longer than any nested fence", () => {
    const markdown = [
      "~~~markdown",
      "~~~~ts",
      "const ready = true",
      "~~~~",
      "~~~",
    ].join("\n");

    expect(normalizeWrappingTextFence(markdown)).toBe(
      ["~~~~~markdown", "~~~~ts", "const ready = true", "~~~~", "~~~~~"].join(
        "\n",
      ),
    );
  });

  it.each([
    ["four-space", "    "],
    ["tab", "\t"],
  ])("leaves %s-indented literal fences unchanged", (_label, indent) => {
    const markdown = [
      `${indent}\`\`\`text`,
      `${indent}\`\`\`ts`,
      `${indent}const ready = true`,
      `${indent}\`\`\``,
      `${indent}\`\`\``,
    ].join("\n");

    expect(normalizeWrappingTextFence(markdown)).toBe(markdown);
  });

  it.each([
    ["four-space", "    "],
    ["tab", "\t"],
  ])(
    "does not treat a %s-indented interior literal as a nested fence",
    (_label, indent) => {
      const markdown = [
        "```text",
        `${indent}\`\`\`ts`,
        `${indent}const ready = true`,
        `${indent}\`\`\``,
        "```",
      ].join("\n");

      expect(normalizeWrappingTextFence(markdown)).toBe(markdown);
    },
  );
});
