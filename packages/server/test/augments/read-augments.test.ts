import { describe, expect, it } from "vitest";
import { computeReadAugment } from "../../src/augments/read-augments.js";

describe("computeReadAugment", () => {
  it("sanitizes markdown preview HTML and blocks unsafe links", async () => {
    const result = await computeReadAugment({
      file_path: "README.md",
      content: [
        "   1\t# Title",
        "   2\t<script>alert('xss')</script>",
        "   3\t[good](https://example.com)",
        "   4\t[bad](javascript:alert(1))",
      ].join("\n"),
    });

    expect(result).not.toBeNull();
    expect(result?.renderedMarkdownHtml).toBeDefined();

    const rendered = result?.renderedMarkdownHtml ?? "";
    expect(rendered).not.toContain("<script>");
    expect(rendered).toContain("&lt;script&gt;");
    expect(rendered).toContain(
      '<a href="https://example.com">[good](https://example.com)</a>',
    );
    expect(rendered).toContain("[bad](javascript:alert(1))");
    expect(rendered).not.toContain('href="javascript:alert(1)"');
  });
});
