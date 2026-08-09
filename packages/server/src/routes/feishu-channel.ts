import { FeishuAccountConfigSchema } from "@yep-anywhere/shared";
import { Hono } from "hono";
import type { FeishuBindingStore } from "../channels/feishu/binding-store.js";
import type { FeishuDurableInbox } from "../channels/feishu/inbox.js";
import type { FeishuOperationStore } from "../channels/feishu/operation-store.js";
import type { FeishuChannelService } from "../channels/feishu/service.js";

export interface FeishuChannelRoutesOptions {
  feishuChannelService: FeishuChannelService;
  bindingStore?: FeishuBindingStore;
  inbox?: FeishuDurableInbox;
  operationStore?: FeishuOperationStore;
  /** Adapter-wide readiness, including persistence and recovery. */
  isChannelReady?(): boolean;
}

export function createFeishuChannelRoutes(
  options: FeishuChannelRoutesOptions,
): Hono {
  const app = new Hono();
  const service = options.feishuChannelService;

  app.use("*", async (c, next) => {
    if (
      c.req.path.endsWith("/doctor") ||
      c.req.path.endsWith("/diagnostics") ||
      (options.isChannelReady?.() ?? service.isOperational())
    ) {
      return next();
    }
    return c.json({ error: "feishu_channel_unavailable" }, 503);
  });

  app.get("/accounts", (c) => c.json({ accounts: service.listAccounts() }));
  app.get("/status", (c) => c.json({ accounts: service.listStatuses() }));
  app.get("/doctor", (c) => c.json(service.doctor()));
  app.get("/diagnostics", (c) => {
    const bindings = options.bindingStore?.isOperational()
      ? summarizeByAccount(options.bindingStore.list())
      : undefined;
    return c.json({
      ...service.diagnostics(),
      persistence: {
        ...(bindings ? { bindings } : {}),
        ...(options.inbox?.isOperational()
          ? { inbox: options.inbox.summarize() }
          : {}),
        ...(options.operationStore?.isOperational()
          ? { operations: summarizeByAccount(options.operationStore.list()) }
          : {}),
      },
    });
  });
  app.get("/accounts/:accountId/permissions", (c) => {
    const permissions = service.getPermissionRequirements(
      c.req.param("accountId"),
    );
    return permissions
      ? c.json(permissions)
      : c.json({ error: "account_not_found" }, 404);
  });
  app.get("/bindings", (c) =>
    options.bindingStore?.isOperational()
      ? c.json({ bindings: options.bindingStore.list() })
      : c.json({ error: "feishu_binding_store_unavailable" }, 503),
  );

  app.delete("/bindings/:scopeKey", async (c) => {
    if (!options.bindingStore?.isOperational()) {
      return c.json({ error: "feishu_binding_store_unavailable" }, 503);
    }
    const removed = await options.bindingStore.remove(c.req.param("scopeKey"));
    return removed
      ? c.json({ success: true })
      : c.json({ error: "binding_not_found" }, 404);
  });

  app.put("/accounts/:accountId", async (c) => {
    const accountId = c.req.param("accountId");
    const body = await readJsonObject(c.req.raw);
    if (!body) {
      return c.json({ error: "invalid_json_body" }, 400);
    }
    if ("appSecret" in body || "secret" in body) {
      return c.json({ error: "use_secret_endpoint" }, 400);
    }
    if (body.id !== undefined && body.id !== accountId) {
      return c.json({ error: "account_id_mismatch" }, 400);
    }

    const parsed = FeishuAccountConfigSchema.safeParse({
      ...body,
      id: accountId,
      secretRef:
        typeof body.secretRef === "string"
          ? body.secretRef
          : (service.getAccountSecretRef(accountId) ?? `store:${accountId}`),
    });
    if (!parsed.success) {
      return c.json({ error: "invalid_account_config" }, 400);
    }

    const account = await service.upsertAccount(parsed.data);
    return c.json({ account });
  });

  app.delete("/accounts/:accountId", async (c) => {
    const removed = await service.removeAccount(c.req.param("accountId"));
    return removed
      ? c.json({ success: true })
      : c.json({ error: "account_not_found" }, 404);
  });

  app.put("/accounts/:accountId/secret", async (c) => {
    const body = await readJsonObject(c.req.raw);
    const appSecret = body?.appSecret;
    if (
      typeof appSecret !== "string" ||
      !appSecret.trim() ||
      appSecret.length > 1_024
    ) {
      return c.json({ error: "invalid_app_secret" }, 400);
    }

    const account = await service.setSecret(
      c.req.param("accountId"),
      appSecret,
    );
    return account
      ? c.json({ account })
      : c.json({ error: "account_not_found" }, 404);
  });

  app.delete("/accounts/:accountId/secret", async (c) => {
    const removed = await service.removeSecret(c.req.param("accountId"));
    return c.json({ success: true, removed });
  });

  app.post("/accounts/:accountId/connect", async (c) => {
    const accountId = c.req.param("accountId");
    const found = await service.connectAccount(accountId);
    return found
      ? c.json({ success: true })
      : service.hasAccount(accountId)
        ? c.json({ error: "account_disabled" }, 409)
        : c.json({ error: "account_not_found" }, 404);
  });

  app.post("/accounts/:accountId/reconnect", async (c) => {
    const accountId = c.req.param("accountId");
    const found = await service.reconnectAccount(accountId);
    return found
      ? c.json({ success: true })
      : service.hasAccount(accountId)
        ? c.json({ error: "account_disabled" }, 409)
        : c.json({ error: "account_not_found" }, 404);
  });

  app.post("/accounts/:accountId/test", (c) => {
    const accountId = c.req.param("accountId");
    const result = service
      .doctor()
      .accounts.find((account) => account.accountId === accountId);
    return result
      ? c.json({
          ok: result.checks.every((check) => check.ok),
          account: result,
        })
      : c.json({ error: "account_not_found" }, 404);
  });

  app.post("/accounts/:accountId/disconnect", async (c) => {
    const found = await service.disconnectAccount(c.req.param("accountId"));
    return found
      ? c.json({ success: true })
      : c.json({ error: "account_not_connected" }, 404);
  });

  return app;
}

function summarizeByAccount(records: Array<{ accountId: string }>): {
  total: number;
  byAccount: Record<string, number>;
} {
  const byAccount: Record<string, number> = {};
  for (const record of records) {
    byAccount[record.accountId] = (byAccount[record.accountId] ?? 0) + 1;
  }
  return { total: records.length, byAccount };
}

async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown> | undefined> {
  try {
    const body = (await request.json()) as unknown;
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
