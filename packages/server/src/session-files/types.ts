import { z } from "zod";

export const ObjectIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const RelativePathSchema = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.includes("\0") &&
      !path.split("/").some((part) => !part || part === "." || part === ".."),
    "Expected a canonical workspace-relative path",
  );

export const CapturePolicySchema = z.object({
  /** Absent in older snapshots, which used alphabetical order. */
  fileOrder: z.enum(["path", "source-first"]).optional(),
  maxFileBytes: z
    .number()
    .int()
    .positive()
    .max(64 * 1024 * 1024),
  maxTotalBytes: z.number().int().positive(),
  maxEntries: z.number().int().positive(),
  excludedDirectories: z.array(
    z
      .string()
      .min(1)
      .refine((s) => !/[\\/]/.test(s) && s !== "." && s !== ".."),
  ),
});
export type CapturePolicy = z.infer<typeof CapturePolicySchema>;
export const DEFAULT_CAPTURE_POLICY: CapturePolicy = {
  fileOrder: "source-first",
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxEntries: 20_000,
  excludedDirectories: [".git", "node_modules", ".venv", "__pycache__"],
};

export const SnapshotFileSchema = z.object({
  path: RelativePathSchema,
  blob: ObjectIdSchema,
  bytes: z.number().int().nonnegative(),
  executable: z.boolean(),
});
export const SnapshotSchema = z.object({
  version: z.literal(1),
  workspace: z.string().min(1),
  startedAt: z.string(),
  finishedAt: z.string(),
  enumeration: z.enum(["git", "directory"]),
  policy: CapturePolicySchema,
  listingComplete: z.boolean(),
  files: z.array(SnapshotFileSchema),
  omissions: z.array(
    z.object({
      path: RelativePathSchema,
      reason: z.enum([
        "ignored",
        "symlink",
        "unsupported",
        "too-large",
        "byte-budget",
        "unreadable",
        "unstable",
      ]),
    }),
  ),
});
export type FileSnapshot = z.infer<typeof SnapshotSchema>;

export const ScopeSchema = z.object({
  provider: z.enum(["codex", "pi"]),
  sessionId: z.string().min(1),
  branchId: z.string().min(1),
  turnId: z.string().min(1),
  toolCallId: z.string().min(1).optional(),
});
export type FileChangeScope = z.infer<typeof ScopeSchema>;

export const ChangeRecordSchema = z.object({
  version: z.literal(1),
  scope: ScopeSchema,
  beforeSnapshot: ObjectIdSchema,
  afterSnapshot: ObjectIdSchema,
  evidence: z.literal("snapshot"),
  // A snapshot proves a filesystem difference, not which process wrote it.
  attribution: z.literal("observed-during-execution"),
  complete: z.boolean(),
  execution: z
    .object({
      /** Groups live checkpoints and the terminal observation of one execution. */
      captureId: z.string().uuid().optional(),
      status: z.enum([
        "active",
        "completed",
        "failed",
        "interrupted",
        "disconnected",
        "rejected",
      ]),
      coverage: z.enum(["full", "partial"]),
    })
    .optional(),
  changes: z.array(
    z.object({
      path: RelativePathSchema,
      kind: z.enum(["added", "modified", "deleted"]),
      before: SnapshotFileSchema.optional(),
      after: SnapshotFileSchema.optional(),
    }),
  ),
  uncertainPaths: z.array(RelativePathSchema),
});
export type FileChangeRecord = z.infer<typeof ChangeRecordSchema>;
