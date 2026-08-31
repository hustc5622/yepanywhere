/**
 * Notifications whose payload is already represented by a later item/turn
 * snapshot or by the native Codex rollout. These must always stay on the wire,
 * but no journal ever needs their content.
 *
 * This lives in `codex-events` rather than in the bridge because both journal
 * writers now consult it: the 4510 bridge through its `lifecycle` mode, and the
 * provider ingress through `shouldJournalCodexEvent`. Keeping one set prevents
 * the two writers from drifting into different retention.
 */
export const CODEX_EVENT_DELTA_METHODS = new Set<string>([
  "command/exec/outputDelta",
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/mcpToolCall/progress",
  "item/plan/delta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "process/outputDelta",
  "thread/realtime/outputAudio/delta",
  "thread/realtime/item/transcript/delta",
  "thread/realtime/transcript/delta",
  "turn/diff/updated",
]);
