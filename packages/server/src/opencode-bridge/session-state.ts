import {
  hasLiveBridgeActivity as hasLiveOpenCodeBridgeActivity,
  isLiveBridgeSessionView as isLiveOpenCodeBridgeSessionView,
  bridgeOwnership as opencodeBridgeOwnership,
} from "../bridge-common/session-state.js";
import type { OpenCodeBridgeSession } from "./types.js";

export {
  hasLiveOpenCodeBridgeActivity,
  isLiveOpenCodeBridgeSessionView,
  opencodeBridgeOwnership,
};

/**
 * An opencode bridge session is live while the CLI reports it active or the
 * bridge observed live runtime activity.
 */
export function isLiveOpenCodeBridgeSession(
  session: Pick<
    OpenCodeBridgeSession,
    "active" | "activity" | "pendingInputType"
  >,
): boolean {
  return (
    session.active ||
    hasLiveOpenCodeBridgeActivity({
      activity: session.activity,
      pendingInputType: session.pendingInputType,
    })
  );
}
