import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const layoutCss = readFileSync(
  resolve(process.cwd(), "src/styles/index.css"),
  "utf8",
);
const rendererCss = readFileSync(
  resolve(process.cwd(), "src/styles/renderers.css"),
  "utf8",
);

describe("mobile transcript horizontal overflow", () => {
  it("keeps the vertically scrolling transcript from becoming a horizontal scroller", () => {
    expect(layoutCss).toMatch(
      /\.session-messages\s*\{[^}]*overflow-y:\s*auto;[^}]*overflow-x:\s*hidden;[^}]*overscroll-behavior-x:\s*none;/s,
    );
  });

  it("keeps wide diffs scrollable inside their own renderer", () => {
    expect(rendererCss).toMatch(
      /\.diff-content\s*\{[^}]*overflow-x:\s*auto;[^}]*overscroll-behavior-x:\s*contain;[^}]*max-width:\s*100%;/s,
    );
    expect(rendererCss).toMatch(
      /\.highlighted-diff pre\.shiki\s*\{[^}]*overflow-x:\s*auto;[^}]*overscroll-behavior-x:\s*contain;[^}]*max-width:\s*100%;/s,
    );
  });

  it("soft-wraps long diff lines inside the right-hand detail panel", () => {
    expect(rendererCss).toMatch(
      /\.detail-panel \.diff-modal-content \.highlighted-diff code\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/s,
    );
    expect(rendererCss).toMatch(
      /\.detail-panel \.diff-modal-content \.highlighted-diff \.line\s*\{[^}]*white-space:\s*pre-wrap;[^}]*overflow-wrap:\s*anywhere;[^}]*word-break:\s*break-word;/s,
    );
    expect(rendererCss).toMatch(
      /\.detail-panel \.diff-modal-content \.diff-content > div,[^{]*\{[^}]*white-space:\s*pre-wrap;[^}]*overflow-wrap:\s*anywhere;/s,
    );
  });

  it("reflows file source lines as the docked detail panel is resized", () => {
    expect(rendererCss).toMatch(
      /\.detail-panel-host--docked \.file-viewer-code\s*\{[^}]*max-width:\s*100%;[^}]*overflow-x:\s*hidden;/s,
    );
    expect(rendererCss).toMatch(
      /\.detail-panel-host--docked[^{]*\.file-viewer-code-highlighted[^{]*\.shiki-container[^{]*pre\.shiki\s*\{[^}]*width:\s*100%;[^}]*overflow-x:\s*hidden;[^}]*white-space:\s*pre-wrap;[^}]*overflow-wrap:\s*anywhere;[^}]*word-break:\s*break-word;/s,
    );
    expect(rendererCss).toMatch(
      /\.detail-panel-host--docked \.code-highlighter-plain \.code-content code\s*\{[^}]*white-space:\s*pre-wrap;[^}]*overflow-wrap:\s*anywhere;[^}]*word-break:\s*break-word;/s,
    );
  });
});
