import { describe, expect, it } from "vitest";
import {
  buildAttachmentToken,
  countAttachmentTokens,
  deleteAttachmentTokenAtCaret,
  findAttachmentAfterPosition,
  findAttachmentTokens,
  hasAttachmentToken,
  insertAttachmentToken,
  matchTokenToAttachment,
  removeAttachmentToken,
  removeAttachmentTokenOccurrence,
  sanitizeAttachmentTokenName,
  splitByAttachmentTokens,
  stripAttachmentTokensForTitle,
} from "../attachmentTokens";

describe("attachmentTokens", () => {
  it("builds tokens and matches the server-side manifest label rules", () => {
    expect(buildAttachmentToken("shot.png")).toBe("@[shot.png]");
    expect(sanitizeAttachmentTokenName("a[b]c.png")).toBe("a_b_c.png");
    expect(sanitizeAttachmentTokenName("/tmp/dir/截图 1.png")).toBe(
      "截图 1.png",
    );
    expect(sanitizeAttachmentTokenName("a#b.png")).toBe("a_b.png");
  });

  it("finds only known tokens when names are provided", () => {
    const text = "see @[shot.png] and @[other.png]";
    expect(findAttachmentTokens(text).map((t) => t.name)).toEqual([
      "shot.png",
      "other.png",
    ]);
    expect(findAttachmentTokens(text, ["shot.png"]).map((t) => t.name)).toEqual(
      ["shot.png"],
    );
  });

  it("leaves a wider gap on both sides and puts subsequent typing after it", () => {
    const result = insertAttachmentToken("hello world", 5, "shot.png");
    expect(result.text).toBe("hello  @[shot.png]  world");
    expect(result.text.slice(0, result.cursor)).toBe("hello  @[shot.png]  ");
  });

  it.each([
    ["", 0, "@[a.png]  ", ""],
    ["hi", 2, "hi  @[a.png]  ", ""],
    ["hi ", 3, "hi  @[a.png]  ", ""],
    ["hi  ", 4, "hi  @[a.png]  ", ""],
    ["hi   ", 5, "hi   @[a.png]  ", ""],
    ["还有一个无法收尾的问题", 4, "还有一个  @[a.png]  ", "无法收尾的问题"],
    ["hi\n", 3, "hi\n@[a.png]  ", ""],
    ["hi\n ", 4, "hi\n @[a.png]  ", ""],
    ["hi\t", 3, "hi\t@[a.png]  ", ""],
    [" ", 1, " @[a.png]  ", ""],
    ["@[first.png]  ", 14, "@[first.png]  @[a.png]  ", ""],
    ["word", 0, "@[a.png]  ", "word"],
    ["  word", 0, "@[a.png]  ", "word"],
    ["   word", 0, "@[a.png]   ", "word"],
    ["\nword", 0, "@[a.png]", "\nword"],
    ["\tword", 0, "@[a.png]", "\tword"],
  ])(
    "preserves surrounding whitespace when inserting into %j",
    (text, cursor, prefix, suffix) => {
      const result = insertAttachmentToken(text, cursor, "a.png");
      expect(result.text).toBe(prefix + suffix);
      expect(result.text.slice(0, result.cursor)).toBe(prefix);
    },
  );

  it("removes the last matching token and collapses spacing", () => {
    expect(removeAttachmentToken("hello @[a.png] world", "a.png")).toBe(
      "hello world",
    );
    expect(removeAttachmentToken("@[a.png] @[a.png] x", "a.png")).toBe(
      "@[a.png] x",
    );
    expect(removeAttachmentToken("no token", "a.png")).toBe("no token");
  });

  it.each([
    [0, "first middle @[a.png] last @[a.png]", 6],
    [1, "first @[a.png] middle last @[a.png]", 22],
    [2, "first @[a.png] middle @[a.png] last", 35],
  ])(
    "removes only duplicate occurrence %i and returns the deletion point",
    (occurrence, text, cursor) => {
      expect(
        removeAttachmentTokenOccurrence(
          "first @[a.png] middle @[a.png] last @[a.png]",
          "a.png",
          occurrence,
        ),
      ).toEqual({ text, cursor });
    },
  );

  it("counts occurrences separately for each sanitized name", () => {
    expect(
      removeAttachmentTokenOccurrence(
        "@[a_b.png] @[other.png] @[a_b.png] end",
        "/tmp/a[b.png",
        1,
      ),
    ).toEqual({ text: "@[a_b.png] @[other.png] end", cursor: 24 });
  });

  it("preserves line breaks and places the caret at an edge deletion", () => {
    expect(
      removeAttachmentTokenOccurrence("@[a.png]\ntext", "a.png", 0),
    ).toEqual({
      text: "\ntext",
      cursor: 0,
    });
    expect(
      removeAttachmentTokenOccurrence("text @[a.png]", "a.png", 0),
    ).toEqual({
      text: "text",
      cursor: 4,
    });
  });

  it.each([-1, 1, 0.5, Number.NaN])(
    "leaves a missing occurrence %s untouched",
    (occurrence) => {
      expect(
        removeAttachmentTokenOccurrence("@[a.png]", "a.png", occurrence),
      ).toBeNull();
    },
  );

  it("counts and detects tokens", () => {
    expect(countAttachmentTokens("@[a.png] @[a.png]", "a.png")).toBe(2);
    expect(hasAttachmentToken("plain text", "a.png")).toBe(false);
  });

  it("splits text into ordered segments", () => {
    const segments = splitByAttachmentTokens("a @[x.png] b", ["x.png"]);
    expect(segments).toEqual([
      { type: "text", value: "a " },
      { type: "token", name: "x.png", raw: "@[x.png]", start: 2, end: 10 },
      { type: "text", value: " b" },
    ]);
  });

  it("leaves unknown tokens as plain text", () => {
    expect(splitByAttachmentTokens("a @[x.png] b", ["y.png"])).toEqual([
      { type: "text", value: "a @[x.png] b" },
    ]);
  });

  it("deletes a token as one unit from either side", () => {
    const text = "a @[x.png] b";
    // Caret right after the token, Backspace
    expect(
      deleteAttachmentTokenAtCaret(text, 10, 10, "backward", ["x.png"]),
    ).toEqual({ text: "a b", cursor: 2, name: "x.png" });
    // Caret right before the token, Delete
    expect(
      deleteAttachmentTokenAtCaret(text, 2, 2, "forward", ["x.png"]),
    ).toEqual({ text: "a b", cursor: 2, name: "x.png" });
    // Caret inside the token
    expect(
      deleteAttachmentTokenAtCaret(text, 5, 5, "backward", ["x.png"]),
    ).toEqual({ text: "a b", cursor: 2, name: "x.png" });
  });

  it("leaves normal deletions to the browser", () => {
    const text = "a @[x.png] b";
    // Caret at the very end, far from the token
    expect(
      deleteAttachmentTokenAtCaret(text, 12, 12, "backward", ["x.png"]),
    ).toBeNull();
    // Non-collapsed selection
    expect(
      deleteAttachmentTokenAtCaret(text, 2, 10, "backward", ["x.png"]),
    ).toBeNull();
    // Unknown attachment name
    expect(
      deleteAttachmentTokenAtCaret(text, 10, 10, "backward", ["y.png"]),
    ).toBeNull();
  });

  it("drops tokens from title-like previews", () => {
    expect(stripAttachmentTokensForTitle("@[a.png] 看看这个")).toBe("看看这个");
    expect(stripAttachmentTokensForTitle("plain title")).toBe("plain title");
    // Attachment-only prompts keep the file names so the title is not empty.
    expect(stripAttachmentTokensForTitle("@[a.png] @[b.png]")).toBe(
      "a.png, b.png",
    );
  });

  it("maps duplicated names positionally", () => {
    const files = [
      { originalName: "a.png", id: 1 },
      { originalName: "a.png", id: 2 },
    ];
    const pick = (occurrence: number) =>
      matchTokenToAttachment(files, (f) => f.originalName, "a.png", occurrence);
    expect(pick(0)?.id).toBe(1);
    expect(pick(1)?.id).toBe(2);
    expect(pick(5)?.id).toBe(1);
  });

  it("anchors insertion to the correct same-name attachment occurrence", () => {
    const files = [
      { name: "a.png", id: "first" },
      { name: "b.png", id: "other" },
      { name: "a.png", id: "second" },
    ];
    const text = "start @[a.png] middle @[b.png] then @[a.png] end";
    const findAfter = (position: number) =>
      findAttachmentAfterPosition(text, position, files, (file) => file.name);

    expect(findAfter(0)).toBe(files[0]);
    expect(findAfter(text.indexOf("@[a.png]"))).toBe(files[0]);
    expect(findAfter(text.indexOf("middle"))).toBe(files[1]);
    expect(findAfter(text.lastIndexOf("@[a.png]"))).toBe(files[2]);
    expect(findAfter(text.length)).toBeUndefined();
  });

  it("skips tokens starting before the insertion point and unknown tokens", () => {
    const files = [
      { name: "/tmp/a[b.png", id: "first" },
      { name: "next.png", id: "second" },
    ];
    const text = "@[unknown.png] @[a_b.png] @[next.png]";
    const getName = (file: (typeof files)[number]) => file.name;
    expect(findAttachmentAfterPosition(text, 0, files, getName)).toBe(files[0]);
    expect(
      findAttachmentAfterPosition(
        text,
        text.indexOf("@[a_b.png]") + 1,
        files,
        getName,
      ),
    ).toBe(files[1]);
    expect(findAttachmentAfterPosition(text, 0, [], getName)).toBeUndefined();
    expect(
      findAttachmentAfterPosition("plain text", 0, files, getName),
    ).toBeUndefined();
  });
});
