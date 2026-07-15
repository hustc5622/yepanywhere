import type { AgentActivity, PendingInputType } from "@yep-anywhere/shared";
import type { SessionOwnership } from "../supervisor/types.js";
import type { BridgeSessionView } from "./types.js";

/**
 * Whether runtime state observed by a bridge counts as "live" activity:
 * mid-turn, waiting for input, or holding a pending input request.
 */
export function hasLiveBridgeActivity(state: {
  activity?: AgentActivity;
  pendingInputType?: PendingInputType;
}): boolean {
  return (
    state.activity === "in-turn" ||
    state.activity === "waiting-input" ||
    Boolean(state.pendingInputType)
  );
}

export function isLiveBridgeSessionView(
  view: Pick<BridgeSessionView, "session" | "activity" | "pendingInputType">,
): boolean {
  if (view.session.ownership.owner === "external") return true;
  return hasLiveBridgeActivity(view);
}

export function bridgeOwnership(isLive: boolean): SessionOwnership {
  return isLive ? { owner: "external" } : { owner: "none" };
}
