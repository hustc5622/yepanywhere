import {
  bridgeOwnership,
  hasLiveBridgeActivity,
  isLiveBridgeSessionView,
} from "../bridge-common/session-state.js";
import type { CodexBridgeSession } from "./types.js";

export { bridgeOwnership, hasLiveBridgeActivity, isLiveBridgeSessionView };

/** A codex bridge session is live while a TUI connection is attached. */
export function isLiveBridgeSession(
  session: Pick<CodexBridgeSession, "connectionIds">,
): boolean {
  return session.connectionIds.length > 0;
}
