import { describe, expect, it } from "vitest";
import {
  buildCodexInteractiveResponse,
  buildCodexPendingInputId,
  toCodexInteractiveRequestView,
} from "../../src/codex-bridge/interactions.js";

describe("Codex bridge interactive protocol", () => {
  it("preserves request_user_input question metadata and Codex answer encoding", () => {
    const params = {
      threadId: "thread-question",
      turnId: "turn-question",
      itemId: "item-question",
      autoResolutionMs: 60_000,
      questions: [
        {
          id: "scope",
          header: "Scope",
          question: "Which scope should be used?",
          isOther: true,
          isSecret: false,
          options: [
            { label: "Workspace", description: "Only this workspace" },
            { label: "Global", description: "All workspaces" },
          ],
        },
        {
          id: "token",
          header: "Token",
          question: "Enter the temporary token",
          isOther: true,
          isSecret: true,
          options: null,
        },
      ],
    };

    const view = toCodexInteractiveRequestView(
      "pending-question",
      "item/tool/requestUserInput",
      params.threadId,
      params,
      "2026-07-15T00:00:00.000Z",
    );

    expect(view).toMatchObject({
      pendingInputType: "user-question",
      inputRequest: {
        id: "pending-question",
        source: "codex-bridge",
        type: "question",
        toolInput: {
          allowPartialSubmission: true,
          autoResolutionMs: 60_000,
          threadId: "thread-question",
          turnId: "turn-question",
          itemId: "item-question",
          questions: [
            {
              id: "scope",
              header: "Scope",
              question: "Which scope should be used?",
              options: [
                {
                  label: "Workspace",
                  description: "Only this workspace",
                  value: "Workspace",
                },
                {
                  label: "Global",
                  description: "All workspaces",
                  value: "Global",
                },
              ],
              custom: true,
              required: true,
            },
            {
              id: "token",
              inputType: "password",
              options: [],
            },
          ],
        },
      },
    });

    expect(
      buildCodexInteractiveResponse(
        "item/tool/requestUserInput",
        params,
        "approve",
        { scope: "Workspace", token: "secret-value" },
      ),
    ).toEqual({
      answers: {
        scope: { answers: ["Workspace"] },
        token: { answers: ["user_note: secret-value"] },
      },
    });
    expect(
      buildCodexInteractiveResponse(
        "item/tool/requestUserInput",
        params,
        "approve",
        {},
      ),
    ).toEqual({ answers: {} });
  });

  it("maps MCP forms to typed questions and returns the latest elicitation response", () => {
    const params = {
      threadId: "thread-form",
      turnId: "turn-form",
      serverName: "deploy-tools",
      mode: "form",
      message: "Configure deployment",
      requestedSchema: {
        type: "object",
        required: ["environment", "replicas"],
        properties: {
          environment: {
            type: "string",
            title: "Environment",
            description: "Deployment target",
            oneOf: [
              { const: "staging", title: "Staging" },
              { const: "production", title: "Production" },
            ],
          },
          replicas: {
            type: "integer",
            title: "Replicas",
            default: 2,
          },
          notify: {
            type: "boolean",
            title: "Notify team",
          },
          reviewers: {
            type: "array",
            title: "Reviewers",
            items: { type: "string", enum: ["alice", "bob"] },
          },
        },
      },
    };

    const view = toCodexInteractiveRequestView(
      "pending-form",
      "mcpServer/elicitation/request",
      params.threadId,
      params,
      "2026-07-15T00:00:00.000Z",
    );

    expect(view).toMatchObject({
      pendingInputType: "user-question",
      inputRequest: {
        source: "codex-bridge",
        prompt: "Configure deployment",
        toolInput: {
          allowPartialSubmission: false,
          threadId: "thread-form",
          turnId: "turn-form",
          questions: [
            {
              id: "environment",
              required: true,
              options: [
                { label: "Staging", value: "staging" },
                { label: "Production", value: "production" },
              ],
            },
            {
              id: "replicas",
              inputType: "number",
              defaultValue: "2",
              required: true,
            },
            {
              id: "notify",
              required: false,
              options: [
                { label: "Yes", value: "true" },
                { label: "No", value: "false" },
              ],
            },
            {
              id: "reviewers",
              multiSelect: true,
              required: false,
            },
          ],
        },
      },
    });

    expect(
      buildCodexInteractiveResponse(
        "mcpServer/elicitation/request",
        params,
        "approve",
        {
          environment: "production",
          replicas: "3.8",
          notify: "true",
          reviewers: ["alice", "bob"],
        },
      ),
    ).toEqual({
      action: "accept",
      content: {
        environment: "production",
        replicas: 3,
        notify: true,
        reviewers: ["alice", "bob"],
      },
      _meta: null,
    });
    expect(
      buildCodexInteractiveResponse(
        "mcpServer/elicitation/request",
        params,
        "deny",
      ),
    ).toEqual({ action: "decline", content: null, _meta: null });
  });

  it("puts MCP tool approval persistence in _meta and exposes safe actions", () => {
    const approvalParams = {
      threadId: "thread-mcp",
      turnId: "turn-mcp",
      serverName: "chrome-devtools",
      mode: "form",
      message: 'Allow tool "new_page"?',
      requestedSchema: { type: "object", properties: {} },
      _meta: {
        codex_approval_kind: "mcp_tool_call",
        persist: ["session", "always"],
        tool_name: "new_page",
      },
    };
    expect(
      buildCodexInteractiveResponse(
        "mcpServer/elicitation/request",
        approvalParams,
        "approve_for_session",
      ),
    ).toEqual({
      action: "accept",
      content: null,
      _meta: { persist: "session" },
    });
    expect(
      buildCodexInteractiveResponse(
        "mcpServer/elicitation/request",
        approvalParams,
        "deny",
      ),
    ).toEqual({ action: "cancel", content: null, _meta: null });

    const urlView = toCodexInteractiveRequestView(
      "pending-url",
      "mcpServer/elicitation/request",
      "thread-mcp",
      {
        threadId: "thread-mcp",
        serverName: "accounts",
        mode: "url",
        message: "Sign in to continue",
        url: "https://example.com/login",
        elicitationId: "login-1",
      },
      "2026-07-15T00:00:00.000Z",
    );
    expect(urlView.inputRequest.toolInput).toMatchObject({
      approvalKind: "mcp_url_action",
      actionUrl: "https://example.com/login",
      elicitationId: "login-1",
    });

    const unsafeUrlView = toCodexInteractiveRequestView(
      "pending-unsafe-url",
      "mcpServer/elicitation/request",
      "thread-mcp",
      {
        threadId: "thread-mcp",
        serverName: "accounts",
        mode: "url",
        message: "Open local file",
        url: "file:///tmp/secret",
        elicitationId: "file-1",
      },
      "2026-07-15T00:00:00.000Z",
    );
    expect(unsafeUrlView.inputRequest.toolInput).not.toHaveProperty(
      "actionUrl",
    );
  });

  it("preserves Codex permission grant scopes and strict auto review", () => {
    const params = {
      threadId: "thread-permissions",
      turnId: "turn-permissions",
      itemId: "item-permissions",
      cwd: "/workspace",
      permissions: {
        network: { enabled: true },
        fileSystem: { read: ["/workspace"], write: ["/workspace/tmp"] },
      },
    };

    expect(
      buildCodexInteractiveResponse(
        "item/permissions/requestApproval",
        params,
        "approve_strict_auto_review",
      ),
    ).toEqual({
      permissions: params.permissions,
      scope: "turn",
      strictAutoReview: true,
    });
    expect(
      buildCodexInteractiveResponse(
        "item/permissions/requestApproval",
        params,
        "approve_for_session",
      ),
    ).toEqual({
      permissions: params.permissions,
      scope: "session",
    });
    expect(
      buildCodexInteractiveResponse(
        "item/permissions/requestApproval",
        params,
        "approve_always",
      ),
    ).toEqual({
      permissions: params.permissions,
      scope: "session",
    });
  });

  it.each(["approve_for_session", "approve_always"] as const)(
    "maps command %s to an offered acceptForSession decision",
    (response) => {
      expect(
        buildCodexInteractiveResponse(
          "item/commandExecution/requestApproval",
          {
            availableDecisions: ["accept", "acceptForSession", "cancel"],
          },
          response,
        ),
      ).toEqual({ decision: "acceptForSession" });
    },
  );

  it.each([
    [
      "approve_for_session",
      {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: ["git", "status"],
        },
      },
      "acceptForSession",
    ],
    [
      "approve_always",
      {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: ["git", "status"],
        },
      },
      {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: ["git", "status"],
        },
      },
    ],
    [
      "approve_for_session",
      {
        applyNetworkPolicyAmendment: {
          network_policy_amendment: {
            host: "example.com",
            action: "allow",
          },
        },
      },
      "acceptForSession",
    ],
    [
      "approve_always",
      {
        applyNetworkPolicyAmendment: {
          network_policy_amendment: {
            host: "example.com",
            action: "allow",
          },
        },
      },
      {
        applyNetworkPolicyAmendment: {
          network_policy_amendment: {
            host: "example.com",
            action: "allow",
          },
        },
      },
    ],
  ] as const)(
    "keeps command %s distinct when a structured amendment is offered",
    (response, offeredDecision, expectedDecision) => {
      expect(
        buildCodexInteractiveResponse(
          "item/commandExecution/requestApproval",
          {
            availableDecisions: [
              "accept",
              "acceptForSession",
              offeredDecision,
              "cancel",
            ],
            proposedExecpolicyAmendment: ["must", "not", "be", "inferred"],
          },
          response,
        ),
      ).toEqual({ decision: expectedDecision });
    },
  );

  it("does not infer command persistence from proposed amendments", () => {
    for (const availableDecisions of [undefined, ["accept", "cancel"]]) {
      expect(
        buildCodexInteractiveResponse(
          "item/commandExecution/requestApproval",
          {
            availableDecisions,
            proposedExecpolicyAmendment: ["git", "status"],
            proposedNetworkPolicyAmendments: [
              { host: "example.com", action: "allow" },
            ],
          },
          "approve_always",
        ),
      ).toEqual({ decision: "accept" });
    }
  });

  it.each(["approve_for_session", "approve_always"] as const)(
    "maps file %s to acceptForSession",
    (response) => {
      expect(
        buildCodexInteractiveResponse(
          "item/fileChange/requestApproval",
          {},
          response,
        ),
      ).toEqual({ decision: "acceptForSession" });
    },
  );

  it("maps deny to decline because the bridge has no cancel variant", () => {
    expect(
      buildCodexInteractiveResponse(
        "item/commandExecution/requestApproval",
        { availableDecisions: ["decline", "cancel"] },
        "deny",
      ),
    ).toEqual({ decision: "decline" });
    expect(
      buildCodexInteractiveResponse(
        "item/fileChange/requestApproval",
        {},
        "deny",
      ),
    ).toEqual({ decision: "decline" });
  });

  it("includes connection identity in pending IDs", () => {
    const message = {
      id: "approval-1",
      method: "item/fileChange/requestApproval",
    };
    const params = {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
    };
    expect(buildCodexPendingInputId(1, message, "thread-1", params)).not.toBe(
      buildCodexPendingInputId(2, message, "thread-1", params),
    );
  });
});
