import { z } from "zod";
import type { AppMessage } from "./app-types.js";

/** Product defaults confirmed for the first display-projection rollout. */
export const SESSION_DISPLAY_INITIAL_TURN_LIMIT = 40;
export const SESSION_DISPLAY_TOOL_DETAIL_PAGE_LIMIT = 50;
export const SESSION_DISPLAY_MAX_TOOL_NAMES = 5;
export const SESSION_DISPLAY_MAX_NOTICE_LENGTH = 8_192;
export const SESSION_DISPLAY_QUESTION_PREVIEW_MAX_LENGTH = 140;

const NonEmptyIdSchema = z.string().min(1);
const TimestampSchema = z.string().min(1);

export const SessionDisplayUserTextBlockSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
  })
  .strict();

/**
 * A deliberately body-free user attachment placeholder.
 *
 * Inline data, local paths and provider URLs are excluded from the display
 * page. A later media-detail route may add an opaque reference without
 * widening this object to arbitrary provider fields.
 */
export const SessionDisplayUserMediaBlockSchema = z
  .object({
    type: z.literal("media"),
    kind: z.enum(["image", "audio", "document", "file"]),
    mimeType: z.string().min(1).max(128).optional(),
    deferred: z.literal(true),
  })
  .strict();

export const SessionDisplayUserContentSchema = z.union([
  z.string(),
  z.array(
    z.discriminatedUnion("type", [
      SessionDisplayUserTextBlockSchema,
      SessionDisplayUserMediaBlockSchema,
    ]),
  ),
]);

export const SessionDisplayBranchRefSchema = z
  .object({
    branchId: NonEmptyIdSchema,
    parentId: z.string().nullable(),
    siblingIndex: z.number().int().nonnegative(),
    siblingCount: z.number().int().positive(),
  })
  .strict();

export const SessionDisplayQuestionSchema = z
  .object({
    messageId: NonEmptyIdSchema,
    /** Client-generated identity shared by live and persisted user messages. */
    clientUserMessageId: NonEmptyIdSchema.optional(),
    /** Provider correlation identity used to reconcile source-native ids. */
    codexCorrelationKey: NonEmptyIdSchema.optional(),
    parentMessageId: z.string().nullable().optional(),
    content: SessionDisplayUserContentSchema,
    timestamp: TimestampSchema.optional(),
    branch: SessionDisplayBranchRefSchema.optional(),
  })
  .strict();

export const SessionDisplayAssistantTextSegmentSchema = z
  .object({
    type: z.literal("assistant_text"),
    id: NonEmptyIdSchema,
    /** Stable native identity shared by live and persisted assistant rows. */
    codexCorrelationKey: NonEmptyIdSchema.optional(),
    phase: z.enum(["progress", "final", "text"]),
    content: z.string(),
    timestamp: TimestampSchema.optional(),
  })
  .strict();

export const SessionDisplayToolGroupSegmentSchema = z
  .object({
    type: z.literal("tool_group"),
    id: NonEmptyIdSchema,
    status: z.enum(["running", "completed", "failed", "mixed"]),
    count: z.number().int().positive(),
    failedCount: z.number().int().nonnegative(),
    changedFileCount: z.number().int().nonnegative().optional(),
    checkCount: z.number().int().nonnegative().optional(),
    toolNames: z
      .array(z.string().min(1).max(256))
      .max(SESSION_DISPLAY_MAX_TOOL_NAMES),
    detailRef: NonEmptyIdSchema,
    /** The only active tool batch not yet closed by readable assistant text. */
    liveTail: z.literal(true).optional(),
    timestamp: TimestampSchema.optional(),
  })
  .strict()
  .superRefine((group, context) => {
    if (group.failedCount > group.count) {
      context.addIssue({
        code: "custom",
        message: "failedCount cannot exceed count",
        path: ["failedCount"],
      });
    }
    if (group.checkCount !== undefined && group.checkCount > group.count) {
      context.addIssue({
        code: "custom",
        message: "checkCount cannot exceed count",
        path: ["checkCount"],
      });
    }
  });

export const SessionDisplayActionRequiredSegmentSchema = z
  .object({
    type: z.literal("action_required"),
    id: NonEmptyIdSchema,
    action: z.enum(["approval", "question"]),
    status: z.enum(["running", "completed", "failed"]),
    label: z.string().max(SESSION_DISPLAY_MAX_NOTICE_LENGTH).optional(),
    detailRef: NonEmptyIdSchema.optional(),
    timestamp: TimestampSchema.optional(),
  })
  .strict();

export const SessionDisplayErrorSegmentSchema = z
  .object({
    type: z.literal("error"),
    id: NonEmptyIdSchema,
    message: z.string().max(SESSION_DISPLAY_MAX_NOTICE_LENGTH),
    timestamp: TimestampSchema.optional(),
  })
  .strict();

/** Lightweight replacements for visible, non-message timeline rows. */
export const SessionDisplayNoticeSegmentSchema = z
  .object({
    type: z.literal("notice"),
    id: NonEmptyIdSchema,
    kind: z.enum([
      "session_setup",
      "compaction",
      "warning",
      "turn_aborted",
      "goal",
      "plan",
      "subagent",
      "provider_event",
    ]),
    title: z.string().max(512).optional(),
    message: z.string().max(SESSION_DISPLAY_MAX_NOTICE_LENGTH).optional(),
    status: z.string().max(64).optional(),
    count: z.number().int().positive().optional(),
    timestamp: TimestampSchema.optional(),
  })
  .strict();

export const SessionDisplaySegmentSchema = z.discriminatedUnion("type", [
  SessionDisplayAssistantTextSegmentSchema,
  SessionDisplayToolGroupSegmentSchema,
  SessionDisplayActionRequiredSegmentSchema,
  SessionDisplayErrorSegmentSchema,
  SessionDisplayNoticeSegmentSchema,
]);

export const SessionDisplayTurnSchema = z
  .object({
    id: NonEmptyIdSchema,
    /** Null is reserved for setup/provider events before the first real prompt. */
    question: SessionDisplayQuestionSchema.nullable(),
    segments: z.array(SessionDisplaySegmentSchema),
  })
  .strict();

export const SessionDisplayPageSchema = z
  .object({
    sessionId: NonEmptyIdSchema,
    revision: NonEmptyIdSchema,
    turns: z.array(SessionDisplayTurnSchema),
    nextCursor: NonEmptyIdSchema.optional(),
  })
  .strict();

export const SessionQuestionPageItemSchema = z
  .object({
    messageId: NonEmptyIdSchema,
    turnId: NonEmptyIdSchema,
    clientUserMessageId: NonEmptyIdSchema.optional(),
    codexCorrelationKey: NonEmptyIdSchema.optional(),
    preview: z.string().max(SESSION_DISPLAY_QUESTION_PREVIEW_MAX_LENGTH),
    timestamp: TimestampSchema.optional(),
  })
  .strict();

export const SessionQuestionPageSchema = z
  .object({
    questions: z.array(SessionQuestionPageItemSchema),
    coverage: z.enum(["complete", "partial", "unavailable"]),
    nextCursor: NonEmptyIdSchema.optional(),
  })
  .strict();

export type SessionDisplayUserContent = z.infer<
  typeof SessionDisplayUserContentSchema
>;
export type SessionDisplayQuestion = z.infer<
  typeof SessionDisplayQuestionSchema
>;
export type SessionDisplaySegment = z.infer<typeof SessionDisplaySegmentSchema>;
export type SessionDisplayTurn = z.infer<typeof SessionDisplayTurnSchema>;
export type SessionDisplayPage = z.infer<typeof SessionDisplayPageSchema>;
export type SessionQuestionPageItem = z.infer<
  typeof SessionQuestionPageItemSchema
>;
export type SessionQuestionPage = z.infer<typeof SessionQuestionPageSchema>;

/** Explicit, bounded detail response; unlike SessionDisplayPage it carries tool bodies. */
export interface SessionToolGroupDetailPage<TMessage = AppMessage> {
  sessionId: string;
  revision: string;
  detailRef: string;
  messages: TMessage[];
  nextCursor?: string;
}
