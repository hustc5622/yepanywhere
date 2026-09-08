import { describe, expect, it } from "vitest";
import { createAugmentGenerator } from "../../src/augments/augment-generator.js";
import { BlockDetector } from "../../src/augments/block-detector.js";
import { renderMarkdownToHtml } from "../../src/augments/markdown-augments.js";
import { renderSafeMarkdown } from "../../src/augments/safe-markdown.js";

const comparison = [
  "工程上还会使用 **KV Cache**。[缓存说明](https://example.com/cache)",
  "",
  "以同一个模型为例：",
  "",
  "| 比较项 | 思维链与正式回答的关系 |",
  "|---|---|",
  "| 使用的词表 | 通常相同 |",
  "| 生成内容的模型参数 | 通常相同 |",
  "| 下一个 token 的生成机制 | 通常相同 |",
  "| 内容的用途 | 前者保存中间步骤，后者向用户交付答案 |",
  "| 区分方式 | 可以通过边界标记、通道或消息格式区分 |",
  "",
  "- **token ID 相同**：相当于同一个字。",
].join("\n");

it("keeps streamed table rows together across arbitrary token boundaries", async () => {
  const detector = new BlockDetector();
  const generator = await createAugmentGenerator({ languages: [] });
  const blocks = [];
  for (let offset = 0; offset < comparison.length; offset += 7) {
    blocks.push(...detector.feed(comparison.slice(offset, offset + 7)));
  }
  blocks.push(...detector.flush());
  const augments = await Promise.all(
    blocks.map((block, index) => generator.processBlock(block, index)),
  );
  const html = augments.map((augment) => augment.html).join("\n");
  expect(html).toBe(await renderMarkdownToHtml(comparison));
  expect(html.match(/<table>/g)).toHaveLength(1);
  expect(html.match(/<tr>/g)).toHaveLength(6);
});

describe.each([
  ["display snapshots", renderSafeMarkdown],
  ["persisted markdown augments", renderMarkdownToHtml],
] as const)("Markdown tables in %s", (_name, render) => {
  it("renders the screenshot's comparison with inline formatting and a scroll container", async () => {
    const html = await render(comparison);
    expect(html).toContain(
      '<div class="markdown-table-wrapper" tabindex="0"><table>',
    );
    expect(html).toContain("<th>比较项</th>");
    expect(html).toContain("<th>思维链与正式回答的关系</th>");
    expect(html.match(/<tr>/g)).toHaveLength(6);
    expect(html).toContain("<td>前者保存中间步骤，后者向用户交付答案</td>");
    expect(html).toContain("<strong>KV Cache</strong>");
    expect(html).toContain('<a href="https://example.com/cache">缓存说明</a>');
    expect(html).toContain("<strong>token ID 相同</strong>");
  });

  it("preserves alignment, escaped pipes and safe inline content in cells", async () => {
    const html = await render(
      [
        "| 左 | 中 | 右 |",
        "| :--- | :---: | ---: |",
        "| a\\|b | **粗体** | `42` |",
        "| [安全](https://example.com) | [危险](javascript:alert%281%29) | <img src=x onerror=alert(1)> |",
      ].join("\n"),
    );
    expect(html).toContain('<td align="left">a|b</td>');
    expect(html).toContain('<td align="center"><strong>粗体</strong></td>');
    expect(html).toContain('<td align="right"><code>42</code></td>');
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain("<img");
  });

  it("leaves table examples in fenced code as literal text", async () => {
    const html = await render("```text\n| A | B |\n|---|---|\n| 1 | 2 |\n```");
    expect(html).toContain("<pre");
    expect(html).not.toContain("<table>");
    expect(html).not.toContain("markdown-table-wrapper");
  });
});
