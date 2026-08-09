import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InteractionOperation } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { FeishuBindingStore } from "../../src/channels/feishu/binding-store.js";
import { FeishuDurableInbox } from "../../src/channels/feishu/inbox.js";
import { FeishuOperationStore } from "../../src/channels/feishu/operation-store.js";
import { FeishuChannelService } from "../../src/channels/feishu/service.js";
import { createFeishuChannelRoutes } from "../../src/routes/feishu-channel.js";
import { MockClaudeSDK } from "../../src/sdk/mock.js";

describe("Feishu channel routes", () => {
  const dataDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      dataDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("uses a write-only secret endpoint and never returns its reference or value", async () => {
    const dataDir = await createDataDir(dataDirs);
    const service = new FeishuChannelService({ dataDir });
    await service.initialize();
    const routes = createFeishuChannelRoutes({ feishuChannelService: service });

    const accountResponse = await routes.request("/accounts/team-bot", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Team Bot",
        enabled: true,
        appId: "cli_0123456789abcdef",
        allowedUsers: ["user-fixture"],
      }),
    });
    expect(accountResponse.status).toBe(200);

    const secretResponse = await routes.request("/accounts/team-bot/secret", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appSecret: "never-return-this-secret" }),
    });
    const secretBody = await secretResponse.text();
    expect(secretResponse.status).toBe(200);
    expect(secretBody).not.toContain("never-return-this-secret");
    expect(secretBody).not.toContain("secretRef");
    expect(JSON.parse(secretBody)).toMatchObject({
      account: { secret: { configured: true, masked: "****cret" } },
    });

    const listBody = await (await routes.request("/accounts")).text();
    expect(listBody).not.toContain("never-return-this-secret");
    expect(listBody).not.toContain("secretRef");
  });

  it("rejects credentials embedded in ordinary account settings", async () => {
    const dataDir = await createDataDir(dataDirs);
    const service = new FeishuChannelService({ dataDir });
    await service.initialize();
    const routes = createFeishuChannelRoutes({ feishuChannelService: service });

    const response = await routes.request("/accounts/team-bot", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Team Bot",
        enabled: true,
        appId: "cli_0123456789abcdef",
        appSecret: "wrong-place",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "use_secret_endpoint",
    });
  });

  it("preserves an existing environment secret reference on settings updates", async () => {
    const dataDir = await createDataDir(dataDirs);
    const service = new FeishuChannelService({ dataDir });
    await service.initialize();
    await service.upsertAccount({
      id: "team-bot",
      name: "Team Bot",
      enabled: false,
      domain: "feishu",
      appId: "cli_0123456789abcdef",
      secretRef: "env:FEISHU_TEAM_BOT_SECRET",
      allowedWorkspaceRoots: [],
      allowedUsers: ["user-fixture"],
      adminUsers: [],
      allowedChats: [],
      requireMentionInGroup: true,
      groupSessionMode: "thread-when-available",
      defaultProvider: "codex",
      defaultPermissionMode: "default",
      replyMode: "card",
    });
    const routes = createFeishuChannelRoutes({ feishuChannelService: service });

    const response = await routes.request("/accounts/team-bot", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Renamed Bot",
        enabled: false,
        appId: "cli_0123456789abcdef",
        allowedUsers: ["user-fixture"],
      }),
    });

    expect(response.status).toBe(200);
    expect(service.getAccountSecretRef("team-bot")).toBe(
      "env:FEISHU_TEAM_BOT_SECRET",
    );
    expect(await response.text()).not.toContain("FEISHU_TEAM_BOT_SECRET");
  });

  it("keeps doctor available after store initialization failure", async () => {
    const dataDir = await createDataDir(dataDirs);
    const service = new FeishuChannelService({
      dataDir,
      configStore: {
        initialize: async () => {
          throw new Error("sensitive parse details");
        },
      } as never,
    });
    await service.initialize();
    const routes = createFeishuChannelRoutes({ feishuChannelService: service });

    const doctor = await routes.request("/doctor");
    expect(doctor.status).toBe(200);
    await expect(doctor.json()).resolves.toEqual({
      ok: false,
      initializationErrorCode: "STORE_INITIALIZATION_FAILED",
      accounts: [],
    });
    expect((await routes.request("/accounts")).status).toBe(503);
  });

  it("fails closed when adapter persistence or recovery is not ready", async () => {
    const dataDir = await createDataDir(dataDirs);
    const service = new FeishuChannelService({ dataDir });
    await service.initialize();
    const routes = createFeishuChannelRoutes({
      feishuChannelService: service,
      isChannelReady: () => false,
    });

    expect((await routes.request("/doctor")).status).toBe(200);
    expect((await routes.request("/diagnostics")).status).toBe(200);
    expect((await routes.request("/accounts")).status).toBe(503);
    expect(
      (
        await routes.request("/accounts/account-fixture", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "Fixture",
            appId: "cli_0123456789abcdef",
          }),
        })
      ).status,
    ).toBe(503);
  });

  it("lists and removes persisted scope bindings", async () => {
    const dataDir = await createDataDir(dataDirs);
    const service = new FeishuChannelService({ dataDir });
    const bindingStore = new FeishuBindingStore({ dataDir });
    await Promise.all([service.initialize(), bindingStore.initialize()]);
    const now = new Date().toISOString();
    await bindingStore.upsert({
      version: 1,
      scopeKey: "team-bot:p2p:chat-fixture",
      accountId: "team-bot",
      chatId: "chat-fixture",
      projectId: "project-fixture",
      projectPath: "/opt/yep-fixtures/project",
      sessionId: "session-fixture",
      provider: "codex",
      createdAt: now,
      updatedAt: now,
    });
    const routes = createFeishuChannelRoutes({
      feishuChannelService: service,
      bindingStore,
    });

    await expect(
      (await routes.request("/bindings")).json(),
    ).resolves.toMatchObject({
      bindings: [{ scopeKey: "team-bot:p2p:chat-fixture" }],
    });
    const removed = await routes.request(
      "/bindings/team-bot%3Ap2p%3Achat-fixture",
      { method: "DELETE" },
    );
    expect(removed.status).toBe(200);
    expect(bindingStore.list()).toEqual([]);
  });

  it("exposes account permissions and lifecycle controls", async () => {
    const dataDir = await createDataDir(dataDirs);
    const service = new FeishuChannelService({ dataDir });
    await service.initialize();
    const routes = createFeishuChannelRoutes({ feishuChannelService: service });
    await routes.request("/accounts/team-bot", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Team Bot",
        enabled: true,
        appId: "cli_0123456789abcdef",
        allowedUsers: ["user-fixture"],
      }),
    });

    const permissions = await (
      await routes.request("/accounts/team-bot/permissions")
    ).json();
    expect(permissions).toMatchObject({
      accountId: "team-bot",
      events: [
        "im.message.receive_v1",
        "im.message.recalled_v1",
        "im.message.reaction.created_v1",
        "im.message.reaction.deleted_v1",
      ],
      callbacks: ["card.action.trigger"],
    });
    expect(JSON.stringify(permissions)).toContain("cardkit:card:write");
    expect(JSON.stringify(permissions)).toContain("im:message.group_msg");
    expect(
      (await routes.request("/accounts/team-bot/test", { method: "POST" }))
        .status,
    ).toBe(200);
    expect(
      (
        await routes.request("/accounts/team-bot/reconnect", {
          method: "POST",
        })
      ).status,
    ).toBe(200);
  });

  it("exports aggregate diagnostics without credentials or message identity", async () => {
    const dataDir = await createDataDir(dataDirs);
    const service = new FeishuChannelService({ dataDir });
    const bindingStore = new FeishuBindingStore({ dataDir });
    const inbox = new FeishuDurableInbox({ dataDir });
    const operationStore = new FeishuOperationStore({ dataDir });
    await Promise.all([
      service.initialize(),
      bindingStore.initialize(),
      inbox.initialize(),
      operationStore.initialize(),
    ]);
    await service.upsertAccount({
      id: "team-bot",
      name: "Sensitive Bot Name",
      enabled: false,
      domain: "feishu",
      appId: "cli_0123456789abcdef",
      secretRef: "store:team-bot",
      allowedWorkspaceRoots: ["/opt/yep-fixtures/private-workspace"],
      allowedUsers: ["sensitive-user-fixture"],
      adminUsers: [],
      allowedChats: ["sensitive-chat-fixture"],
      requireMentionInGroup: true,
      groupSessionMode: "thread-when-available",
      defaultProvider: "codex",
      defaultPermissionMode: "default",
      replyMode: "card",
    });
    await service.setSecret("team-bot", "never-export-this-secret");
    const now = new Date("2026-08-07T01:00:00.000Z");
    await bindingStore.upsert({
      version: 1,
      scopeKey: "team-bot:p2p:sensitive-chat-fixture",
      accountId: "team-bot",
      chatId: "sensitive-chat-fixture",
      projectId: "project-fixture",
      projectPath: "/opt/yep-fixtures/private-workspace",
      sessionId: "sensitive-session-fixture",
      provider: "codex",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    await inbox.receive({
      accountId: "team-bot",
      eventId: "sensitive-event-fixture",
      eventType: "im.message.receive_v1",
      messageId: "sensitive-message-fixture",
      now,
    });
    await operationStore.upsert({
      operation: makeOperation(now),
      accountId: "team-bot",
      chatId: "sensitive-chat-fixture",
      replyToMessageId: "sensitive-message-fixture",
      sessionId: "sensitive-session-fixture",
      requestId: "sensitive-request-fixture",
      providerRequestId: "sensitive-provider-request-fixture",
      requestType: "tool-approval",
      requesterOpenId: "sensitive-user-fixture",
      allowedOperatorOpenIds: ["sensitive-admin-fixture"],
      now,
    });
    const routes = createFeishuChannelRoutes({
      feishuChannelService: service,
      bindingStore,
      inbox,
      operationStore,
    });

    const response = await routes.request("/diagnostics");
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(body)).toMatchObject({
      version: 1,
      operational: true,
      persistence: {
        bindings: { total: 1, byAccount: { "team-bot": 1 } },
        inbox: { total: 1, byAccount: { "team-bot": 1 } },
        operations: { total: 1, byAccount: { "team-bot": 1 } },
      },
    });
    for (const sensitive of [
      "never-export-this-secret",
      "secretRef",
      "cli_0123456789abcdef",
      "Sensitive Bot Name",
      "/opt/yep-fixtures/private-workspace",
      "sensitive-user-fixture",
      "sensitive-chat-fixture",
      "sensitive-session-fixture",
      "sensitive-message-fixture",
      "sensitive-request-fixture",
    ]) {
      expect(body).not.toContain(sensitive);
    }
  });

  it("mounts protected controls and passes the opaque inbox resolver through createApp", async () => {
    const dataDir = await createDataDir(dataDirs);
    const service = new FeishuChannelService({ dataDir });
    const inbox = new FeishuDurableInbox({ dataDir });
    await Promise.all([service.initialize(), inbox.initialize()]);
    const findByTempId = vi.spyOn(inbox, "findByTempId");
    const { app } = createApp({
      sdk: new MockClaudeSDK(),
      projectsDir: join(dataDir, "projects"),
      dataDir,
      feishuChannelService: service,
      feishuInbox: inbox,
    });

    const doctor = await app.request("/api/channels/feishu/doctor");
    expect(doctor.status).toBe(200);

    const unknownReference = "feishu-ffffffffffffffffffffffffffffffff";
    const locate = await app.request(
      `/api/sessions/${unknownReference}/locate`,
    );
    expect(locate.status).toBe(404);
    expect(findByTempId).toHaveBeenCalledWith(unknownReference);
  });
});

function makeOperation(now: Date): InteractionOperation {
  return {
    operationId: "int_00000000-0000-4000-8000-000000000001",
    provider: "codex",
    requestId: "sensitive-request-fixture",
    requestMethod: "item/commandExecution/requestApproval",
    sessionId: "sensitive-session-fixture",
    kind: "command_approval",
    state: "open",
    publicPayload: { prompt: "Allow the fixture command?" },
    allowedActors: { mode: "requester_or_admin" },
    allowedDecisions: [{ id: "approve", scope: "once" }, { id: "deny" }],
    createdAt: now.getTime(),
    version: 0,
  };
}

async function createDataDir(dataDirs: string[]): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-feishu-routes-"));
  dataDirs.push(dataDir);
  return dataDir;
}
