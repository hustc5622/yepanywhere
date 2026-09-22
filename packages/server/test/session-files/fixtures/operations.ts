import type { SessionFileOperation } from "@yep-anywhere/shared";

export function operation(
  overrides: Partial<SessionFileOperation> = {},
): SessionFileOperation {
  return {
    schemaVersion: 1,
    identity: {
      provider: "codex",
      sourceId: "local",
      sessionId: "s",
      turnId: "t",
      toolCallId: "call",
    },
    workspace: "/project",
    branchId: "s",
    messageId: "message",
    timestamp: "2026-09-21T00:00:00Z",
    order: 1,
    toolName: "apply_patch",
    source: "native-file-event",
    outcome: "applied",
    resultId: "result",
    changes: [
      {
        path: "report.md",
        kind: "added",
        outcome: "applied",
        before: null,
        patch: {
          format: "unified",
          complete: true,
          text: "--- /dev/null\n+++ report.md\n@@ -0,0 +1,2 @@\n+first\n+second\n",
        },
      },
    ],
    ...overrides,
  };
}

// A historical wrapper is not itself a successful child file operation.
export const nestedPatchCandidate = {
  type: "custom_tool_call",
  name: "exec",
  call_id: "outer",
  input:
    'text(await tools.apply_patch("*** Begin Patch\\n*** Add File: report.md\\n+first\\n*** End Patch"));',
};
export const nestedPatchOuterResult = {
  type: "custom_tool_call_output",
  call_id: "outer",
  output: "Script completed\nOutput:\n{}",
};
