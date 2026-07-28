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

/**
 * The sidecar's liveness verdict for a session view, i.e. the answer a
 * `GET /sessions/:id/active` round-trip would have produced.
 *
 * Prefer this over `isLiveBridgeSessionView` whenever the question is "is this
 * session actually live right now" for a *list* of views: the bulk
 * `/session-views` snapshot carries the verdict per entry, so no per-session
 * request is needed. Falls back to the activity-derived approximation for
 * sidecars old enough to omit the field.
 */
export function isActiveBridgeSessionView(
  view: Pick<
    BridgeSessionView,
    "session" | "activity" | "pendingInputType" | "active"
  >,
): boolean {
  return view.active ?? isLiveBridgeSessionView(view);
}

export function bridgeOwnership(isLive: boolean): SessionOwnership {
  return isLive ? { owner: "external" } : { owner: "none" };
}
