/**
 * Type-only exports for Codex schema.
 * Import from here to avoid pulling in Zod runtime.
 */

// Content types (used by session files)
export type {
  CodexTextContent,
  CodexToolUseContent,
  CodexToolResultContent,
  CodexReasoningContent,
  CodexContentBlock,
  CodexMessageContent,
} from "./content.js";

// Session file types (persisted format in ~/.codex/sessions/)
export type {
  CodexSessionMetaPayload,
  CodexSessionMetaEntry,
  CodexMessagePhase,
  CodexMessagePayload,
  CodexReasoningPayload,
  CodexFunctionCallPayload,
  CodexFunctionCallOutputPayload,
  CodexCustomToolCallPayload,
  CodexCustomToolCallOutputPayload,
  CodexWebSearchCallPayload,
  CodexImageGenerationPayload,
  CodexGhostSnapshotPayload,
  CodexResponseItemPayload,
  CodexResponseItemEntry,
  CodexEventMsgPayload,
  CodexFileChange,
  CodexPatchApplyStatus,
  CodexPatchApplyBeginEvent,
  CodexPatchApplyUpdatedEvent,
  CodexPatchApplyEndEvent,
  CodexTurnAbortedEvent,
  CodexThreadRolledBackEvent,
  CodexEventMsgEntry,
  CodexCompactedPayload,
  CodexCompactedEntry,
  CodexTurnContextPayload,
  CodexTurnContextEntry,
  CodexSessionEntry,
} from "./session.js";
