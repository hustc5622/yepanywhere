import { describe, expect, it } from "vitest";
import { delimiterForPath, parseDelimitedText } from "../delimitedText";

describe("parseDelimitedText", () => {
  it("handles quotes, escaped quotes, embedded newlines and CRLF", () => {
    expect(
      parseDelimitedText('a,"b,c","say ""hi"""\r\n1,"two\nlines",3\n', ","),
    ).toEqual({
      rows: [
        ["a", "b,c", 'say "hi"'],
        ["1", "two\nlines", "3"],
      ],
      truncated: false,
    });
  });

  it("parses TSV and stops at the row limit", () => {
    expect(parseDelimitedText("a\tb\nc\td\ne\tf", "\t", 2)).toEqual({
      rows: [
        ["a", "b"],
        ["c", "d"],
      ],
      truncated: true,
    });
  });

  it("maps extensions to delimiters", () => {
    expect(delimiterForPath("/x/data.CSV")).toBe(",");
    expect(delimiterForPath("x.tsv")).toBe("\t");
    expect(delimiterForPath("x.txt")).toBeNull();
  });
});
