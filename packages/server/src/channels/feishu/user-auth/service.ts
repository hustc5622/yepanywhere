import { createHash, randomBytes } from "node:crypto";
import type {
  FeishuAccountConfig,
  FeishuUserAuthView,
} from "@yep-anywhere/shared";
import {
  FeishuOAuthClient,
  FeishuOAuthError,
  type OAuthApp,
  type OAuthTokens,
  feishuEndpoints,
} from "./oauth-client.js";
import {
  type AuthRecord,
  FeishuUserGrantStore,
  type Grant,
  grantKey,
} from "./store.js";

export interface FeishuUserAuthOptions {
  dataDir: string;
  accounts(): FeishuAccountConfig[];
  secret(account: FeishuAccountConfig): string | undefined;
  client?: FeishuOAuthClient;
  now?: () => number;
  onAuthorized?(accountId: string, user: string): Promise<void>;
}

export class FeishuUserAuthService {
  readonly store: FeishuUserGrantStore;
  private readonly client: FeishuOAuthClient;
  private readonly now: () => number;
  private timer?: ReturnType<typeof setInterval>;
  private ticking?: Promise<void>;
  private stopped = false;
  constructor(private readonly options: FeishuUserAuthOptions) {
    this.store = new FeishuUserGrantStore(options.dataDir);
    this.now = options.now ?? Date.now;
    this.client = options.client ?? new FeishuOAuthClient(undefined, this.now);
  }
  account(accountId: string, user: string): FeishuAccountConfig {
    const account = this.options.accounts().find((a) => a.id === accountId);
    if (
      !account?.enabled ||
      !account.userAuth?.enabled ||
      ![...account.allowedUsers, ...account.adminUsers].includes(user)
    ) {
      throw new FeishuOAuthError(
        "config_error",
        "user_auth_not_enabled",
        "Feishu user authorization is not enabled for this account and user.",
      );
    }
    return account;
  }
  private app(account: FeishuAccountConfig): OAuthApp {
    const appSecret = this.options.secret(account);
    if (!appSecret)
      throw new FeishuOAuthError(
        "config_error",
        "app_secret_missing",
        "Feishu App Secret is missing.",
      );
    return {
      appId: account.appId,
      domain: account.domain,
      appSecret,
      proxyMode: account.proxyMode,
    };
  }
  async status(accountId: string, user: string): Promise<FeishuUserAuthView> {
    const account = this.account(accountId, user);
    const record = await this.store.read(
      grantKey(account.domain, account.appId, user),
    );
    const grant = record?.grant;
    const pending =
      record?.attempt &&
      !record.attempt.consumed &&
      record.attempt.expiresAt > this.now()
        ? record.attempt
        : undefined;
    return {
      accountId,
      userOpenId: user,
      status:
        grant?.refreshStartedAt !== undefined
          ? (await this.store.isRefreshing(
              grantKey(account.domain, account.appId, user),
            ))
            ? "refreshing"
            : "refresh_uncertain"
          : grant && grant.refreshExpiresAt <= this.now()
            ? "reauth_required"
            : (grant?.status ?? "not_connected"),
      scopes: grant?.scopes ?? [],
      accessExpiresAt: grant?.accessExpiresAt,
      refreshExpiresAt: grant?.refreshExpiresAt,
      lastRefreshedAt: grant?.lastRefreshedAt,
      lastError: grant?.lastError,
      authorizationUrl: pending?.url,
      authorizationExpiresAt: pending?.expiresAt,
    };
  }
  async begin(
    accountId: string,
    user: string,
    requiredScopes: string[] = [],
    automatic = false,
  ): Promise<FeishuUserAuthView> {
    const account = this.account(accountId, user);
    this.app(account);
    const redirectUri = account.userAuth?.redirectUri;
    if (!redirectUri)
      throw new FeishuOAuthError(
        "config_error",
        "redirect_uri_missing",
        "Configure the Feishu OAuth callback URL in Yep settings and the Feishu application.",
      );
    const redirect = new URL(redirectUri);
    if (
      redirect.hash ||
      redirect.username ||
      redirect.password ||
      redirect.search ||
      !(
        redirect.protocol === "https:" ||
        (redirect.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname))
      )
    ) {
      throw new FeishuOAuthError(
        "config_error",
        "redirect_uri_invalid",
        "Use an HTTPS callback URL (HTTP is supported only on localhost).",
      );
    }
    const key = grantKey(account.domain, account.appId, user);
    await this.store.locked(key, async () => {
      const record = (await this.store.read(key)) ?? {
        version: 1 as const,
        cancelVersion: 0,
        accountId,
        appId: account.appId,
        domain: account.domain,
        userOpenId: user,
      };
      const scopes = [
        ...new Set([
          "offline_access",
          "contact:user.base:readonly",
          ...(account.userAuth?.scopes ?? []),
          ...(record.grant?.scopes ?? []),
          ...requiredScopes,
        ]),
      ];
      if (automatic && (record.suppressedUntil ?? 0) > this.now()) {
        throw new FeishuOAuthError(
          "reauth_required",
          "authorization_cancelled",
          "Authorization was cancelled or failed. Use /auth or Yep settings when you are ready to reconnect.",
        );
      }
      if (!automatic) record.suppressedUntil = undefined;
      if (
        scopes.length > 200 ||
        scopes.some((scope) => !/^[A-Za-z0-9_:.-]+$/.test(scope))
      )
        throw new Error("Invalid OAuth scopes");
      if (
        record.attempt &&
        !record.attempt.consumed &&
        record.attempt.expiresAt > this.now() &&
        scopes.every((s) => record.attempt?.scopes.includes(s))
      )
        return;
      const state = `${key}.${randomBytes(32).toString("base64url")}`;
      const verifier = randomBytes(48).toString("base64url");
      const url = new URL(
        `${feishuEndpoints(account.domain).accounts}/open-apis/authen/v1/authorize`,
      );
      url.search = new URLSearchParams({
        client_id: account.appId,
        response_type: "code",
        redirect_uri: redirectUri,
        scope: scopes.join(" "),
        state,
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        code_challenge_method: "S256",
      }).toString();
      record.attempt = {
        state,
        verifier,
        url: url.toString(),
        expiresAt: this.now() + 10 * 60_000,
        redirectUri,
        scopes,
        consumed: false,
      };
      await this.store.write(key, record);
    });
    return this.status(accountId, user);
  }
  async cancel(accountId: string, user: string) {
    const account = this.account(accountId, user);
    const key = grantKey(account.domain, account.appId, user);
    await this.store.locked(key, async () => {
      const record = await this.store.read(key);
      if (record) {
        record.cancelVersion += 1;
        if (record.attempt) record.attempt.consumed = true;
        record.suppressedUntil = this.now() + 24 * 60 * 60_000;
        await this.store.write(key, record);
      }
    });
  }
  async cancellationVersion(accountId: string, user: string): Promise<number> {
    const account = this.account(accountId, user);
    return (
      (await this.store.read(grantKey(account.domain, account.appId, user)))
        ?.cancelVersion ?? 0
    );
  }
  async complete(state: string, code?: string, denied?: string): Promise<void> {
    const key = state.split(".")[0] ?? "";
    // Unknown callbacks must not create lock sentinel files on disk.
    if (
      !/^[a-f0-9]{64}\.[A-Za-z0-9_-]{43}$/.test(state) ||
      !(await this.store.read(key))
    )
      throw new Error("Authorization link is invalid or expired.");
    let authorized: AuthRecord | undefined;
    await this.store.locked(key, async () => {
      const record = await this.store.read(key);
      const attempt = record?.attempt;
      if (
        !record ||
        !attempt ||
        attempt.state !== state ||
        attempt.consumed ||
        attempt.expiresAt <= this.now()
      )
        throw new Error("Authorization link is invalid or expired.");
      const account = this.account(record.accountId, record.userOpenId);
      if (account.appId !== record.appId || account.domain !== record.domain)
        throw new Error("Application configuration changed.");
      attempt.consumed = true;
      record.suppressedUntil = this.now() + 24 * 60 * 60_000;
      await this.store.write(key, record);
      if (denied || !code) throw new Error("Authorization was cancelled.");
      const app = this.app(account);
      const tokens = await this.client.exchange(app, {
        grant_type: "authorization_code",
        code,
        redirect_uri: attempt.redirectUri,
        code_verifier: attempt.verifier,
      });
      const identity = await this.client.identity(app, tokens.accessToken);
      if (
        identity.openId !== record.userOpenId ||
        (account.tenantKey && identity.tenantKey !== account.tenantKey)
      )
        throw new Error(
          "Authorize using the Feishu account that requested this operation.",
        );
      if (!attempt.scopes.every((s) => tokens.scopes.includes(s)))
        throw new Error(
          "Required permissions were not granted. Check the application scopes.",
        );
      record.grant = this.newGrant(tokens, record.grant?.revision ?? 0);
      record.grant.authorizedAt = this.now();
      record.suppressedUntil = undefined;
      record.attempt = undefined;
      await this.store.write(key, record);
      authorized = record;
    });
    if (authorized)
      await this.options.onAuthorized?.(
        authorized.accountId,
        authorized.userOpenId,
      );
  }
  private newGrant(tokens: OAuthTokens, revision: number): Grant {
    const now = this.now();
    return {
      ...tokens,
      revision: revision + 1,
      lastRefreshedAt: now,
      nextRefreshAt:
        now +
        Math.min(24 * 60 * 60_000, (tokens.refreshExpiresAt - now) * 0.45),
      status: "ready",
      failures: 0,
    };
  }
  async accessToken(
    accountId: string,
    user: string,
    scopes: string[] = [],
    maintenance = false,
  ): Promise<string> {
    const account = this.account(accountId, user);
    const key = grantKey(account.domain, account.appId, user);
    return this.store.locked(key, async () => {
      const record = await this.store.read(key);
      const grant = record?.grant;
      if (!record || !grant)
        throw new FeishuOAuthError(
          "reauth_required",
          "not_connected",
          "Connect your Feishu account to continue.",
        );
      const now = this.now();
      if (!scopes.every((s) => grant.scopes.includes(s)))
        throw new FeishuOAuthError(
          "reauth_required",
          "scope_required",
          "Additional Feishu permissions are required.",
        );
      if (grant.refreshStartedAt !== undefined) {
        grant.status = "refresh_uncertain";
        grant.lastError = "A previous refresh did not complete.";
        await this.store.write(key, record);
      }
      if (
        (!maintenance && grant.accessExpiresAt > now + 5 * 60_000) ||
        (maintenance && grant.nextRefreshAt > now)
      )
        return grant.accessToken;
      if (grant.refreshExpiresAt <= now) {
        grant.status = "reauth_required";
        grant.lastError = "20037: Refresh token expired.";
        await this.store.write(key, record);
      }
      if (!["ready", "retrying"].includes(grant.status))
        throw new FeishuOAuthError(
          grant.status as
            | "reauth_required"
            | "config_error"
            | "refresh_uncertain",
          grant.status,
          grant.lastError ?? "Reconnect your Feishu account.",
        );
      if (grant.status === "retrying" && grant.nextRefreshAt > now)
        throw new FeishuOAuthError(
          "retrying",
          "refresh_backoff",
          grant.lastError ?? "Feishu is temporarily unavailable.",
        );
      const app = this.app(account);
      grant.refreshStartedAt = now;
      await this.store.write(key, record);
      let tokens: OAuthTokens;
      try {
        tokens = await this.client.exchange(app, {
          grant_type: "refresh_token",
          refresh_token: grant.refreshToken,
        });
      } catch (error) {
        const failure =
          error instanceof FeishuOAuthError
            ? error
            : new FeishuOAuthError(
                "refresh_uncertain",
                "unknown",
                String(error),
              );
        grant.status = failure.kind;
        grant.lastError = `${failure.code}: ${failure.message}`;
        grant.refreshStartedAt = undefined;
        grant.failures += 1;
        grant.nextRefreshAt =
          now +
          Math.min(15 * 60_000, 10_000 * 2 ** Math.min(grant.failures, 6));
        await this.store.write(key, record);
        throw failure;
      }
      record.grant = this.newGrant(tokens, grant.revision);
      record.grant.authorizedAt = grant.authorizedAt;
      // Retry persistence with the same response; never exchange a consumed token again.
      for (let attempt = 0; ; attempt++) {
        try {
          await this.store.write(key, record);
          break;
        } catch (error) {
          if (attempt >= 2) throw error;
        }
      }
      return tokens.accessToken;
    });
  }
  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, 60_000);
    this.timer.unref();
    void this.tick().catch(() => undefined);
  }
  async tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = (async () => {
      for (const account of this.options.accounts()) {
        if (!account.enabled || !account.userAuth?.enabled) continue;
        for (const user of new Set([
          ...account.allowedUsers,
          ...account.adminUsers,
        ])) {
          if (this.stopped) return;
          await this.accessToken(account.id, user, [], true).catch(
            () => undefined,
          );
        }
      }
    })().finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }
  async shutdown() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.ticking;
  }
}
