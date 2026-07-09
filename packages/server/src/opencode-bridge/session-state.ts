import type { AgentActivity, PendingInputType } from "@yep-anywhere/shared";
import type { SessionOwnership } from "../supervisor/types.js";
import type {
  OpenCodeBridgeSession,
  OpenCodeBridgeSessionView,
} from "./types.js";

export function hasLiveOpenCodeBridgeActivity(state: {
  activity?: AgentActivity;
  pendingInputType?: PendingInputType;
}): boolean {
  return (
    state.activity === "in-turn" ||
    state.activity === "waiting-input" ||
    Boolean(state.pendingInputType)
  );
}

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

export function isLiveOpenCodeBridgeSessionView(
  view: Pick<
    OpenCodeBridgeSessionView,
    "session" | "activity" | "pendingInputType"
  >,
): boolean {
  if (view.session.ownership.owner === "external") return true;
  return hasLiveOpenCodeBridgeActivity(view);
}

export function opencodeBridgeOwnership(isLive: boolean): SessionOwnership {
  return isLive ? { owner: "external" } : { owner: "none" };
}
