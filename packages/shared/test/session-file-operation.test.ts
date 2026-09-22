import { describe, expect, it } from "vitest";
import { SessionFileOperationSchema } from "../src/session-file-operation.js";

const record = {
  schemaVersion: 1,
  identity: {
    provider: "codex",
    sourceId: "host",
    sessionId: "s",
    turnId: "t",
    toolCallId: "call",
  },
  workspace: "/project",
  branchId: "s",
  messageId: "m",
  timestamp: "2026-09-21T00:00:00Z",
  order: 1,
  toolName: "apply_patch",
  source: "native-file-event",
  outcome: "applied",
  resultId: "completed:call",
  changes: [
    { path: "report.md", kind: "added", outcome: "applied", before: null },
  ],
};

describe("file operation contract", () => {
  it("retains a confirmed file when full content and line counts are unavailable", () => {
    expect(SessionFileOperationSchema.parse(record)).toEqual(record);
  });
  it("does not mistake missing results, denied proposals or pending calls for applied writes", () => {
    for (const mutation of [
      { resultId: undefined },
      { outcome: "pending" },
      { outcome: "declined" },
      { outcome: "unknown" },
    ]) {
      expect(
        SessionFileOperationSchema.safeParse({ ...record, ...mutation })
          .success,
      ).toBe(false);
    }
  });
  it("requires an explicit absent preimage for an addition", () => {
    expect(
      SessionFileOperationSchema.safeParse({
        ...record,
        changes: [{ ...record.changes[0], before: undefined }],
      }).success,
    ).toBe(false);
  });
  it("represents per-file partial failures without declaring the entire patch successful", () => {
    expect(
      SessionFileOperationSchema.safeParse({
        ...record,
        outcome: "partially-applied",
        changes: [
          ...record.changes,
          { path: "other.md", kind: "modified", outcome: "unknown" },
        ],
      }).success,
    ).toBe(true);
  });
  it("rejects duplicate paths and unknown schema fields", () => {
    expect(
      SessionFileOperationSchema.safeParse({
        ...record,
        changes: [...record.changes, ...record.changes],
      }).success,
    ).toBe(false);
    expect(
      SessionFileOperationSchema.safeParse({
        ...record,
        confirmedByWorktree: true,
      }).success,
    ).toBe(false);
  });
});
