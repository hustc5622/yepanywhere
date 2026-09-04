import { describe, expect, it } from "vitest";
import {
  createBareUrlPattern,
  createLinkPattern,
  splitTrailingUrlPunctuation,
  trimUrlTrailingPunctuation,
} from "../autolink";

function matchBareUrls(text: string): string[] {
  return [...text.matchAll(createBareUrlPattern())].map((match) => match[0]);
}

describe("autolink", () => {
  it("ends a bare URL at CJK and full-width punctuation", () => {
    expect(
      matchBareUrls(
        "线上域名是 https://api-testing.xaminim.com/，完成上线验收",
      ),
    ).toEqual(["https://api-testing.xaminim.com/"]);
    expect(
      matchBareUrls("见 https://example.test/a、https://example.test/b。"),
    ).toEqual(["https://example.test/a", "https://example.test/b"]);
    expect(matchBareUrls("（https://example.test/c）")).toEqual([
      "https://example.test/c",
    ]);
    expect(matchBareUrls("文档https://example.test/d紧贴中文")).toEqual([
      "https://example.test/d",
    ]);
  });

  it("keeps ASCII URL syntax intact", () => {
    expect(matchBareUrls("https://example.test/a?b=1&c=2#frag next")).toEqual([
      "https://example.test/a?b=1&c=2#frag",
    ]);
    expect(matchBareUrls("<https://example.test/e>")).toEqual([
      "https://example.test/e",
    ]);
  });

  it("trims sentence punctuation but preserves balanced brackets", () => {
    expect(trimUrlTrailingPunctuation("https://example.test/a.")).toBe(
      "https://example.test/a",
    );
    expect(trimUrlTrailingPunctuation("https://example.test/a?!")).toBe(
      "https://example.test/a",
    );
    expect(trimUrlTrailingPunctuation("https://example.test/b)")).toBe(
      "https://example.test/b",
    );
    expect(
      trimUrlTrailingPunctuation("https://en.wikipedia.org/wiki/Foo_(bar)"),
    ).toBe("https://en.wikipedia.org/wiki/Foo_(bar)");
    expect(splitTrailingUrlPunctuation("https://example.test/c'.")).toEqual([
      "https://example.test/c",
      "'.",
    ]);
  });

  it("captures Markdown links before bare URLs", () => {
    const text =
      "见 [文档](https://example.test/doc) 与 https://example.test/raw";
    const matches = [...text.matchAll(createLinkPattern())];
    expect(matches.map((match) => [match[1], match[2], match[3]])).toEqual([
      ["文档", "https://example.test/doc", undefined],
      [undefined, undefined, "https://example.test/raw"],
    ]);
  });
});
