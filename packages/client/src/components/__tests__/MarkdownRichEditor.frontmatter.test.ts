import { describe, expect, it } from "vitest";
import { parseFrontmatterRows } from "../MarkdownRichEditor";

describe("parseFrontmatterRows", () => {
  it("returns an empty array for blank input", () => {
    expect(parseFrontmatterRows("")).toEqual([]);
    expect(parseFrontmatterRows("\n\n  \n")).toEqual([]);
  });

  it("parses simple flat key/value scalars", () => {
    expect(
      parseFrontmatterRows("name: foreign-telnet-qa\nversion: 1.0.0"),
    ).toEqual([
      { key: "name", value: "foreign-telnet-qa", kind: "string" },
      { key: "version", value: "1.0.0", kind: "string" },
    ]);
  });

  it("skips comments and blank lines", () => {
    expect(
      parseFrontmatterRows(
        "# header comment\n\nname: foo\n# trailing\nbar: baz\n",
      ),
    ).toEqual([
      { key: "name", value: "foo", kind: "string" },
      { key: "bar", value: "baz", kind: "string" },
    ]);
  });

  it("collects multi-line scalar continuations into a single row", () => {
    expect(
      parseFrontmatterRows(
        "description: |\n  扮演北京市「外国人来华工作许可」政务咨询智能体：\n  启用本技能时必须先阅读 references/reference.md",
      ),
    ).toEqual([
      {
        key: "description",
        value:
          "扮演北京市「外国人来华工作许可」政务咨询智能体：\n启用本技能时必须先阅读 references/reference.md",
        kind: "multiline",
      },
    ]);
  });

  it("returns kind=empty when value is missing and no continuation follows", () => {
    expect(parseFrontmatterRows("name:\nversion: 1.0.0")).toEqual([
      { key: "name", value: "", kind: "empty" },
      { key: "version", value: "1.0.0", kind: "string" },
    ]);
  });

  it("recognises inline list literals", () => {
    expect(parseFrontmatterRows("tags: [a, b, c]")).toEqual([
      { key: "tags", value: "a • b • c", kind: "list" },
    ]);
  });

  it("recognises inline object literals", () => {
    expect(parseFrontmatterRows('meta: { source: "x", priority: 1 }')).toEqual([
      {
        key: "meta",
        value: '{ source: "x", priority: 1 }',
        kind: "object",
      },
    ]);
  });

  it("preserves key order (document order)", () => {
    const yaml = "name: a\ndescription: b\nversion: c\ntags: [x, y]\nauthor: d";
    expect(parseFrontmatterRows(yaml).map((r) => r.key)).toEqual([
      "name",
      "description",
      "version",
      "tags",
      "author",
    ]);
  });
});
