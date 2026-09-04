import { describe, expect, it } from "vitest";
import {
  getToolApprovalPersistence,
  supportsToolApprovalFeedback,
} from "../src/tool-approval.js";

describe("tool approval projection", () => {
  it("keeps session and policy decisions semantically distinct", () => {
    expect(
      getToolApprovalPersistence({
        availableDecisions: [
          "accept",
          {
            acceptWithExecpolicyAmendment: {
              execpolicy_amendment: ["git", "status"],
            },
          },
        ],
      }),
    ).toEqual({ kind: "command-policy", response: "approve_always" });

    expect(
      getToolApprovalPersistence({
        availableDecisions: [
          "accept",
          {
            acceptWithExecpolicyAmendment: {
              execpolicy_amendment: ["git", "status"],
            },
          },
          "acceptForSession",
        ],
      }),
    ).toEqual({ kind: "session", response: "approve_for_session" });
  });

  it("only projects affirmative network policy amendments", () => {
    expect(
      getToolApprovalPersistence({
        availableDecisions: [
          {
            applyNetworkPolicyAmendment: {
              network_policy_amendment: {
                host: "example.com",
                action: "allow",
              },
            },
          },
        ],
      }),
    ).toEqual({ kind: "network-policy", response: "approve_always" });

    expect(
      getToolApprovalPersistence({
        availableDecisions: [
          {
            applyNetworkPolicyAmendment: {
              network_policy_amendment: {
                host: "example.com",
                action: "deny",
              },
            },
          },
        ],
      }),
    ).toBeUndefined();
  });

  it("supports stable-protocol amendment fields and legacy file grants", () => {
    expect(
      getToolApprovalPersistence({ proposedExecpolicyAmendment: ["rg"] }),
    ).toEqual({ kind: "command-policy", response: "approve_always" });
    expect(getToolApprovalPersistence({ approvalKind: "file_change" })).toEqual(
      { kind: "session", response: "approve_for_session" },
    );
    expect(
      getToolApprovalPersistence({
        availableDecisions: ["accept", "decline"],
        proposedExecpolicyAmendment: ["must", "not", "be", "inferred"],
      }),
    ).toBeUndefined();
  });

  it("matches deny-with-guidance eligibility across projections", () => {
    expect(
      supportsToolApprovalFeedback({ approvalKind: "command_execution" }),
    ).toBe(true);
    expect(supportsToolApprovalFeedback({ approvalKind: "permissions" })).toBe(
      false,
    );
    expect(
      supportsToolApprovalFeedback({
        approvalKind: "mcp_tool_call",
        persistScopes: ["session"],
      }),
    ).toBe(false);
    expect(
      supportsToolApprovalFeedback(
        { approvalKind: "command_execution" },
        "codex-bridge",
      ),
    ).toBe(false);
  });
});
