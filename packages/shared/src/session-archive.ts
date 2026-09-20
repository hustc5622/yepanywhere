import type { AgentActivity, SessionArchiveBlockCode } from "./app-types.js";

/** The shared archive-block priority used by server state and live client updates. */
export function getSessionArchiveBlock(
  ownership: { owner: string },
  activity: AgentActivity | undefined,
): {
  archiveBlockCode?: SessionArchiveBlockCode;
  archiveBlockReason?: string;
} {
  if (activity === "waiting-input") {
    return {
      archiveBlockCode: "waiting_input",
      archiveBlockReason:
        "This session is waiting for input. Respond or stop it before archiving.",
    };
  }

  if (activity === "hold") {
    return {
      archiveBlockCode: "agent_on_hold",
      archiveBlockReason:
        "This session is on hold. Resume or stop it before archiving.",
    };
  }

  if (activity === "in-turn") {
    return {
      archiveBlockCode: "agent_in_turn",
      archiveBlockReason:
        "This session is currently running. Wait for it to finish or stop it before archiving.",
    };
  }

  if (ownership.owner === "external") {
    return {
      archiveBlockCode: "external_active",
      archiveBlockReason:
        "This session is controlled by an active external process. Wait for it to finish before archiving.",
    };
  }

  return {};
}
