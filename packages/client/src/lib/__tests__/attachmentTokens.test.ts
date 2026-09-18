import { describe, expect, it } from "vitest";
import {
  buildAttachmentToken,
  countAttachmentTokens,
  deleteAttachmentTokenAtCaret,
  findAttachmentTokens,
  hasAttachmentToken,
  insertAttachmentToken,
  matchTokenToAttachment,
  removeAttachmentToken,
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

  it("inserts at the caret with single-space padding", () => {
    const result = insertAttachmentToken("hello world", 5, "shot.png");
    expect(result.text).toBe("hello @[shot.png] world");
    expect(result.text.slice(0, result.cursor)).toBe("hello @[shot.png]");
  });

  it("inserts without doubling spaces", () => {
    expect(insertAttachmentToken("", 0, "a.png").text).toBe("@[a.png]");
    expect(insertAttachmentToken("hi ", 3, "a.png").text).toBe("hi @[a.png]");
  });

  it("removes the last matching token and collapses spacing", () => {
    expect(removeAttachmentToken("hello @[a.png] world", "a.png")).toBe(
      "hello world",
    );
    expect(removeAttachmentToken("@[a.png] @[a.png] x", "a.png")).toBe(
      "@[a.png] x",
    );
    expect(removeAttachmentToken("no token", "a.png")).toBe("no token");
  });

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
});
