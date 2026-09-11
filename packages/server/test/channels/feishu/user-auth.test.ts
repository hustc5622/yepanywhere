import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@larksuiteoapi/node-sdk";
import { FeishuAccountConfigSchema } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeishuChannelService } from "../../../src/channels/feishu/service.js";
import {
  FEISHU_MCP_TOOLS,
  FeishuMcpGateway,
} from "../../../src/channels/feishu/user-auth/mcp-gateway.js";
import {
  FeishuOAuthClient,
  FeishuOAuthError,
} from "../../../src/channels/feishu/user-auth/oauth-client.js";
import { FeishuUserAuthService } from "../../../src/channels/feishu/user-auth/service.js";
import { grantKey } from "../../../src/channels/feishu/user-auth/store.js";
import { resolveCodexMcpThreadProfile } from "../../../src/codex/mcp-profile.js";
import { createFeishuUserAuthRoutes } from "../../../src/routes/feishu-user-auth.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "yep-auth-test-"));
  roots.push(dir);
  let now = 1_800_000_000_000;
  const account = FeishuAccountConfigSchema.parse({
    id: "bot",
    name: "Bot",
    enabled: true,
    appId: "cli_0123456789abcdef",
    secretRef: "store:bot",
    allowedUsers: ["ou_user"],
    allowedWorkspaceRoots: [dir],
    userAuth: {
      enabled: true,
      redirectUri: "https://example.test/yep/api/auth/feishu/callback",
      scopes: ["offline_access", "contact:user.base:readonly"],
    },
  });
  let exchanges = 0;
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    if (String(input).endsWith("/user_info"))
      return Response.json({ code: 0, data: { open_id: "ou_user" } });
    exchanges++;
    return Response.json({
      code: 0,
      access_token: `access-${exchanges}`,
      refresh_token: `refresh-${exchanges}`,
      expires_in: 7200,
      refresh_token_expires_in: 604800,
      scope: "offline_access contact:user.base:readonly",
    });
  });
  const client = new FeishuOAuthClient(fetcher as typeof fetch, () => now);
  const options = {
    dataDir: dir,
    accounts: () => [account],
    secret: () => "test-secret",
    client,
    now: () => now,
  };
  const service = new FeishuUserAuthService(options);
  const authorize = async () => {
    const pending = await service.begin("bot", "ou_user");
    const state =
      new URL(pending.authorizationUrl ?? "").searchParams.get("state") ?? "";
    await service.complete(state, "test-code");
    return state;
  };
  return {
    dir,
    service,
    options,
    account,
    fetcher,
    client,
    authorize,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
    exchanges: () => exchanges,
  };
}
describe("Yep-owned Feishu user authorization", () => {
  it("honors a persisted stop after token resolution and before a write starts", async () => {
    const f = await fixture();
    await f.authorize();
    const original = f.service.accessToken.bind(f.service);
    vi.spyOn(f.service, "accessToken").mockImplementationOnce(
      async (...args) => {
        const token = await original(...args);
        await f.service.cancel("bot", "ou_user");
        return token;
      },
    );
    const business = vi.fn();
    const gateway = new FeishuMcpGateway({
      dataDir: f.dir,
      serverUrl: "http://localhost:3400",
      auth: f.service,
      secret: () => "secret",
      createClient: () => ({ request: business }) as unknown as Client,
    });
    const config = await gateway.connectorConfig("bot", "ou_user", f.dir);
    const { readFile } = await import("node:fs/promises");
    const binding = JSON.parse(await readFile(config.args[1] ?? "", "utf8"));
    const result = await gateway.call(binding.token, "lark_api", {
      method: "POST",
      path: "/open-apis/docx/v1/documents",
      body: { title: "Stopped" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? "")).toMatchObject({
      business_request_started: false,
      retry_safe: false,
    });
    expect(business).not.toHaveBeenCalled();
  });
  it("preserves the managed MCP across 4510 profiling and suppresses the old alias", () => {
    const result = resolveCodexMcpThreadProfile(
      "standard",
      {
        mcp_servers: {
          lark: { command: "old" },
          "feishu-mcp": { url: "https://example.test" },
        },
      },
      {
        mcp_servers: {
          "yep-feishu": {
            command: "node",
            args: [
              "/server/resources/feishu/connector.mjs",
              "/private/client.json",
            ],
            env: {},
            enabled: false,
          },
        },
      },
    );
    expect(result.threadConfig.mcp_servers["yep-feishu"]).toMatchObject({
      command: "node",
      enabled: false,
      env: {},
    });
    expect(result.threadConfig.mcp_servers.lark?.enabled).toBe(false);
    expect(result.threadConfig.mcp_servers["feishu-mcp"]?.enabled).toBe(false);
  });

  it("downloads a PDF through the native tool using the renewed user identity", async () => {
    const f = await fixture();
    await f.authorize();
    const key = grantKey(f.account.domain, f.account.appId, "ou_user");
    const record = await f.service.store.read(key);
    if (!record?.grant) throw new Error("fixture");
    record.grant.scopes.push("drive:file:download");
    await f.service.store.write(key, record);
    const download = vi.fn(async () => ({
      getReadableStream: async function* () {
        yield Buffer.from("%PDF-fixture");
      },
    }));
    const gateway = new FeishuMcpGateway({
      dataDir: f.dir,
      serverUrl: "http://localhost:3400",
      auth: f.service,
      secret: () => "secret",
      createClient: () =>
        ({ drive: { file: { download } } }) as unknown as Client,
    });
    const config = await gateway.connectorConfig("bot", "ou_user", f.dir);
    const { readFile } = await import("node:fs/promises");
    const binding = JSON.parse(await readFile(config.args[1] ?? "", "utf8"));
    const output = join(f.dir, "spec.pdf");
    const result = await gateway.call(binding.token, "lark_drive_file", {
      action: "download",
      file_token: "file123",
      output_path: output,
    });
    expect(result.isError).not.toBe(true);
    expect(await readFile(output, "utf8")).toBe("%PDF-fixture");
    expect(download).toHaveBeenCalledTimes(1);
    const cancelled = new AbortController();
    cancelled.abort();
    expect(
      (
        await gateway.call(
          binding.token,
          "lark_drive_file",
          { action: "download", file_token: "file123" },
          cancelled.signal,
        )
      ).isError,
    ).toBe(true);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("does not execute a business write before authorization, or repeatedly prompt after cancellation", async () => {
    const f = await fixture();
    const business = vi.fn();
    const gateway = new FeishuMcpGateway({
      dataDir: f.dir,
      serverUrl: "http://localhost:3400",
      auth: f.service,
      secret: () => "secret",
      createClient: () => ({ request: business }) as unknown as Client,
    });
    const config = await gateway.connectorConfig("bot", "ou_user", f.dir);
    const { readFile } = await import("node:fs/promises");
    const binding = JSON.parse(await readFile(config.args[1] ?? "", "utf8"));
    const args = {
      method: "POST",
      path: "/open-apis/docx/v1/documents",
      body: { title: "New document" },
    };
    const result = await gateway.call(binding.token, "lark_api", args);
    expect(JSON.parse(result.content[0]?.text ?? "").error_type).toBe(
      "user_auth_required",
    );
    await f.service.cancel("bot", "ou_user");
    const again = await gateway.call(binding.token, "lark_api", args);
    expect(JSON.parse(again.content[0]?.text ?? "").error_type).toBe(
      "authorization_cancelled",
    );
    expect(business).not.toHaveBeenCalled();
  });
  it("binds PKCE and the requesting user, consumes callbacks once", async () => {
    const f = await fixture();
    const first = await f.service.begin("bot", "ou_user");
    expect((await f.service.begin("bot", "ou_user")).authorizationUrl).toBe(
      first.authorizationUrl,
    );
    expect(
      new URL(first.authorizationUrl ?? "").searchParams.get(
        "code_challenge_method",
      ),
    ).toBe("S256");
    const state =
      new URL(first.authorizationUrl ?? "").searchParams.get("state") ?? "";
    await f.service.complete(state, "code");
    expect(await f.service.status("bot", "ou_user")).toMatchObject({
      status: "ready",
      scopes: ["offline_access", "contact:user.base:readonly"],
    });
    await expect(f.service.complete(state, "code")).rejects.toThrow();
    await expect(f.service.begin("bot", "ou_other")).rejects.toThrow();
  });
  it("renews idle grants beyond the initial seven-day window", async () => {
    const f = await fixture();
    await f.authorize();
    for (let day = 0; day < 9; day++) {
      f.advance(24 * 60 * 60_000);
      await f.service.tick();
    }
    expect(f.exchanges()).toBe(10);
    expect(await f.service.accessToken("bot", "ou_user")).toBe("access-10");
  });
  it("coalesces refreshes from two service instances against the same durable record", async () => {
    const f = await fixture();
    await f.authorize();
    f.advance(3 * 60 * 60_000);
    const other = new FeishuUserAuthService(f.options);
    const tokens = await Promise.all([
      f.service.accessToken("bot", "ou_user"),
      other.accessToken("bot", "ou_user"),
    ]);
    expect(tokens).toEqual(["access-2", "access-2"]);
    expect(f.exchanges()).toBe(2);
  });
  it("does not repeatedly consume a revoked or expired refresh token", async () => {
    const f = await fixture();
    await f.authorize();
    f.advance(3 * 60 * 60_000);
    f.fetcher.mockResolvedValue(
      Response.json(
        {
          code: 20037,
          error: "invalid_grant",
          error_description: "Refresh token expired",
        },
        { status: 400 },
      ),
    );
    await expect(f.service.accessToken("bot", "ou_user")).rejects.toMatchObject(
      { code: "20037" },
    );
    const count = f.fetcher.mock.calls.length;
    await expect(f.service.accessToken("bot", "ou_user")).rejects.toThrow();
    expect(f.fetcher.mock.calls).toHaveLength(count);
    expect(await f.service.status("bot", "ou_user")).toMatchObject({
      status: "reauth_required",
      lastError: "20037: Refresh token expired",
    });
  });
  it("does not retry an ambiguous refresh after a restart", async () => {
    const f = await fixture();
    await f.authorize();
    f.advance(3 * 60 * 60_000);
    const key = grantKey(f.account.domain, f.account.appId, "ou_user");
    const record = await f.service.store.read(key);
    if (!record?.grant) throw new Error("fixture");
    record.grant.refreshStartedAt = f.now() - 1000;
    await f.service.store.write(key, record);
    await expect(
      new FeishuUserAuthService(f.options).accessToken("bot", "ou_user"),
    ).rejects.toMatchObject({ kind: "refresh_uncertain" });
    expect(f.exchanges()).toBe(1);
  });
  it("preserves the old grant when another user completes the authorization", async () => {
    const f = await fixture();
    await f.authorize();
    const pending = await f.service.begin("bot", "ou_user");
    f.fetcher.mockImplementation(async (input) =>
      String(input).endsWith("/user_info")
        ? Response.json({ code: 0, data: { open_id: "ou_somebody_else" } })
        : Response.json({
            access_token: "new",
            refresh_token: "new-refresh",
            expires_in: 7200,
            refresh_token_expires_in: 604800,
            scope: "offline_access contact:user.base:readonly",
          }),
    );
    await expect(
      f.service.complete(
        new URL(pending.authorizationUrl ?? "").searchParams.get("state") ?? "",
        "code",
      ),
    ).rejects.toThrow("Authorize using");
    expect(await f.service.accessToken("bot", "ou_user")).toBe("access-1");
  });
  it("cancels the pending attempt without deleting a valid grant", async () => {
    const f = await fixture();
    const state = await f.authorize();
    await f.service.begin("bot", "ou_user");
    await f.service.cancel("bot", "ou_user");
    expect(
      (await f.service.status("bot", "ou_user")).authorizationUrl,
    ).toBeUndefined();
    expect(await f.service.accessToken("bot", "ou_user")).toBe("access-1");
    await expect(f.service.complete(state, "code")).rejects.toThrow();
  });
  it("classifies network ambiguity and application errors separately", async () => {
    const f = await fixture();
    f.fetcher.mockRejectedValue(new Error("connection reset"));
    await expect(
      f.client.exchange({ appId: "a", appSecret: "s", domain: "feishu" }, {}),
    ).rejects.toMatchObject({ kind: "refresh_uncertain" });
    f.fetcher.mockResolvedValue(
      Response.json(
        { code: 20024, error_description: "Wrong app" },
        { status: 400 },
      ),
    );
    await expect(
      f.client.exchange({ appId: "a", appSecret: "s", domain: "feishu" }, {}),
    ).rejects.toMatchObject({ kind: "config_error", message: "Wrong app" });
  });
  it("serves all 38 tool contracts only to a scoped connector credential", async () => {
    const f = await fixture();
    const gateway = new FeishuMcpGateway({
      dataDir: f.dir,
      serverUrl: "http://127.0.0.1:3400",
      auth: f.service,
      secret: () => "secret",
    });
    const config = await gateway.connectorConfig("bot", "ou_user", f.dir);
    const { readFile } = await import("node:fs/promises");
    const binding = JSON.parse(await readFile(config.args[1] ?? "", "utf8"));
    expect(config.command).not.toContain("MLB");
    expect(FEISHU_MCP_TOOLS).toHaveLength(38);
    const routes = createFeishuUserAuthRoutes({
      userAuth: f.service,
      mcpGateway: gateway,
    } as FeishuChannelService);
    expect(
      (
        await routes.request("/mcp", {
          method: "POST",
          body: JSON.stringify({ method: "tools/list" }),
        })
      ).status,
    ).toBe(401);
    const response = await routes.request("/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${binding.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ method: "tools/list" }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).tools).toHaveLength(38);
    const blocked = await gateway.call(binding.token, "lark_api", {
      method: "POST",
      path: "https://example.test/steal",
    });
    expect(blocked.isError).toBe(true);
    f.account.allowedUsers = [];
    await expect(gateway.authenticate(binding.token)).rejects.toThrow();
  });
});
