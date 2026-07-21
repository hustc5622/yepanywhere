import type { ReportComment } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import {
  applyReportCommentHighlights,
  clearReportCommentHighlights,
  createReportCommentAnchor,
  resolveReportCommentAnchor,
} from "../reportComments";

function makeComment(overrides: Partial<ReportComment> = {}): ReportComment {
  return {
    id: "comment-1",
    reportPath: "report.md",
    anchor: {
      exact: "beta",
      prefix: "Alpha ",
      suffix: " gamma",
      start: 6,
      end: 10,
    },
    body: "Review this wording",
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: "2026-07-21T00:00:00.000Z",
    ...overrides,
  };
}

describe("report comment text anchors", () => {
  it("creates an anchor from rendered DOM text", () => {
    const article = document.createElement("article");
    article.innerHTML = "<p>Alpha <strong>beta</strong> gamma</p>";
    const text = article.querySelector("strong")?.firstChild;
    expect(text).not.toBeNull();

    const range = document.createRange();
    range.setStart(text as Text, 0);
    range.setEnd(text as Text, 4);

    expect(createReportCommentAnchor(article, range)).toEqual({
      exact: "beta",
      prefix: "Alpha ",
      suffix: " gamma",
      start: 6,
      end: 10,
    });
  });

  it("uses surrounding text to recover after nearby edits", () => {
    const text = "Intro added. Alpha beta gamma and then beta elsewhere.";
    expect(resolveReportCommentAnchor(text, makeComment().anchor)).toEqual({
      start: 19,
      end: 23,
    });
  });

  it("does not guess when duplicate text has no distinguishing context", () => {
    expect(
      resolveReportCommentAnchor("beta and beta", {
        exact: "beta",
        prefix: "",
        suffix: "",
        start: 99,
        end: 103,
      }),
    ).toBeNull();
  });

  it("injects clickable underlines while preserving inline markup", () => {
    const article = document.createElement("article");
    article.innerHTML = "<p>Alpha <strong>beta</strong> gamma</p>";

    const resolved = applyReportCommentHighlights(
      article,
      [makeComment()],
      "Open comment",
    );
    const highlight = article.querySelector<HTMLElement>(
      ".report-comment-highlight",
    );

    expect(resolved.get("comment-1")).toEqual({ start: 6, end: 10 });
    expect(highlight?.textContent).toBe("beta");
    expect(highlight?.dataset.reportCommentIds).toBe("comment-1");
    expect(highlight?.getAttribute("aria-label")).toBe("Open comment");
    expect(article.querySelector("strong")?.contains(highlight ?? null)).toBe(
      true,
    );

    clearReportCommentHighlights(article);
    expect(article.textContent).toBe("Alpha beta gamma");
    expect(article.querySelector("strong")?.textContent).toBe("beta");
  });
});
