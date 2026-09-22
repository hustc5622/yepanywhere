import { z } from "zod";

const identity = z.string().min(1).max(4_096);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const SessionFileOperationScopeSchema = z
  .object({
    provider: identity,
    sourceId: identity,
    sessionId: identity,
  })
  .strict();
export const SessionFileOperationIdentitySchema =
  SessionFileOperationScopeSchema.extend({
    turnId: identity,
    toolCallId: identity,
    subOperationId: identity.optional(),
  }).strict();

export const SessionFileContentRefSchema = z
  .object({
    hash,
    bytes: z
      .number()
      .int()
      .nonnegative()
      .max(64 * 1024 * 1024),
    binary: z.boolean(),
  })
  .strict();

export const SessionFileOperationChangeSchema = z
  .object({
    path: identity,
    previousPath: identity.optional(),
    kind: z.enum(["added", "modified", "deleted", "renamed", "mode-change"]),
    outcome: z.enum(["applied", "failed", "unknown"]),
    // null means known absence; undefined means the content was not captured.
    before: SessionFileContentRefSchema.nullable().optional(),
    after: SessionFileContentRefSchema.nullable().optional(),
    patch: z
      .object({
        format: z.literal("unified"),
        text: z.string().max(4 * 1024 * 1024),
        complete: z.boolean(),
      })
      .strict()
      .optional(),
    unavailableReason: z
      .enum([
        "content-not-recorded",
        "binary",
        "truncated",
        "capture-failed",
        "limit",
        "unsupported",
      ])
      .optional(),
  })
  .strict()
  .superRefine((change, ctx) => {
    if (change.kind === "renamed" && !change.previousPath) {
      ctx.addIssue({ code: "custom", message: "Rename requires previousPath" });
    }
    if (change.kind === "added" && change.before !== null) {
      ctx.addIssue({
        code: "custom",
        message: "Addition requires known absence",
      });
    }
    if (change.kind === "deleted" && change.after !== null) {
      ctx.addIssue({
        code: "custom",
        message: "Deletion requires known absence",
      });
    }
  });

/** A provider-confirmed operation, never a workspace observation or a tool proposal. */
export const SessionFileOperationSchema = z
  .object({
    schemaVersion: z.literal(1),
    identity: SessionFileOperationIdentitySchema,
    workspace: identity,
    // Membership is selected using native ancestry, not by path or timestamps.
    branchId: identity,
    messageId: identity,
    timestamp: z.string().datetime(),
    order: z.number().int().nonnegative(),
    toolName: identity,
    source: z.enum([
      "native-file-event",
      "tool-result",
      "instrumented-write",
      "historical-tool-record",
    ]),
    outcome: z.enum([
      "pending",
      "applied",
      "partially-applied",
      "failed",
      "declined",
      "unknown",
    ]),
    resultId: identity.optional(),
    changes: z.array(SessionFileOperationChangeSchema).max(2_000),
  })
  .strict()
  .superRefine((operation, ctx) => {
    const applied = operation.changes.filter(
      (change) => change.outcome === "applied",
    );
    if (
      applied.length &&
      (!operation.resultId ||
        !["applied", "partially-applied"].includes(operation.outcome))
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Applied changes require a confirmed execution result",
      });
    }
    if (
      operation.outcome === "applied" &&
      (!operation.resultId ||
        !applied.length ||
        applied.length !== operation.changes.length)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Applied operation requires confirmed changes",
      });
    }
    if (
      operation.outcome === "partially-applied" &&
      (!applied.length || applied.length === operation.changes.length)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Partial operation requires applied and unresolved changes",
      });
    }
    if (
      new Set(operation.changes.map((change) => change.path)).size !==
      operation.changes.length
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Duplicate file within one operation",
      });
    }
  });

export type SessionFileOperation = z.infer<typeof SessionFileOperationSchema>;
export type SessionFileOperationIdentity = z.infer<
  typeof SessionFileOperationIdentitySchema
>;
export type SessionFileOperationScope = z.infer<
  typeof SessionFileOperationScopeSchema
>;
export type SessionFileOperationChange = z.infer<
  typeof SessionFileOperationChangeSchema
>;
export type SessionFileContentRef = z.infer<typeof SessionFileContentRefSchema>;

export interface SessionFileOperationStats {
  additions?: number;
  deletions?: number;
  availability: "complete" | "unavailable";
  reason?:
    | "binary"
    | "missing-evidence"
    | "invalid-patch"
    | "timeout"
    | "missing-content";
}
