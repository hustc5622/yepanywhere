import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InputRequest } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeishuInteractionManager } from "../../../src/channels/feishu/interaction-manager.js";
import type { FeishuMessageApi } from "../../../src/channels/feishu/normalization/types.js";
import { FeishuOperationStore } from "../../../src/channels/feishu/operation-store.js";
import type { FeishuInteractionApi } from "../../../src/channels/feishu/outbound.js";
import { InteractionBroker } from "../../../src/interactions/InteractionBroker.js";
import type { SessionCommandService } from "../../../src/services/SessionCommandService.js";

describe("FeishuInteractionManager", () => {
  const fixtures: Awaited<ReturnType<typeof createFixture>>[] = [];

  afterEach(async () => {
    await Promise.all(
      fixtures.splice(0).map(async (fixture) => {
        await fixture.manager.shutdown();
        fixture.broker.shutdown();
        await rm(fixture.dataDir, { recursive: true, force: true });
      }),
    );
  });

  it("projects one card carrying only the central broker identity", async () => {
    const fixture = await createFixture(makeApproval());
    fixtures.push(fixture);

    await fixture.manager.projectPendingInput(fixture.context, fixture.request);
    await fixture.manager.projectPendingInput(fixture.context, fixture.request);

    expect(fixture.api.createInputCard).toHaveBeenCalledTimes(1);
    const card = JSON.stringify(fixture.api.createInputCard.mock.calls[0]?.[1]);
    expect(card).toContain(fixture.operation.operationId);
    expect(card).toContain('"operationVersion":0');
    expect(card).not.toContain("request-fixture");
    expect(card).not.toContain("session-fixture");
    expect(card).not.toContain("fixture command arguments");
    expect(fixture.store.listOpen()).toEqual([
      expect.objectContaining({
        brokerOperationId: fixture.operation.operationId,
        brokerVersion: 0,
        brokerState: "open",
        cardId: "card-fixture",
        cardMessageId: "card-message-fixture",
      }),
    ]);
  });

  it("rejects an unauthorized actor before reading pending input", async () => {
    const fixture = await createFixture(makeApproval());
    fixtures.push(fixture);
    await fixture.manager.projectPendingInput(fixture.context, fixture.request);
    fixture.commands.getPendingInput.mockClear();

    await expect(
      fixture.manager.acceptCardAction({
        accountId: "account-fixture",
        event: {
          ...makeAction(fixture.operation.operationId, 0, "deny"),
          operatorOpenId: "untrusted-fixture",
        },
        api: fixture.api,
      }),
    ).resolves.toBe("forbidden");
    expect(fixture.commands.getPendingInput).not.toHaveBeenCalled();
    expect(fixture.commands.respondToInput).not.toHaveBeenCalled();
    expect(fixture.providerResolver).not.toHaveBeenCalled();
  });

  it("lets the broker resolve two racing card callbacks at most once", async () => {
    const fixture = await createFixture(makeApproval());
    fixtures.push(fixture);
    await fixture.manager.projectPendingInput(fixture.context, fixture.request);
    const envelope = {
      accountId: "account-fixture",
      event: makeAction(fixture.operation.operationId, 0, "approve"),
      api: fixture.api,
    };

    await expect(
      Promise.all([
        fixture.manager.acceptCardAction(envelope),
        fixture.manager.acceptCardAction(envelope),
      ]),
    ).resolves.toEqual(["claimed", "claimed"]);

    await eventually(() => {
      expect(fixture.providerResolver).toHaveBeenCalledTimes(1);
      expect(fixture.broker.get(fixture.operation.operationId)?.state).toBe(
        "resolved",
      );
      expect(
        fixture.store.findByBrokerOperation(
          "account-fixture",
          fixture.operation.operationId,
        )?.brokerState,
      ).toBe("resolved");
    });
    expect(fixture.commands.respondToInput).toHaveBeenCalledTimes(2);
    expect(
      fixture.commands.respondToInput.mock.results.filter(
        (result) => result.type === "return",
      ),
    ).toHaveLength(2);

    await expect(fixture.manager.acceptCardAction(envelope)).resolves.toBe(
      "already_processed",
    );
    expect(fixture.providerResolver).toHaveBeenCalledTimes(1);
  });

  it("refreshes a stale card without invoking the provider", async () => {
    const fixture = await createFixture(makeApproval());
    fixtures.push(fixture);
    await fixture.manager.projectPendingInput(fixture.context, fixture.request);

    await expect(
      fixture.manager.acceptCardAction({
        accountId: "account-fixture",
        event: makeAction(fixture.operation.operationId, 99, "approve"),
        api: fixture.api,
      }),
    ).resolves.toBe("stale");
    expect(fixture.commands.respondToInput).not.toHaveBeenCalled();
    expect(fixture.providerResolver).not.toHaveBeenCalled();
    expect(fixture.api.updateInputCard).toHaveBeenCalledTimes(1);
  });

  it("maps structured question answers through the broker", async () => {
    const fixture = await createFixture(makeQuestion());
    fixtures.push(fixture);
    await fixture.manager.projectPendingInput(fixture.context, fixture.request);

    await expect(
      fixture.manager.acceptCardAction({
        accountId: "account-fixture",
        event: {
          ...makeAction(fixture.operation.operationId, 0, "submit"),
          formValue: { q_0: "1" },
        },
        api: fixture.api,
      }),
    ).resolves.toBe("claimed");
    await eventually(() =>
      expect(fixture.providerResolver).toHaveBeenCalledWith(
        expect.objectContaining({
          response: "approve",
          answers: { target: "production" },
        }),
      ),
    );
  });

  it("projects a broker-owned provider rejection as failed", async () => {
    const fixture = await createFixture(makeApproval(), {
      providerAccepted: false,
    });
    fixtures.push(fixture);
    await fixture.manager.projectPendingInput(fixture.context, fixture.request);

    await fixture.manager.acceptCardAction({
      accountId: "account-fixture",
      event: makeAction(fixture.operation.operationId, 0, "approve"),
      api: fixture.api,
    });
    await eventually(() => {
      expect(fixture.broker.get(fixture.operation.operationId)?.state).toBe(
        "failed",
      );
      expect(
        fixture.store.findByBrokerOperation(
          "account-fixture",
          fixture.operation.operationId,
        )?.brokerState,
      ).toBe("failed");
      expect(fixture.api.updateInputCard).toHaveBeenCalled();
    });
  });

  it("routes timeout resolution through the broker instead of local state", async () => {
    const fixture = await createFixture(makeApproval());
    fixtures.push(fixture);
    await fixture.manager.projectPendingInput(fixture.context, fixture.request);

    await expect(
      fixture.manager.terminateOpenOperations(
        {
          accountId: "account-fixture",
          sessionId: "session-fixture",
          api: fixture.api,
        },
        "timeout",
      ),
    ).resolves.toBe(1);
    expect(fixture.providerResolver).toHaveBeenCalledTimes(1);
    expect(fixture.providerResolver).toHaveBeenCalledWith(
      expect.objectContaining({ response: "deny" }),
    );
    expect(fixture.broker.get(fixture.operation.operationId)?.state).toBe(
      "expired",
    );
    expect(fixture.store.listOpen()).toEqual([]);
  });

  it("recovers a terminal broker snapshot and retries its card projection", async () => {
    const fixture = await createFixture(makeApproval());
    fixtures.push(fixture);
    await fixture.manager.projectPendingInput(fixture.context, fixture.request);
    await fixture.commands.respondToInput("session-fixture", {
      requestId: fixture.request.id,
      response: "deny",
      operationId: fixture.operation.operationId,
      operationVersion: 0,
      actor: { id: "yep-fixture", channel: "yep" },
    });
    fixture.api.updateInputCard.mockClear();

    const recovered = new FeishuInteractionManager({
      sessionCommandService:
        fixture.commands as unknown as SessionCommandService,
      operationStore: fixture.store,
    });
    await fixture.manager.shutdown();
    fixture.manager = recovered;
    await recovered.recover(() => ({
      api: fixture.api,
      adminUsers: ["admin-fixture"],
    }));

    expect(fixture.api.updateInputCard).toHaveBeenCalledTimes(1);
    expect(fixture.store.listTerminalAwaitingCardProjection()).toEqual([]);
  });

  it("replaces a persisted admin allowlist during recovery", async () => {
    const fixture = await createFixture(makeApproval());
    fixtures.push(fixture);
    fixture.context.allowedOperatorOpenIds = [
      "requester-fixture",
      "removed-admin-fixture",
    ];
    await fixture.manager.projectPendingInput(fixture.context, fixture.request);

    const recovered = new FeishuInteractionManager({
      sessionCommandService:
        fixture.commands as unknown as SessionCommandService,
      operationStore: fixture.store,
    });
    await fixture.manager.shutdown();
    fixture.manager = recovered;
    await recovered.recover(() => ({
      api: fixture.api,
      adminUsers: ["current-admin-fixture"],
    }));

    expect(fixture.store.listOpen()[0]?.allowedOperatorOpenIds).toEqual([
      "requester-fixture",
      "current-admin-fixture",
    ]);
  });
});

async function createFixture(
  requestInput: InputRequest,
  options: { providerAccepted?: boolean } = {},
) {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-feishu-manager-"));
  const store = new FeishuOperationStore({ dataDir });
  await store.initialize();
  const broker = new InteractionBroker();
  let pending: InputRequest | null = requestInput;
  const providerResolver = vi.fn(async () => {
    if (options.providerAccepted !== false) pending = null;
    return options.providerAccepted !== false;
  });
  const operation = await broker.register({
    request: requestInput,
    owner: "process",
    provider: "codex",
    resolveProvider: providerResolver,
  });
  const request = { ...requestInput, interaction: operation };

  const commands = {
    getPendingInput: vi.fn(async () => {
      if (!pending) return null;
      const live = broker.get(operation.operationId);
      return live ? { ...pending, interaction: live } : null;
    }),
    getInteractionOperation: vi.fn((operationId: string) =>
      broker.get(operationId),
    ),
    respondToInput: vi.fn(
      async (
        sessionId: string,
        body: {
          requestId: string;
          response: string;
          answers?: Record<string, string | string[]>;
          operationId: string;
          operationVersion: number;
          actor: {
            id: string;
            channel: "yep" | "feishu" | "provider" | "system";
          };
        },
        respondOptions?: { terminalReason?: "timeout" },
      ) => {
        const result = await broker.resolve({
          sessionId,
          requestId: body.requestId,
          operationId: body.operationId,
          expectedVersion: body.operationVersion,
          response: body.response,
          answers: body.answers,
          actor: body.actor,
          terminalReason: respondOptions?.terminalReason,
        });
        if (result.state === "resolved") {
          return {
            ok: true as const,
            status: 200 as const,
            body: { accepted: true, operation: result.operation },
          };
        }
        const operationResult = result.operation;
        if (result.state === "provider_rejected") {
          return {
            ok: false as const,
            status: 502 as const,
            body: {
              error: "Provider rejected",
              code: "interaction_provider_rejected",
              operation: operationResult,
            },
          };
        }
        return {
          ok: false as const,
          status: 409 as const,
          body: {
            error: "Interaction conflict",
            code:
              result.state === "stale"
                ? "interaction_stale_version"
                : "interaction_already_resolved",
            operation: operationResult,
          },
        };
      },
    ),
    terminateInteractionOperations: vi.fn(
      (
        sessionId: string,
        reason: "interrupt" | "process_exit" | "request_missing",
        keepRequestId?: string,
      ) =>
        broker.terminateSession(sessionId, reason, new Date(), keepRequestId),
    ),
  };
  const api = makeApi();
  const context = {
    accountId: "account-fixture",
    sessionId: "session-fixture",
    chatId: "chat-fixture",
    threadId: "thread-fixture",
    replyToMessageId: "source-message-fixture",
    requesterOpenId: "requester-fixture",
    allowedOperatorOpenIds: ["requester-fixture", "admin-fixture"],
    api,
  };
  return {
    request,
    dataDir,
    store,
    broker,
    providerResolver,
    commands,
    api,
    context,
    operation,
    manager: new FeishuInteractionManager({
      sessionCommandService: commands as unknown as SessionCommandService,
      operationStore: store,
    }),
  };
}

function makeApi(): FeishuMessageApi &
  FeishuInteractionApi & {
    createInputCard: ReturnType<typeof vi.fn>;
    updateInputCard: ReturnType<typeof vi.fn>;
  } {
  return {
    fetchMessageItems: vi.fn(async () => []),
    createInputCard: vi.fn(async () => ({
      cardId: "card-fixture",
      messageId: "card-message-fixture",
    })),
    updateInputCard: vi.fn(async () => undefined),
  };
}

function makeAction(
  operationId: string,
  operationVersion: number,
  action: string,
) {
  return {
    messageId: "card-message-fixture",
    chatId: "chat-fixture",
    operatorOpenId: "requester-fixture",
    actionTag: "button",
    value: {
      namespace: "yep-feishu",
      operationId,
      operationVersion,
      action,
    },
  };
}

function makeApproval(): InputRequest {
  return {
    id: "request-fixture",
    providerRequestId: "provider-request-fixture",
    sessionId: "session-fixture",
    type: "tool-approval",
    prompt: "Allow the fixture command?",
    toolName: "Bash",
    toolInput: {
      command: "fixture command arguments",
      availableDecisions: ["accept", "acceptForSession", "decline"],
    },
    timestamp: "2026-08-08T00:00:00.000Z",
  };
}

function makeQuestion(): InputRequest {
  return {
    id: "request-fixture",
    providerRequestId: "provider-request-fixture",
    sessionId: "session-fixture",
    type: "question",
    prompt: "Choose a target",
    toolInput: {
      questions: [
        {
          id: "target",
          question: "Target?",
          options: [
            { label: "Staging", value: "staging" },
            { label: "Production", value: "production" },
          ],
          required: true,
        },
      ],
    },
    timestamp: "2026-08-08T00:00:00.000Z",
  };
}

async function eventually(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 2_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}
