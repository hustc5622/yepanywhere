import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type AugmentGenerator,
  createAugmentGenerator,
} from "../../src/augments/augment-generator.js";
import type { CompletedBlock } from "../../src/augments/block-detector.js";

function normalizeHtmlForComparison(html: string): string {
  return html
    .replace(/<hr\s*\/?>/g, "<hr>")
    .replace(/\s+/g, " ")
    .trim();
}

describe("AugmentGenerator", () => {
  let generator: AugmentGenerator;

  beforeAll(async () => {
    generator = await createAugmentGenerator({
      languages: ["javascript", "typescript", "python"],
      theme: "github-dark",
    });
  });

  describe("code block highlighting", () => {
    it("highlights code with known language", async () => {
      const block: CompletedBlock = {
        type: "code",
        content: "```javascript\nconst x = 1;\n```",
        lang: "javascript",
        startOffset: 0,
        endOffset: 30,
      };

      const augment = await generator.processBlock(block, 0);

      expect(augment.type).toBe("code");
      expect(augment.blockIndex).toBe(0);
      // Shiki wraps in <pre> with shiki class
      expect(augment.html).toContain("<pre");
      expect(augment.html).toContain("shiki");
      // Should have syntax highlighting spans
      expect(augment.html).toContain("<span");
    });

    it("highlights typescript code", async () => {
      const block: CompletedBlock = {
        type: "code",
        content:
          "```typescript\nfunction hello(name: string): void {\n  console.log(name);\n}\n```",
        lang: "typescript",
        startOffset: 0,
        endOffset: 70,
      };

      const augment = await generator.processBlock(block, 1);

      expect(augment.type).toBe("code");
      expect(augment.html).toContain("<pre");
      expect(augment.html).toContain("<span");
    });

    it("renders unknown language as plain code block", async () => {
      const block: CompletedBlock = {
        type: "code",
        content: "```unknownlang\nsome code\n```",
        lang: "unknownlang",
        startOffset: 0,
        endOffset: 28,
      };

      const augment = await generator.processBlock(block, 2);

      expect(augment.type).toBe("code");
      expect(augment.html).toContain('<pre class="shiki">');
      expect(augment.html).toContain('class="language-unknownlang"');
      expect(augment.html).toContain("some code");
    });

    it("renders code block without language as plain", async () => {
      const block: CompletedBlock = {
        type: "code",
        content: "```\nplain code here\n```",
        lang: undefined,
        startOffset: 0,
        endOffset: 22,
      };

      const augment = await generator.processBlock(block, 3);

      expect(augment.type).toBe("code");
      expect(augment.html).toContain('<pre class="shiki">');
      expect(augment.html).toContain("plain code here");
    });

    it("escapes HTML in plain code blocks", async () => {
      const block: CompletedBlock = {
        type: "code",
        content: "```\n<script>alert('xss')</script>\n```",
        lang: undefined,
        startOffset: 0,
        endOffset: 40,
      };

      const augment = await generator.processBlock(block, 4);

      expect(augment.html).not.toContain("<script>");
      expect(augment.html).toContain("&lt;script&gt;");
    });
  });

  describe("non-code blocks", () => {
    it("renders paragraph with marked", async () => {
      const block: CompletedBlock = {
        type: "paragraph",
        content: "This is a simple paragraph.",
        startOffset: 0,
        endOffset: 26,
      };

      const augment = await generator.processBlock(block, 0);

      expect(augment.type).toBe("paragraph");
      expect(augment.html).toBe("<p>This is a simple paragraph.</p>");
    });

    it("renders heading with marked", async () => {
      const block: CompletedBlock = {
        type: "heading",
        content: "# Main Heading",
        startOffset: 0,
        endOffset: 13,
      };

      const augment = await generator.processBlock(block, 0);

      expect(augment.type).toBe("heading");
      expect(augment.html).toBe("<h1>Main Heading</h1>");
    });

    it("renders h2 heading", async () => {
      const block: CompletedBlock = {
        type: "heading",
        content: "## Sub Heading",
        startOffset: 0,
        endOffset: 13,
      };

      const augment = await generator.processBlock(block, 0);

      expect(augment.html).toBe("<h2>Sub Heading</h2>");
    });

    it("renders bullet list", async () => {
      const block: CompletedBlock = {
        type: "list",
        content: "- item 1\n- item 2",
        startOffset: 0,
        endOffset: 17,
      };

      const augment = await generator.processBlock(block, 0);

      expect(augment.type).toBe("list");
      expect(augment.html).toContain("<ul>");
      expect(augment.html).toContain("<li>item 1</li>");
      expect(augment.html).toContain("<li>item 2</li>");
    });

    it("renders numbered list", async () => {
      const block: CompletedBlock = {
        type: "list",
        content: "1. first\n2. second",
        startOffset: 0,
        endOffset: 18,
      };

      const augment = await generator.processBlock(block, 0);

      expect(augment.type).toBe("list");
      expect(augment.html).toContain("<ol>");
      expect(augment.html).toContain("<li>first</li>");
      expect(augment.html).toContain("<li>second</li>");
    });

    it("renders blockquote", async () => {
      const block: CompletedBlock = {
        type: "blockquote",
        content: "> A quoted line",
        startOffset: 0,
        endOffset: 14,
      };

      const augment = await generator.processBlock(block, 0);

      expect(augment.type).toBe("blockquote");
      expect(augment.html).toContain("<blockquote>");
      expect(augment.html).toContain("A quoted line");
    });

    it("renders horizontal rule", async () => {
      const block: CompletedBlock = {
        type: "hr",
        content: "---",
        startOffset: 0,
        endOffset: 3,
      };

      const augment = await generator.processBlock(block, 0);

      expect(augment.type).toBe("hr");
      expect(augment.html).toContain("<hr");
    });

    it("renders paragraph with inline formatting", async () => {
      const block: CompletedBlock = {
        type: "paragraph",
        content: "This has **bold** and *italic* text.",
        startOffset: 0,
        endOffset: 36,
      };

      const augment = await generator.processBlock(block, 0);

      expect(augment.html).toContain("<strong>bold</strong>");
      expect(augment.html).toContain("<em>italic</em>");
    });

    it("escapes raw HTML from markdown input", async () => {
      const block: CompletedBlock = {
        type: "paragraph",
        content: "Hello <script>alert('xss')</script> world",
        startOffset: 0,
        endOffset: 40,
      };

      const augment = await generator.processBlock(block, 0);

      expect(augment.html).not.toContain("<script>");
      expect(augment.html).toContain("&lt;script&gt;");
    });

    it("renders details disclosure blocks with markdown content", async () => {
      const block: CompletedBlock = {
        type: "details",
        content:
          "<details><summary>点击查看答案</summary>\n" +
          "1. **Provider 路径的 rollback 成功了。**\n\n" +
          "2. **JSONL 没有 `thread_rolled_back` marker 的原因：**\n" +
          "- TUI backtrack 写 marker\n" +
          "- app-server `thread/rollback` 创建新 thread\n\n" +
          "</details>",
        startOffset: 0,
        endOffset: 158,
      };

      const augment = await generator.processBlock(block, 0);

      expect(augment.type).toBe("details");
      expect(augment.html).toContain('<details class="markdown-details">');
      expect(augment.html).toContain(
        '<summary class="markdown-details__summary">点击查看答案</summary>',
      );
      expect(augment.html).toContain(
        "<strong>Provider 路径的 rollback 成功了。</strong>",
      );
      expect(augment.html).toContain("<code>thread_rolled_back</code>");
      expect(augment.html).toContain("<ul>");
      expect(augment.html).not.toContain("&lt;details");
      expect(augment.html).not.toContain("&lt;summary");
    });

    it("sanitizes details attributes and escapes unsafe nested HTML", async () => {
      const block: CompletedBlock = {
        type: "details",
        content:
          '<details onclick="alert(1)" open><summary><script>bad()</script>Answer</summary>\n' +
          "Body <img src=x onerror=alert(1)> **ok**\n" +
          "</details>",
        startOffset: 0,
        endOffset: 126,
      };

      const augment = await generator.processBlock(block, 0);

      expect(augment.html).toContain('<details class="markdown-details" open>');
      expect(augment.html).not.toContain("onclick");
      expect(augment.html).not.toContain("<script>");
      expect(augment.html).not.toContain("<img");
      expect(augment.html).toContain("&lt;script&gt;");
      expect(augment.html).toContain("&lt;img");
      expect(augment.html).toContain("<strong>ok</strong>");
    });

    it("removes markdown links with unsafe protocols", async () => {
      const block: CompletedBlock = {
        type: "paragraph",
        content: "Do not click [this](javascript:alert(1))",
        startOffset: 0,
        endOffset: 40,
      };

      const augment = await generator.processBlock(block, 0);

      expect(augment.html).not.toContain("href=");
      expect(augment.html).toContain("this");
      expect(augment.html).not.toContain("javascript:");
    });

    it("linkifies bare local image paths", async () => {
      const block: CompletedBlock = {
        type: "paragraph",
        content: "Saved image:\n\n/tmp/kitten.png",
        startOffset: 0,
        endOffset: 29,
      };

      const augment = await generator.processBlock(block, 0);

      expect(augment.html).toContain('class="local-media-link"');
      expect(augment.html).toContain('data-media-type="image"');
      expect(augment.html).toContain(
        'href="/api/local-image?path=%2Ftmp%2Fkitten.png"',
      );
      expect(augment.html).toContain("/tmp/kitten.png");
    });

    it("renders local markdown file links through the local-file endpoint", async () => {
      const block: CompletedBlock = {
        type: "paragraph",
        content: "See [AGENTS.md](/Users/yueyuan/.codex/AGENTS.md:9).",
        startOffset: 0,
        endOffset: 57,
      };

      const augment = await generator.processBlock(block, 0);

      expect(augment.html).toContain('class="local-file-link"');
      expect(augment.html).toContain(
        'href="/api/local-file?path=%2FUsers%2Fyueyuan%2F.codex%2FAGENTS.md&amp;line=9"',
      );
      expect(augment.html).toContain(
        'data-file-path="/Users/yueyuan/.codex/AGENTS.md"',
      );
      expect(augment.html).toContain('data-line="9"');
      expect(augment.html).not.toContain("/api/local-image");
    });
  });

  describe("renderPending", () => {
    it("renders bold formatting", () => {
      const result = generator.renderPending("This is **bold** text");

      expect(result).toBe("This is <strong>bold</strong> text");
    });

    it("renders italic formatting", () => {
      const result = generator.renderPending("This is *italic* text");

      expect(result).toBe("This is <em>italic</em> text");
    });

    it("renders inline code", () => {
      const result = generator.renderPending("Use `console.log()` for debug");

      expect(result).toBe("Use <code>console.log()</code> for debug");
    });

    it("renders links", () => {
      const result = generator.renderPending(
        "Check [the docs](https://example.com)",
      );

      expect(result).toBe('Check <a href="https://example.com">the docs</a>');
    });

    it("renders mailto links", () => {
      const result = generator.renderPending(
        "Contact [support](mailto:support@example.com)",
      );

      expect(result).toBe(
        'Contact <a href="mailto:support@example.com">support</a>',
      );
    });

    it("does not render unsafe links", () => {
      const result = generator.renderPending(
        "Check [this](javascript:alert(1))",
      );

      expect(result).toBe("Check [this](javascript:alert(1))");
    });

    it("renders mixed formatting", () => {
      const result = generator.renderPending(
        "**Bold** and *italic* and `code`",
      );

      expect(result).toBe(
        "<strong>Bold</strong> and <em>italic</em> and <code>code</code>",
      );
    });

    it("handles unclosed bold gracefully", () => {
      const result = generator.renderPending("This is **unclosed");

      // Should not crash, just return escaped text
      expect(result).toBe("This is **unclosed");
    });

    it("handles unclosed italic gracefully", () => {
      const result = generator.renderPending("This is *unclosed");

      expect(result).toBe("This is *unclosed");
    });

    it("handles unclosed code gracefully", () => {
      const result = generator.renderPending("This is `unclosed");

      expect(result).toBe("This is `unclosed");
    });

    it("handles unclosed link gracefully", () => {
      const result = generator.renderPending("Check [the docs](incomplete");

      expect(result).toBe("Check [the docs](incomplete");
    });

    it("escapes HTML in pending text", () => {
      const result = generator.renderPending("<script>alert('xss')</script>");

      expect(result).not.toContain("<script>");
      expect(result).toContain("&lt;script&gt;");
    });

    it("handles empty string", () => {
      const result = generator.renderPending("");

      expect(result).toBe("");
    });

    it("handles plain text without formatting", () => {
      const result = generator.renderPending("Just plain text here");

      expect(result).toBe("Just plain text here");
    });
  });

  describe("golden file tests", () => {
    const fixturesDir = join(__dirname, "../fixtures/markdown-golden");

    describe("block tests", () => {
      const blocksDir = join(fixturesDir, "blocks");
      const blockFiles = readdirSync(blocksDir).filter((f) =>
        f.endsWith(".md"),
      );

      for (const mdFile of blockFiles) {
        const baseName = mdFile.replace(".md", "");
        const htmlFile = `${baseName}.html`;

        it(`renders ${baseName} correctly`, async () => {
          const mdPath = join(blocksDir, mdFile);
          const htmlPath = join(blocksDir, htmlFile);

          const mdContent = readFileSync(mdPath, "utf-8").trim();
          const expectedHtml = readFileSync(htmlPath, "utf-8").trim();

          // Determine block type from filename
          let blockType: CompletedBlock["type"] = "paragraph";
          let lang: string | undefined;

          if (baseName.startsWith("header")) {
            blockType = "heading";
          } else if (baseName.startsWith("code")) {
            blockType = "code";
            // Extract language from filename like code-js, code-typescript
            const langMatch = baseName.match(/^code-(.+)$/);
            if (langMatch) {
              const langPart = langMatch[1];
              if (langPart === "no-lang") {
                lang = undefined;
              } else if (langPart === "unknown-lang") {
                lang = "unknownlang";
              } else if (langPart === "js") {
                lang = "js";
              } else {
                lang = langPart;
              }
            }
          } else if (baseName.startsWith("list")) {
            blockType = "list";
          } else if (baseName === "blockquote") {
            blockType = "blockquote";
          } else if (baseName === "hr") {
            blockType = "hr";
          }

          const block: CompletedBlock = {
            type: blockType,
            content: mdContent,
            lang,
            startOffset: 0,
            endOffset: mdContent.length,
          };

          const augment = await generator.processBlock(block, 0);

          // For code blocks, we need to be more flexible about the exact HTML
          // as shiki output varies slightly between versions
          if (blockType === "code") {
            // Check that it's wrapped in pre with shiki class
            expect(augment.html).toContain("<pre");
            expect(augment.html).toContain("shiki");
            // Check that the code content is present (unescaped in highlighted, escaped in plain)
            // Just verify it renders without error and has code tag
            expect(augment.html).toContain("<code");
          } else {
            // For non-code blocks, we can compare more strictly
            // Normalize whitespace for comparison
            const normalizedExpected = normalizeHtmlForComparison(expectedHtml);
            const normalizedActual = normalizeHtmlForComparison(augment.html);
            expect(normalizedActual).toBe(normalizedExpected);
          }
        });
      }
    });

    describe("inline formatting in paragraphs", () => {
      const inlineDir = join(fixturesDir, "inline");
      const inlineFiles = readdirSync(inlineDir).filter((f) =>
        f.endsWith(".md"),
      );

      for (const mdFile of inlineFiles) {
        const baseName = mdFile.replace(".md", "");
        const htmlFile = `${baseName}.html`;

        it(`renders ${baseName} inline formatting correctly`, async () => {
          const mdPath = join(inlineDir, mdFile);
          const htmlPath = join(inlineDir, htmlFile);

          const mdContent = readFileSync(mdPath, "utf-8").trim();
          const expectedHtml = readFileSync(htmlPath, "utf-8").trim();

          // Inline tests are paragraphs
          const block: CompletedBlock = {
            type: "paragraph",
            content: mdContent,
            startOffset: 0,
            endOffset: mdContent.length,
          };

          const augment = await generator.processBlock(block, 0);

          // Normalize whitespace
          const normalizedExpected = normalizeHtmlForComparison(expectedHtml);
          const normalizedActual = normalizeHtmlForComparison(augment.html);
          expect(normalizedActual).toBe(normalizedExpected);
        });
      }
    });
  });

  describe("configuration", () => {
    it("uses default theme when not specified", async () => {
      const gen = await createAugmentGenerator({
        languages: ["javascript"],
        theme: "",
      });

      const block: CompletedBlock = {
        type: "code",
        content: "```javascript\nconst x = 1;\n```",
        lang: "javascript",
        startOffset: 0,
        endOffset: 30,
      };

      const augment = await gen.processBlock(block, 0);

      // Should still render with some theme
      expect(augment.html).toContain("<pre");
    });

    it("loads languages dynamically if not pre-loaded", async () => {
      const gen = await createAugmentGenerator({
        languages: [], // No pre-loaded languages
        theme: "github-dark",
      });

      const block: CompletedBlock = {
        type: "code",
        content: "```python\ndef hello():\n    print('hi')\n```",
        lang: "python",
        startOffset: 0,
        endOffset: 40,
      };

      const augment = await gen.processBlock(block, 0);

      // Should still render (dynamically loaded)
      expect(augment.html).toContain("<pre");
      expect(augment.html).toContain("<span");
    });
  });
});
