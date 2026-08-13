import type { KimiGoalSnapshot } from "@yep-anywhere/shared";
import type { ContentBlock, Message } from "../types";

/**
 * RenderItem types for the preprocessed message rendering system.
 *
 * Instead of rendering Message[] directly, we preprocess into RenderItem[]
 * that pairs tool_use with tool_result for unified display.
 */

export type RenderItem =
  | TextItem
  | ThinkingItem
  | ToolCallItem
  | UserPromptItem
  | SessionSetupItem
  | SystemItem
  | CodexNativeItem;

/** Base fields shared by all render items */
interface RenderItemBase {
  /** Source JSONL messages that contributed to this item (for debugging) */
  sourceMessages: Message[];
  /** True if this item is from a Task subagent */
  isSubagent?: boolean;
}

export interface TextItem extends RenderItemBase {
  type: "text";
  id: string;
  text: string;
  /** Codex assistant phase; commentary is an explicit model progress update. */
  phase?: "commentary" | "final_answer";
  /** True if this text is still being streamed */
  isStreaming?: boolean;
  /** Pre-rendered HTML from server (for completed messages) */
  augmentHtml?: string;
}

export interface ThinkingItem extends RenderItemBase {
  type: "thinking";
  id: string;
  thinking: string;
  signature?: string;
  status: "streaming" | "complete";
}

export interface ToolCallItem extends RenderItemBase {
  type: "tool_call";
  id: string; // tool_use.id
  toolName: string; // tool_use.name
  toolInput: unknown; // tool_use.input
  toolResult?: ToolResultData; // undefined while pending
  status: "pending" | "complete" | "error" | "aborted";
  /** Live streaming output preview while the tool is still running. */
  partialOutput?: string;
}

export interface ToolResultData {
  content: string;
  isError: boolean;
  /** Structured result from JSONL toolUseResult field */
  structured?: unknown;
}

export interface UserPromptItem extends RenderItemBase {
  type: "user_prompt";
  id: string;
  content: string | ContentBlock[];
}

export interface SessionSetupItem extends RenderItemBase {
  type: "session_setup";
  id: string;
  title: string;
  prompts: Array<string | ContentBlock[]>;
}

export interface SystemItem extends RenderItemBase {
  type: "system";
  id: string;
  subtype: "compact_boundary" | "status" | "init" | string;
  content: string;
  /** For status subtype: the current status (e.g., "compacting") */
  status?: "compacting" | null;
  /** Structured Kimi goal lifecycle state for the inline goal renderer. */
  goalSnapshot?: KimiGoalSnapshot;
}

/**
 * Codex app-server native ThreadItem projected through the canonical overlay.
 *
 * The server emits these as system messages with `subtype: "codex_native_item"`
 * carrying a `codexThreadItem` payload. The client splits them out from generic
 * system messages so dedicated renderers can surface plan, sub-agent activity,
 * and collaboration tool-call content that the generic system renderer would
 * silently drop.
 */
export interface CodexNativeItem extends RenderItemBase {
  type: "codex_native_item";
  id: string;
  /** The projected ThreadItem payload (type + item-specific fields). */
  threadItem: {
    type: string;
    id?: string;
    [key: string]: unknown;
  };
  /** Whether this item is mid-stream ("started") or finished ("completed"). */
  lifecycle: "started" | "completed";
  /** The Codex thread id this item belongs to, when known. */
  threadId?: string;
  /** The Codex turn id this item belongs to, when known. */
  turnId?: string;
}
