import type { InputRequest } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import {
  buildFeishuInputCard,
  buildFeishuQuestionAnswers,
  buildFeishuResolvedInputCard,
  parseFeishuInputActionValue,
} from "../../../src/channels/feishu/input-request.js";

const OPERATION_ID = "int_01234567-89ab-cdef-0123-456789abcdef";
const OPERATION_IDENTITY = {
  operationId: OPERATION_ID,
  operationVersion: 0,
};

describe("Feishu input request projection", () => {
  it("accepts only complete central broker identities", () => {
    expect(
      parseFeishuInputActionValue({
        namespace: "yep-feishu",
        operationId: OPERATION_ID,
        operationVersion: 3,
        action: "approve",
      }),
    ).toMatchObject({ operationId: OPERATION_ID, operationVersion: 3 });
    expect(
      parseFeishuInputActionValue({
        namespace: "yep-feishu",
        operationId: "a".repeat(64),
        operationRevision: 0,
        action: "approve",
      }),
    ).toBeUndefined();
    expect(
      parseFeishuInputActionValue({
        namespace: "yep-feishu",
        operationId: OPERATION_ID,
        action: "approve",
      }),
    ).toBeUndefined();
  });

  it("renders approval actions without embedding request ids or tool inputs", () => {
    const request: InputRequest = {
      id: "secret-request-id",
      sessionId: "secret-session-id",
      type: "tool-approval",
      prompt: "Allow this command? <at id=all></at>",
      toolName: "Bash",
      toolInput: { command: "curl https://secret.example/token" },
      timestamp: new Date().toISOString(),
    };

    const serialized = JSON.stringify(
      buildFeishuInputCard(request, OPERATION_IDENTITY),
    );

    expect(serialized).toContain(OPERATION_ID);
    expect(serialized).toContain('"action":"approve"');
    expect(serialized).toContain('"action":"deny"');
    expect(serialized).not.toContain("approve_always");
    expect(serialized).not.toContain("secret-request-id");
    expect(serialized).not.toContain("secret-session-id");
    expect(serialized).not.toContain("secret.example");
    expect(serialized).not.toContain("<at");
  });

  it("does not render session approval when available decisions are non-persistent", () => {
    const request = makeApprovalRequest({
      availableDecisions: ["accept", "decline"],
    });

    const serialized = JSON.stringify(
      buildFeishuInputCard(request, OPERATION_IDENTITY),
    );

    expect(serialized).toContain('"action":"approve"');
    expect(serialized).toContain('"action":"deny"');
    expect(serialized).not.toContain("approve_always");
    expect(serialized).not.toContain("本 Session 允许");
  });

  it.each([
    [
      "acceptForSession",
      ["accept", "acceptForSession", "decline"],
      "本 Session 允许",
    ],
    [
      "execpolicy amendment",
      [
        "accept",
        {
          acceptWithExecpolicyAmendment: {
            execpolicy_amendment: ["git", "status"],
          },
        },
        "decline",
      ],
      "应用命令策略",
    ],
    [
      "network policy amendment",
      [
        "accept",
        {
          applyNetworkPolicyAmendment: {
            network_policy_amendment: {
              host: "example.com",
              action: "allow",
            },
          },
        },
        "decline",
      ],
      "应用网络策略",
    ],
  ])(
    "renders an exact label for an offered %s decision",
    (_, decisions, label) => {
      const request = makeApprovalRequest({ availableDecisions: decisions });

      const serialized = JSON.stringify(
        buildFeishuInputCard(request, OPERATION_IDENTITY),
      );

      expect(serialized).toContain('"action":"approve"');
      expect(serialized).toContain('"action":"approve_always"');
      expect(serialized).toContain('"action":"deny"');
      expect(serialized).toContain(label);
    },
  );

  it("keeps the resolved policy decision distinct from session approval", () => {
    const card = buildFeishuResolvedInputCard({
      requestType: "tool-approval",
      status: "completed",
      result: "approve_always",
      nativeDecision: {
        kind: "applyNetworkPolicyAmendment",
        scope: "policy",
      },
    });

    expect(JSON.stringify(card)).toContain("网络策略已应用");
    expect(JSON.stringify(card)).not.toContain("本 Session 已允许");
  });

  it("maps a form with single, multi and free-text questions to provider answers", () => {
    const request = makeQuestionRequest();
    const action = parseFeishuInputActionValue({
      namespace: "yep-feishu",
      operationId: OPERATION_ID,
      operationVersion: 0,
      action: "submit",
    });
    expect(action).toBeDefined();
    if (!action) throw new Error("Expected a valid form action");

    expect(
      buildFeishuQuestionAnswers(
        request,
        {
          formValue: {
            q_0: "1",
            q_1: ["0", "2"],
            q_2: "Use the safe path",
          },
        },
        action,
      ),
    ).toEqual({
      deployment: "production",
      checks: ["lint", "tests"],
      notes: "Use the safe path",
    });
  });

  it("maps a compact option button by index", () => {
    const request: InputRequest = {
      id: "choice-1",
      sessionId: "session-1",
      type: "choice",
      prompt: "Choose one",
      options: ["A", "B"],
      timestamp: new Date().toISOString(),
    };
    const action = parseFeishuInputActionValue({
      namespace: "yep-feishu",
      operationId: OPERATION_ID,
      operationVersion: 0,
      action: "answer",
      optionIndex: 1,
    });
    if (!action) throw new Error("Expected a valid answer action");

    expect(buildFeishuQuestionAnswers(request, {}, action)).toEqual({
      "choice-1": "B",
    });
  });
});

function makeApprovalRequest(toolInput: unknown): InputRequest {
  return {
    id: "approval-1",
    sessionId: "session-1",
    type: "tool-approval",
    prompt: "Allow this command?",
    toolName: "Bash",
    toolInput,
    timestamp: new Date(0).toISOString(),
  };
}

function makeQuestionRequest(): InputRequest {
  return {
    id: "question-1",
    sessionId: "session-1",
    type: "question",
    prompt: "Please answer",
    timestamp: new Date().toISOString(),
    toolInput: {
      questions: [
        {
          id: "deployment",
          question: "Target?",
          options: [
            { label: "Staging", value: "staging" },
            { label: "Production", value: "production" },
          ],
          multiSelect: false,
          required: true,
        },
        {
          id: "checks",
          question: "Checks?",
          options: [
            { label: "Lint", value: "lint" },
            { label: "Typecheck", value: "typecheck" },
            { label: "Tests", value: "tests" },
          ],
          multiSelect: true,
          required: true,
        },
        {
          id: "notes",
          question: "Notes?",
          options: [],
          multiSelect: false,
          required: true,
          inputType: "text",
        },
      ],
    },
  };
}
