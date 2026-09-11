import type { FeishuDomain, FeishuProxyMode } from "@yep-anywhere/shared";
import { feishuFetch } from "./http.js";

export class FeishuOAuthError extends Error {
  constructor(
    public readonly kind:
      | "retrying"
      | "reauth_required"
      | "config_error"
      | "refresh_uncertain",
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  scopes: string[];
}
export interface OAuthApp {
  appId: string;
  appSecret: string;
  domain: FeishuDomain;
  proxyMode?: FeishuProxyMode;
}
export function feishuEndpoints(domain: FeishuDomain) {
  return domain === "lark"
    ? {
        api: "https://open.larksuite.com",
        accounts: "https://accounts.larksuite.com",
      }
    : { api: "https://open.feishu.cn", accounts: "https://accounts.feishu.cn" };
}

export class FeishuOAuthClient {
  constructor(
    private readonly fetcher?: typeof fetch,
    private readonly now = Date.now,
  ) {}

  async exchange(
    app: OAuthApp,
    params: Record<string, string>,
  ): Promise<OAuthTokens> {
    let response: Response;
    try {
      response = await (
        this.fetcher ??
        ((url: string, init: RequestInit) => feishuFetch(url, init, app))
      )(`${feishuEndpoints(app.domain).accounts}/oauth/v3/token`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: app.appId,
          client_secret: app.appSecret,
          ...params,
        }),
      });
    } catch {
      throw new FeishuOAuthError(
        "refresh_uncertain",
        "transport_uncertain",
        "OAuth response was not received; the token may have been consumed.",
      );
    }
    let body: Record<string, unknown>;
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new FeishuOAuthError(
        "refresh_uncertain",
        "invalid_response",
        "OAuth returned an unreadable response.",
      );
    }
    if (
      !response.ok ||
      (body.code !== undefined && body.code !== 0) ||
      body.error
    ) {
      const code = String(body.code ?? body.error ?? response.status);
      const kind =
        response.status === 429 || ["20050", "20072"].includes(code)
          ? "retrying"
          : ["20037", "20064", "20073", "invalid_grant"].includes(code)
            ? "reauth_required"
            : "config_error";
      throw new FeishuOAuthError(
        kind,
        code,
        String(
          body.error_description ??
            body.message ??
            body.msg ??
            body.error ??
            `OAuth HTTP ${response.status}`,
        ),
      );
    }
    const accessSeconds = Number(body.expires_in);
    const refreshSeconds = Number(body.refresh_token_expires_in);
    if (
      typeof body.access_token !== "string" ||
      !body.access_token ||
      typeof body.refresh_token !== "string" ||
      !body.refresh_token ||
      !Number.isFinite(accessSeconds) ||
      accessSeconds <= 0 ||
      !Number.isFinite(refreshSeconds) ||
      refreshSeconds <= 0
    ) {
      throw new FeishuOAuthError(
        "reauth_required",
        "offline_access_required",
        "OAuth did not return a complete renewable grant. Enable and authorize offline_access.",
      );
    }
    const now = this.now();
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      accessExpiresAt: now + accessSeconds * 1000,
      refreshExpiresAt: now + refreshSeconds * 1000,
      scopes:
        typeof body.scope === "string"
          ? body.scope.split(/\s+/).filter(Boolean)
          : [],
    };
  }

  async identity(
    app: OAuthApp,
    accessToken: string,
  ): Promise<{ openId: string; tenantKey?: string }> {
    const response = await (
      this.fetcher ??
      ((url: string, init: RequestInit) => feishuFetch(url, init, app))
    )(`${feishuEndpoints(app.domain).api}/open-apis/authen/v1/user_info`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await response.json()) as {
      code?: number;
      data?: { open_id?: string; tenant_key?: string };
    };
    if (!response.ok || body.code !== 0 || !body.data?.open_id) {
      throw new FeishuOAuthError(
        "config_error",
        "identity_check_failed",
        "Unable to verify the authorized Feishu user.",
      );
    }
    return { openId: body.data.open_id, tenantKey: body.data.tenant_key };
  }
}
