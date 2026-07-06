import { describe, expect, it } from "vitest";
import { parseGitStatusSummary } from "../src/git-status-summary.js";

describe("parseGitStatusSummary", () => {
  it("summarizes branch state and working tree counts", () => {
    const summary = parseGitStatusSummary(
      `# branch.oid abc123456789
# branch.head main
# branch.upstream origin/main
# branch.ab +2 -1
1 M. N... 100644 100644 100644 aaaaaa bbbbbb src/staged.ts
1 .M N... 100644 100644 100644 aaaaaa bbbbbb src/changed.ts
1 MM N... 100644 100644 100644 aaaaaa bbbbbb src/both.ts
1 .D N... 100644 100644 000000 aaaaaa bbbbbb deleted.txt
? src/new.ts
? scratch/
u UU N... 100644 100644 100644 100644 aaaaaa bbbbbb cccccc src/conflict.ts
`,
      2,
    );

    expect(summary).toEqual({
      isGitRepo: true,
      branch: "main",
      head: "abc1234",
      upstream: "origin/main",
      ahead: 2,
      behind: 1,
      isClean: false,
      stagedCount: 2,
      unstagedCount: 2,
      deletedCount: 1,
      untrackedCount: 2,
      conflictedCount: 1,
      stashCount: 2,
    });
  });

  it("handles detached clean worktrees", () => {
    const summary = parseGitStatusSummary(`# branch.oid abc123
# branch.head (detached)
`);

    expect(summary).toMatchObject({
      isGitRepo: true,
      branch: null,
      head: "abc123",
      isClean: true,
      stagedCount: 0,
      unstagedCount: 0,
      deletedCount: 0,
      untrackedCount: 0,
      conflictedCount: 0,
      stashCount: 0,
    });
  });
});
