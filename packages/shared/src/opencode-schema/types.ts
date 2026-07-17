/**
 * Type-only exports for OpenCode schema.
 * Import from here to avoid pulling in Zod runtime.
 */

// SSE event types
export type {
  OpenCodeSessionStatus,
  OpenCodeTokens,
  OpenCodeTime,
  OpenCodePart,
  OpenCodeMessageInfo,
  OpenCodeSessionInfo,
  OpenCodeServerConnectedEvent,
  OpenCodeSessionCreatedEvent,
  OpenCodeSessionStatusEvent,
  OpenCodeSessionUpdatedEvent,
  OpenCodeSessionIdleEvent,
  OpenCodeSessionDiffEvent,
  OpenCodeMessageUpdatedEvent,
  OpenCodeMessagePartUpdatedEvent,
  OpenCodeMessagePartDeltaEvent,
  OpenCodeSSEEvent,
} from "./events.js";

// Session storage types
export type {
  OpenCodeProject,
  OpenCodeSession,
  OpenCodeMessage,
  OpenCodeStoredPart,
  OpenCodeSessionEntry,
  OpenCodeSessionContent,
} from "./session.js";
