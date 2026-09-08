import { z } from "zod";
import type { AppMessage } from "./app-types.js";

/** Product defaults confirmed for the first display-projection rollout. */
export const SESSION_DISPLAY_INITIAL_TURN_LIMIT = 40;
export const SESSION_DISPLAY_TOOL_DETAIL_PAGE_LIMIT = 50;
export const SESSION_DISPLAY_MAX_TOOL_NAMES = 5;
export const SESSION_DISPLAY_MAX_NOTICE_LENGTH = 8_192;
export const SESSION_DISPLAY_QUESTION_PREVIEW_MAX_LENGTH = 140;
/** Reasoning preview kept inline; longer bodies need an explicit detail read. */
export const SESSION_DISPLAY_THINKING_PREVIEW_MAX_LENGTH = 240;
export const SESSION_DISPLAY_LIVE_STEP_LIMIT = 50;
export const SESSION_DISPLAY_STEP_PREVIEW_LIMIT = 2_048;

export const SessionDisplayToolStepSchema = z
  .object({
    id: z.string().min(1),
    groupId: z.string().min(1),
    name: z.string(),
    status: z.enum([
      "running",
      "completed",
      "failed",
      "interrupted",
      "unknown",
    ]),
    /** Single-line command or target summary; never contains the tool result. */
    summary: z.string(),
    /** Compatibility field. V2 index responses emit an empty string. */
    preview: z.string().max(SESSION_DISPLAY_STEP_PREVIEW_LIMIT),
    truncated: z.boolean(),
    version: z.number().int().nonnegative(),
    timestamp: z.string().optional(),
  })
  .strict();
export type SessionDisplayToolStep = z.infer<
  typeof SessionDisplayToolStepSchema
>;

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
    tempId: NonEmptyIdSchema.optional(),
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
    streaming: z.boolean().optional(),
    /** Server-rendered, sanitized Markdown for the visible assistant text. */
    renderedHtml: z.string().optional(),
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
    /** v2: presentation is independent of execution and detail interest. */
    displayMode: z.enum(["steps", "summary"]).optional(),
    runningCount: z.number().int().nonnegative().optional(),
    unknownCount: z.number().int().nonnegative().optional(),
    interruptedCount: z.number().int().nonnegative().optional(),
    steps: z.array(SessionDisplayToolStepSchema).optional(),
    version: z.number().int().nonnegative().optional(),
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

/**
 * A provider reasoning row.
 *
 * Reasoning is the only progress signal some providers emit between tool
 * batches (Pi in particular), so it must exist in the lightweight page to keep
 * the timeline readable and to close tool groups. Only a bounded preview is
 * inlined; `truncated` marks rows whose full body lives behind `detailRef`.
 */
export const SessionDisplayThinkingSegmentSchema = z
  .object({
    type: z.literal("thinking"),
    id: NonEmptyIdSchema,
    content: z.string().max(SESSION_DISPLAY_THINKING_PREVIEW_MAX_LENGTH),
    truncated: z.literal(true).optional(),
    detailRef: NonEmptyIdSchema,
    timestamp: TimestampSchema.optional(),
  })
  .strict();

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
  SessionDisplayThinkingSegmentSchema,
  SessionDisplayToolGroupSegmentSchema,
  SessionDisplayActionRequiredSegmentSchema,
  SessionDisplayErrorSegmentSchema,
  SessionDisplayNoticeSegmentSchema,
]);

/** Provider-native lifecycle projected onto one semantic turn. */
export const SessionDisplayTurnStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "interrupted",
]);

export const SessionDisplayTurnSchema = z
  .object({
    id: NonEmptyIdSchema,
    /** Optional for compatibility with providers that cannot expose turn state. */
    status: SessionDisplayTurnStatusSchema.optional(),
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
export type SessionDisplayTurnStatus = z.infer<
  typeof SessionDisplayTurnStatusSchema
>;
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

/** Full reasoning body for one thinking segment, fetched only on expand. */
export interface SessionThinkingDetail {
  sessionId: string;
  revision: string;
  detailRef: string;
  content: string;
}

/** Shared objects for the snapshot and incremental display subscription. */
export const SessionDisplayNodeSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("question"),
      id: NonEmptyIdSchema,
      turnId: NonEmptyIdSchema,
      question: SessionDisplayQuestionSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("segment"),
      id: NonEmptyIdSchema,
      turnId: NonEmptyIdSchema,
      segment: SessionDisplaySegmentSchema,
    })
    .strict(),
]);
export const SessionDisplayViewSchema = z
  .object({
    sessionId: NonEmptyIdSchema,
    branchScopeId: NonEmptyIdSchema,
    epoch: NonEmptyIdSchema,
  })
  .strict();
export const SessionDisplayActivitySchema = z
  .object({
    state: z.enum([
      "running",
      "waiting-input",
      "finishing",
      "hold",
      "completed",
      "interrupted",
      "failed",
      "unknown",
    ]),
    tools: z.array(SessionDisplayToolStepSchema),
    runningCount: z.number().int().nonnegative(),
  })
  .strict();
export const SessionDisplaySnapshotSchema = z
  .object({
    version: z.literal(2),
    view: SessionDisplayViewSchema,
    seq: z.number().int().nonnegative(),
    nodes: z.array(SessionDisplayNodeSchema),
    activity: SessionDisplayActivitySchema,
    olderCursor: z.string().optional(),
  })
  .strict();
export const SessionDisplayPatchSchema = z
  .object({
    view: SessionDisplayViewSchema,
    baseSeq: z.number().int().nonnegative(),
    seq: z.number().int().nonnegative(),
    upsert: z.array(SessionDisplayNodeSchema),
    remove: z.array(NonEmptyIdSchema),
    order: z.array(NonEmptyIdSchema).optional(),
    activity: SessionDisplayActivitySchema,
  })
  .strict();
export type SessionDisplayNode = z.infer<typeof SessionDisplayNodeSchema>;
export type SessionDisplayView = z.infer<typeof SessionDisplayViewSchema>;
export type SessionDisplayActivity = z.infer<
  typeof SessionDisplayActivitySchema
>;
export type SessionDisplaySnapshot = z.infer<
  typeof SessionDisplaySnapshotSchema
>;
export type SessionDisplayPatch = z.infer<typeof SessionDisplayPatchSchema>;

export interface SessionDisplaySubscriptionOptions {
  projectId: string;
  branchId?: string;
}

export interface SessionDisplayGroupPage {
  groupId: string;
  steps: SessionDisplayToolStep[];
  total: number;
  nextCursor?: string;
}

export interface SessionDisplayToolDetail<TMessage = AppMessage> {
  toolId: string;
  version: number;
  messages: TMessage[];
  /** Latest bounded terminal tail for a running tool, including an empty tail. */
  liveOutput?: string;
  liveOutputRevision?: string;
  /** Large outputs are paged separately; never silently claim completeness. */
  nextCursor?: string;
  rawJson?: {
    content: string;
    offset: number;
    total: number;
    revision: string;
  };
}

/** Conditional, bounded output read; unchanged responses omit the output body. */
export interface SessionDisplayToolOutput {
  revision: string;
  status: SessionDisplayToolStep["status"];
  output?: string;
}

export function sameSessionDisplayView(
  a: SessionDisplayView,
  b: SessionDisplayView,
): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.branchScopeId === b.branchScopeId &&
    a.epoch === b.epoch
  );
}

/** null means a gap/epoch change, never permission to guess away messages. */
export function applySessionDisplayPatch(
  state: SessionDisplaySnapshot,
  patch: SessionDisplayPatch,
): SessionDisplaySnapshot | null {
  if (!sameSessionDisplayView(state.view, patch.view)) return null;
  if (patch.seq <= state.seq) return state;
  if (patch.baseSeq !== state.seq || patch.seq <= patch.baseSeq) return null;
  const nodes = new Map(state.nodes.map((node) => [node.id, node]));
  for (const id of patch.remove) nodes.delete(id);
  for (const node of patch.upsert) nodes.set(node.id, node);
  const order = patch.order ?? [...nodes.keys()];
  if (
    order.length !== nodes.size ||
    order.some((id) => !nodes.has(id)) ||
    new Set(order).size !== order.length
  )
    return null;
  return {
    ...state,
    seq: patch.seq,
    nodes: order.flatMap((id) => {
      const node = nodes.get(id);
      return node ? [node] : [];
    }),
    activity: patch.activity,
  };
}

/** Reuse existing text/attachment renderers without reconstructing raw tools. */
export function sessionDisplaySnapshotPage(
  snapshot: SessionDisplaySnapshot,
): SessionDisplayPage {
  const turns: SessionDisplayTurn[] = [];
  for (const node of snapshot.nodes) {
    if (node.type === "question") {
      turns.push({ id: node.turnId, question: node.question, segments: [] });
    } else {
      let turn = turns.at(-1);
      if (!turn || turn.id !== node.turnId) {
        turn = { id: node.turnId, question: null, segments: [] };
        turns.push(turn);
      }
      turn.segments.push(node.segment);
    }
  }
  return {
    sessionId: snapshot.view.sessionId,
    revision: `display-v2:${snapshot.view.epoch}`,
    turns,
    ...(snapshot.olderCursor ? { nextCursor: snapshot.olderCursor } : {}),
  };
}
