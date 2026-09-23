import { describe, expect, it } from "vitest";
import {
  renderSafeInlineMarkdown,
  renderSafeMarkdown,
} from "../../src/augments/safe-markdown.js";

describe("markdown content preservation", () => {
  it.each([
    "docs/reports/2026-09-22_v1.0.142_launch_online_acceptance.md",
    "./docs/验收报告.md",
    "../reports/report.md",
    "README.md",
    "Dockerfile",
  ])(
    "renders %s as a local file link with its complete original source",
    (path) => {
      const html = renderSafeMarkdown(`[完整验收记录](${path})`);
      expect(html).toContain('class="local-file-link"');
      expect(html).toContain(`data-file-path="${path}"`);
      expect(html).toContain(`title="${path}"`);
      expect(html).toContain(`>[完整验收记录](${path})</a>`);
    },
  );

  it("decodes escaped spaces and preserves file line/column targets", () => {
    const html = renderSafeMarkdown("[源文件](src/my%20file.ts:12:3)");
    expect(html).toContain('data-file-path="src/my file.ts"');
    expect(html).toContain('data-line="12"');
    expect(html).toContain('data-column="3"');
    expect(html).toContain(">[源文件](src/my%20file.ts:12:3)</a>");
  });

  it("keeps link label markup, destination and title visible without nested formatting", () => {
    const source = '[**报告**](https://example.com/a_b?x=1&y=2 "报告标题")';
    const html = renderSafeMarkdown(source);
    expect(html).toBe(
      '<p><a href="https://example.com/a_b?x=1&amp;y=2" title="报告标题">[**报告**](https://example.com/a_b?x=1&amp;y=2 "报告标题")</a></p>',
    );
    expect(renderSafeInlineMarkdown(source)).toBe(html.slice(3, -4));
  });

  it("preserves supported reference-link source and its destination", () => {
    const html = renderSafeMarkdown(
      '[报告][ref]\n\n[ref]: https://example.com/report "原始标题"',
    );
    expect(html).toContain(
      '>[报告][ref] (https://example.com/report "原始标题")</a>',
    );
  });

  it("keeps the original source visible for clickable media links", () => {
    const source = "[**截图**](/tmp/screen.png)";
    const html = renderSafeMarkdown(source);
    expect(html).toContain('class="local-media-link"');
    expect(html).toContain(`>${source}<span`);
    expect(html).not.toContain("<strong>");
  });

  it.each([
    '[**链接**](custom:open/report.md "原始标题")',
    "[链接](javascript:alert(1))",
    "[链接](javascript:report.md)",
    "[链接](//example.com/report.md)",
    "[链接](#report)",
    "[链接](docs/report.md#summary)",
    "[链接](unknown-destination)",
    "![图片](custom:image.png)",
    "![图片](/tmp/unknown.bin)",
    "![图片](data:image/png;base64,abc)",
  ])("keeps unsupported markup visible: %s", (markdown) => {
    expect(renderSafeMarkdown(markdown)).toBe(`<p>${markdown}</p>`);
    expect(renderSafeInlineMarkdown(markdown)).toBe(markdown);
  });

  it("escapes HTML inside an unsupported link instead of executing it", () => {
    const html = renderSafeMarkdown(
      '[<img src=x onerror=alert(1)>](custom:report.md "<script>")',
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<a ");
    expect(html).toContain("&lt;img");
    expect(html).toContain("custom:report.md");
  });

  it("preserves the destination of unsupported reference-style links", () => {
    const html = renderSafeMarkdown(
      '[报告][ref]\n\n[ref]: custom:report.md "原始标题"',
    );
    expect(html).toBe('<p>[报告][ref] (custom:report.md "原始标题")</p>');
    expect(html).not.toContain("href=");
  });

  it("keeps relative image destinations available through the file viewer", () => {
    const html = renderSafeMarkdown("![截图](assets/screenshot.png)");
    expect(html).toContain('data-file-path="assets/screenshot.png"');
    expect(html).toContain(">![截图](assets/screenshot.png)</a>");
  });

  it("preserves a caller's scoped image resolver", () => {
    expect(
      renderSafeMarkdown("![截图](assets/screenshot.png)", {
        resolveImageUrl: () => "/api/reports/report-1/image",
      }),
    ).toBe('<p><img src="/api/reports/report-1/image" alt="截图" /></p>');
  });

  it("keeps HTTP and absolute local links clickable", () => {
    const html = renderSafeMarkdown(
      "[Run](https://example.com/runs/10577) [报告](/tmp/report.md)",
    );
    expect(html).toContain('href="https://example.com/runs/10577"');
    expect(html).toContain('data-file-path="/tmp/report.md"');
    expect(html).toContain(">[Run](https://example.com/runs/10577)</a>");
    expect(html).toContain(">[报告](/tmp/report.md)</a>");
  });
});
