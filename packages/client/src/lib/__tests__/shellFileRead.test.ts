import { describe, expect, it } from "vitest";
import { detectShellFileRead } from "../shellFileRead";

describe("detectShellFileRead", () => {
  it.each([
    ["cat src/app.ts", { path: "src/app.ts" }],
    ["cat -n 'docs/a b.md'", { path: "docs/a b.md" }],
    ['cat "docs/a b.md"', { path: "docs/a b.md" }],
    ["cat '$FILE'", { path: "$FILE" }],
    ['cat "docs/\\$FILE.md"', { path: "docs/$FILE.md" }],
    ['cat "docs/a\\b.md"', { path: "docs/a\\b.md" }],
    [
      "sed -n '120,180p' packages/x.ts",
      { path: "packages/x.ts", lineNumber: 120, lineEnd: 180 },
    ],
    ["sed -n 5p a.ts", { path: "a.ts", lineNumber: 5, lineEnd: 5 }],
    [
      "nl -ba src/app.ts | sed -n '1,80p'",
      { path: "src/app.ts", lineNumber: 1, lineEnd: 80 },
    ],
    ["cat a.md | head -n 20", { path: "a.md", lineNumber: 1, lineEnd: 20 }],
    [
      "head -n 40 /tmp/log.txt",
      { path: "/tmp/log.txt", lineNumber: 1, lineEnd: 40 },
    ],
    ["head -40 log.txt", { path: "log.txt", lineNumber: 1, lineEnd: 40 }],
    ["tail -n 20 server.log", { path: "server.log" }],
  ])("recognizes %s", (command, expected) => {
    expect(detectShellFileRead(command)).toEqual(expected);
  });

  it.each([
    "cat a.ts b.ts",
    "cat *.ts",
    "cat $FILE",
    'cat "$FILE"',
    'cat "$(pwd)/a.ts"',
    'cat "`pwd`/a.ts"',
    "cat a.ts > b.ts",
    "cd x && cat a.ts",
    "grep foo a.ts",
    "cat a.ts | grep foo",
    "sed -i 's/a/b/' a.ts",
    "sed -n '1,5p' a.ts | head -n 2",
    "tail -n 20 a.ts | head -n 5",
    "tail -n 20 a.ts | sed -n '2,5p'",
    "head a.ts | sed -n '12,20p'",
    "cat 'unterminated",
    "cat a.ts\ncat b.ts",
    "",
  ])("ignores %s", (command) => {
    expect(detectShellFileRead(command)).toBeNull();
  });
});
