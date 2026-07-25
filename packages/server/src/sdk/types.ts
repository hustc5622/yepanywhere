// Core types shared by provider adapters and legacy test doubles.

// Re-export PermissionMode from shared
export type { PermissionMode } from "@yep-anywhere/shared";
import type { PermissionMode, UploadedFile } from "@yep-anywhere/shared";

export interface ContentBlock {
  type: "text" | "tool_use" | "tool_result" | "image" | "thinking";
  text?: string;
  /** For thinking blocks */
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  /** For tool_result blocks - references the tool_use id */
  tool_use_id?: string;
  /** For tool_result blocks - the result content */
  content?: string;
}

/**
 * SDK Message - loosely typed to preserve all fields from the SDK.
 *
 * We intentionally use a loose type here to:
 * 1. Pass through all SDK fields without stripping
 * 2. Allow frontend to inspect any field for debugging
 * 3. Avoid breaking when SDK adds new fields
 *
 * Known fields are documented but not enforced.
 */
export interface SDKMessage {
  type: string;
  uuid?: string;
  subtype?: string;
  session_id?: string;
  /** Provider-specific resolved model from init events. */
  model?: string;
  /** Provider-specific reasoning effort from init events. */
  reasoningEffort?: string | null;
  /** Provider-specific service tier / speed from init events. */
  serviceTier?: string | null;
  timestamp?: string;
  message?: {
    content: string | ContentBlock[];
    role?: string;
    /** Resolved model name from API response (e.g., "claude-sonnet-4-5-20250929") */
    model?: string;
  };
  // DAG structure
  parentUuid?: string | null;
  parent_tool_use_id?: string;
  // Message origin flags
  isSynthetic?: boolean;
  isReplay?: boolean;
  userType?: string;
  // Tool use related
  tool_use_id?: string;
  tool_name?: string;
  tool_input?: unknown;
  toolUseResult?: unknown;
  // Input requests (tool approval, questions, etc.)
  input_request?: {
    id: string;
    type: "tool-approval" | "question" | "choice";
    prompt: string;
    options?: string[];
  };
  // Result metadata
  duration_ms?: number;
  duration_api_ms?: number;
  total_cost_usd?: number;
  usage?: unknown;
  modelUsage?: unknown;
  num_turns?: number;
  // Error info
  error?: unknown;
  // Allow any additional fields from SDK
  [key: string]: unknown;
}

export type TimestampedSDKMessage<T extends SDKMessage = SDKMessage> = T & {
  timestamp: string;
};

export interface UserMessage {
  text: string;
  images?: string[]; // base64 or file paths
  documents?: string[];
  /** File attachments with paths for agent to access via Read tool */
  attachments?: UploadedFile[];
  mode?: PermissionMode;
  /** UUID to use for this message. If not provided, SDK will generate one. */
  uuid?: string;
  /** Client-generated temp ID for optimistic UI tracking. Echoed back in SSE. */
  tempId?: string;
}

/**
 * Provider-neutral wire representation of a queued user message.
 *
 * This used to reuse the Claude Agent SDK type even though OpenCode is the
 * only remaining runtime consumer. Keeping it local prevents a provider
 * dependency from leaking into the shared message queue.
 */
export interface QueuedUserMessage {
  type: "user";
  uuid?: string;
  /**
   * Structured uploads retained for providers with native file-part support.
   * MessageQueue only includes this field when explicitly configured so SDKs
   * that validate their input shape do not receive provider-specific metadata.
   */
  attachments?: UploadedFile[];
  message: {
    role: "user";
    content:
      | string
      | Array<
          | { type: "text"; text: string }
          | {
              type: "image";
              source: {
                type: "base64";
                media_type: string;
                data: string;
              };
            }
        >;
  };
}

export interface SDKSessionOptions {
  cwd: string;
  resume?: string; // session ID to resume
}

// Legacy interface for mock SDK compatibility
export interface ClaudeSDK {
  startSession(options: SDKSessionOptions): AsyncIterableIterator<SDKMessage>;
}

/** Provider-neutral result returned by a user tool-approval decision. */
export interface ToolApprovalResult {
  behavior: "allow" | "deny";
  updatedInput?: unknown;
  message?: string;
  /** Whether denial should interrupt the current turn. */
  interrupt?: boolean;
  /**
   * Persistence scope of an approval. "always" asks the provider to remember
   * the grant (OpenCode replies `always`, persisting the permission pattern).
   * Absent/"once" applies to this request only.
   */
  approvalScope?: "once" | "always";
}

export type CanUseTool = (
  toolName: string,
  input: unknown,
  options: {
    signal: AbortSignal;
    /** Provider-native request id, when the provider exposes one. */
    requestId?: string;
    /**
     * The provider already applied its native permission policy and still
     * decided this request needs a human. Skip Yep's mode-based auto-approval
     * while continuing to honor explicit allow/deny rules.
     */
    respectProviderDecision?: boolean;
  },
) => Promise<ToolApprovalResult>;
