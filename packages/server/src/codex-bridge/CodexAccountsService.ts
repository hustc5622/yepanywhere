import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { getDefaultCodexHomeDir } from "../projects/codex-scanner.js";
import { CodexAppServerClient } from "./CodexAppServerClient.js";
import { normalizeUsageSnapshot } from "./CodexUsageService.js";
import { readCodexAuthIdentity } from "./auth-identity.js";
import { ensureSharedCodexStorage } from "./codex-account-home.js";
import type { CodexUsageSnapshot } from "./types.js";

const LOGIN_TIMEOUT_MS = 15 * 60 * 1_000;
const USAGE_CACHE_TTL_MS = 60_000;
const DEFAULT_ACCOUNT_ID = "default";

export type CodexLoginMode = "browser" | "deviceCode";
export type CodexLoginStatus =
  | "pending"
  | "completed"
  | "failed"
  | "canceled"
  | "none";

export interface CodexAccountProfile {
  id: string;
  codexHome: string;
  label: string | null;
}

export interface CodexAccountIdentity {
  type: string;
  email: string | null;
  planType: string | null;
}

export interface CodexLoginState {
  mode: CodexLoginMode;
  status: CodexLoginStatus;
  authUrl: string | null;
  verificationUrl: string | null;
  userCode: string | null;
  error: string | null;
  startedAt: string;
}

export interface CodexAccountEntry {
  id: string;
  label: string | null;
  codexHome: string;
  isDefault: boolean;
  /** True when this account's credentials are the ones Codex sessions use. */
  isActive: boolean;
  account: CodexAccountIdentity | null;
  usage: CodexUsageSnapshot | null;
  error: string | null;
  login: CodexLoginState | null;
}

interface StoredState {
  accounts: CodexAccountProfile[];
}

interface PendingLogin extends CodexLoginState {
  accountId: string;
  loginId: string | null;
  client: CodexAppServerClient;
  timer: NodeJS.Timeout;
}

export interface CodexAccountsServiceOptions {
  dataDir: string;
  codexPathOverride?: string;
  /** Overrides the active `CODEX_HOME` (defaults to `CODEX_HOME` or `~/.codex`). */
  defaultCodexHome?: string;
}

/**
 * Manages one or more Codex accounts by isolating each of them into its own
 * `CODEX_HOME` directory. The "default" account is the machine-wide login
 * (`~/.codex`); extra accounts live under `<dataDir>/codex-homes/<id>`.
 */
export class CodexAccountsService {
  private readonly dataDir: string;
  private readonly statePath: string;
  private readonly homesDir: string;
  private readonly codexPathOverride?: string;
  private readonly defaultCodexHome: string;
  private readonly pendingLogins = new Map<string, PendingLogin>();
  private readonly finishedLogins = new Map<string, CodexLoginState>();
  private activationQueue: Promise<void> = Promise.resolve();
  private readonly usageCache = new Map<
    string,
    { entry: CodexAccountEntry; expiresAt: number }
  >();

  constructor(options: CodexAccountsServiceOptions) {
    this.dataDir = options.dataDir;
    this.statePath = join(options.dataDir, "codex-accounts.json");
    this.homesDir = join(options.dataDir, "codex-homes");
    this.codexPathOverride = options.codexPathOverride;
    this.defaultCodexHome =
      options.defaultCodexHome ?? getDefaultCodexHomeDir();
  }

  listProfiles(): CodexAccountProfile[] {
    const stored = this.readState();
    return [
      {
        id: DEFAULT_ACCOUNT_ID,
        codexHome: this.defaultCodexHome,
        label: null,
      },
      ...stored.accounts,
    ];
  }

  async list(options: { fresh?: boolean } = {}): Promise<CodexAccountEntry[]> {
    const profiles = this.listProfiles();
    for (const profile of profiles) {
      if (profile.id === DEFAULT_ACCOUNT_ID) continue;
      ensureSharedCodexStorage(profile.codexHome, this.defaultCodexHome);
    }
    const activeIdentity = await readCodexAuthIdentity(this.defaultCodexHome);
    return Promise.all(
      profiles.map(async (profile) => {
        const entry = await this.describe(profile, options.fresh === true);
        const isActive =
          profile.id === DEFAULT_ACCOUNT_ID ||
          (activeIdentity !== null &&
            (await readCodexAuthIdentity(profile.codexHome)) ===
              activeIdentity);
        return { ...entry, isActive };
      }),
    );
  }

  addAccount(label?: string): CodexAccountProfile {
    const state = this.readState();
    const id = `acct-${randomUUID().slice(0, 8)}`;
    const codexHome = join(this.homesDir, id);
    mkdirSync(codexHome, { recursive: true });
    // Share the rollout/session storage so sessions started with this account
    // stay visible to every Yep scanner and reader.
    ensureSharedCodexStorage(codexHome, this.defaultCodexHome);
    // Reuse the machine config (model, MCP servers, ...) but never the auth file.
    const sourceConfig = join(this.defaultCodexHome, "config.toml");
    const targetConfig = join(codexHome, "config.toml");
    if (existsSync(sourceConfig) && !existsSync(targetConfig)) {
      try {
        copyFileSync(sourceConfig, targetConfig);
      } catch {}
    }
    const profile: CodexAccountProfile = {
      id,
      codexHome,
      label: label?.trim() ? label.trim() : null,
    };
    state.accounts.push(profile);
    this.writeState(state);
    return profile;
  }

  removeAccount(accountId: string): void {
    if (accountId === DEFAULT_ACCOUNT_ID) {
      throw new Error("The default Codex account cannot be removed");
    }
    const state = this.readState();
    const profile = state.accounts.find((item) => item.id === accountId);
    if (!profile) throw new Error(`Unknown Codex account: ${accountId}`);
    state.accounts = state.accounts.filter((item) => item.id !== accountId);
    this.writeState(state);
    this.cancelLogin(accountId).catch(() => {});
    this.usageCache.delete(accountId);
    this.finishedLogins.delete(accountId);
    // Only delete directories this service created.
    if (resolve(profile.codexHome).startsWith(resolve(this.homesDir))) {
      try {
        rmSync(profile.codexHome, { recursive: true, force: true });
      } catch {}
    }
  }

  renameAccount(accountId: string, label: string | null): void {
    const state = this.readState();
    const profile = state.accounts.find((item) => item.id === accountId);
    if (!profile) throw new Error(`Unknown Codex account: ${accountId}`);
    profile.label = label?.trim() ? label.trim() : null;
    this.writeState(state);
  }

  async startLogin(
    accountId: string,
    mode: CodexLoginMode,
  ): Promise<CodexLoginState> {
    const profile = this.requireProfile(accountId);
    await this.cancelLogin(accountId);

    const client = new CodexAppServerClient({
      codexHome: profile.codexHome,
      codexPathOverride: this.codexPathOverride,
      onNotification: (method, params) => {
        if (method !== "account/login/completed") return;
        const payload = (params ?? {}) as {
          success?: boolean;
          error?: string | null;
        };
        this.finishLogin(
          accountId,
          payload.success ? "completed" : "failed",
          payload.error ?? null,
        );
      },
      onExit: (reason) => {
        const pending = this.pendingLogins.get(accountId);
        if (pending?.status === "pending") {
          this.finishLogin(accountId, "failed", reason);
        }
      },
    });

    await client.start();
    const result = (await client.request(
      "account/login/start",
      mode === "deviceCode"
        ? { type: "chatgptDeviceCode" }
        : { type: "chatgpt" },
    )) as {
      loginId?: string;
      authUrl?: string;
      verificationUrl?: string;
      userCode?: string;
    };

    const timer = setTimeout(() => {
      this.finishLogin(accountId, "failed", "Login timed out");
    }, LOGIN_TIMEOUT_MS);
    timer.unref?.();

    const pending: PendingLogin = {
      accountId,
      loginId: result.loginId ?? null,
      client,
      timer,
      mode,
      status: "pending",
      authUrl: result.authUrl ?? null,
      verificationUrl: result.verificationUrl ?? null,
      userCode: result.userCode ?? null,
      error: null,
      startedAt: new Date().toISOString(),
    };
    this.pendingLogins.set(accountId, pending);
    this.finishedLogins.delete(accountId);
    return toLoginState(pending);
  }

  getLoginState(accountId: string): CodexLoginState | null {
    const pending = this.pendingLogins.get(accountId);
    if (pending) return toLoginState(pending);
    return this.finishedLogins.get(accountId) ?? null;
  }

  async cancelLogin(accountId: string): Promise<void> {
    const pending = this.pendingLogins.get(accountId);
    if (!pending) return;
    if (pending.loginId) {
      try {
        await pending.client.request("account/login/cancel", {
          loginId: pending.loginId,
        });
      } catch {}
    }
    this.finishLogin(accountId, "canceled", null);
  }

  async logout(accountId: string): Promise<void> {
    const profile = this.requireProfile(accountId);
    const client = new CodexAppServerClient({
      codexHome: profile.codexHome,
      codexPathOverride: this.codexPathOverride,
    });
    try {
      await client.start();
      await client.request("account/logout", null);
    } finally {
      client.close();
    }
    this.usageCache.delete(accountId);
  }

  async resetUsage(
    accountId: string,
    params: { idempotencyKey: string; creditId?: string },
  ): Promise<{
    outcome: "reset" | "nothingToReset" | "noCredit" | "alreadyRedeemed";
  }> {
    const profile = this.requireProfile(accountId);
    const client = new CodexAppServerClient({
      codexHome: profile.codexHome,
      codexPathOverride: this.codexPathOverride,
    });
    try {
      await client.start();
      const result = await client.request<{ outcome: string }>(
        "account/rateLimitResetCredit/consume",
        params,
      );
      const outcome = result?.outcome;
      if (
        outcome !== "reset" &&
        outcome !== "nothingToReset" &&
        outcome !== "noCredit" &&
        outcome !== "alreadyRedeemed"
      ) {
        throw new Error("Codex app-server returned an unknown reset outcome");
      }
      return { outcome };
    } finally {
      client.close();
      // A timeout can still mean the backend consumed a credit. Never cache
      // pre-reset usage, including another profile for the same account.
      this.usageCache.clear();
    }
  }

  /**
   * Makes `accountId` the credentials used by Codex sessions by copying its
   * `auth.json` into the active `CODEX_HOME`. The previously active auth file
   * is backed up (and mirrored into its own profile when we can match it).
   */
  async activate(accountId: string): Promise<void> {
    // Concurrent requests must snapshot and preserve each outgoing login in order.
    const activation = this.activationQueue.then(() =>
      this.activateAccount(accountId),
    );
    this.activationQueue = activation.catch(() => {});
    return activation;
  }

  private async activateAccount(accountId: string): Promise<void> {
    if (accountId === DEFAULT_ACCOUNT_ID) return;
    const profile = this.requireProfile(accountId);
    const sourceAuth = join(profile.codexHome, "auth.json");
    if (!existsSync(sourceAuth)) {
      throw new Error("This Codex account is not signed in yet");
    }

    const activeAuth = join(this.defaultCodexHome, "auth.json");
    if (existsSync(activeAuth)) {
      const activeIdentity = await readCodexAuthIdentity(this.defaultCodexHome);
      const backupDir = join(this.homesDir, "_backups");
      mkdirSync(backupDir, { recursive: true });
      copyFileSync(
        activeAuth,
        join(backupDir, `auth-${Date.now()}-${randomUUID()}.json`),
      );
      // Mirror the outgoing credentials into the profile they belong to, so
      // switching back later does not require a new login.
      const profiles = this.listProfiles().filter(
        (item) => item.id !== DEFAULT_ACCOUNT_ID,
      );
      const identities = await Promise.all(
        profiles.map((item) => readCodexAuthIdentity(item.codexHome)),
      );
      const owner =
        profiles.find(
          (_, index) =>
            activeIdentity !== null && identities[index] === activeIdentity,
        ) ?? this.addAccount();
      // The initial machine login has no profile yet. Create one before
      // replacing it; a backup alone is not selectable in the account picker.
      mkdirSync(owner.codexHome, { recursive: true });
      copyFileSync(activeAuth, join(owner.codexHome, "auth.json"));
    }

    mkdirSync(this.defaultCodexHome, { recursive: true });
    copyFileSync(sourceAuth, activeAuth);
    this.usageCache.clear();
  }

  private async describe(
    profile: CodexAccountProfile,
    fresh: boolean,
  ): Promise<CodexAccountEntry> {
    const cached = this.usageCache.get(profile.id);
    if (!fresh && cached && cached.expiresAt > Date.now()) {
      return { ...cached.entry, login: this.getLoginState(profile.id) };
    }

    const base: CodexAccountEntry = {
      id: profile.id,
      label: profile.label,
      codexHome: profile.codexHome,
      isDefault: profile.id === DEFAULT_ACCOUNT_ID,
      isActive: profile.id === DEFAULT_ACCOUNT_ID,
      account: null,
      usage: null,
      error: null,
      login: this.getLoginState(profile.id),
    };

    if (!existsSync(join(profile.codexHome, "auth.json"))) {
      return { ...base, error: "not-signed-in" };
    }

    const client = new CodexAppServerClient({
      codexHome: profile.codexHome,
      codexPathOverride: this.codexPathOverride,
    });
    let entry: CodexAccountEntry;
    try {
      await client.start();
      const [identity, usage] = await Promise.all([
        client
          .request("account/read", {})
          .then((value) => normalizeAccount(value))
          .catch(() => null),
        client
          .request("account/rateLimits/read", null)
          .then((value) => normalizeUsageSnapshot(value))
          .catch(() => null),
      ]);
      entry = {
        ...base,
        account: identity,
        usage,
        error: usage ? null : "usage-unavailable",
      };
    } catch (error) {
      entry = { ...base, error: (error as Error).message };
    } finally {
      client.close();
    }

    this.usageCache.set(profile.id, {
      entry,
      expiresAt: Date.now() + USAGE_CACHE_TTL_MS,
    });
    return entry;
  }

  private finishLogin(
    accountId: string,
    status: Exclude<CodexLoginStatus, "none" | "pending">,
    error: string | null,
  ): void {
    const pending = this.pendingLogins.get(accountId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingLogins.delete(accountId);
    pending.client.close();
    this.finishedLogins.set(accountId, {
      ...toLoginState(pending),
      status,
      error,
    });
    this.usageCache.delete(accountId);
  }

  private requireProfile(accountId: string): CodexAccountProfile {
    const profile = this.listProfiles().find((item) => item.id === accountId);
    if (!profile) throw new Error(`Unknown Codex account: ${accountId}`);
    return profile;
  }

  private readState(): StoredState {
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, "utf-8")) as
        | StoredState
        | undefined;
      const accounts = Array.isArray(parsed?.accounts) ? parsed.accounts : [];
      return {
        accounts: accounts.filter(
          (item): item is CodexAccountProfile =>
            typeof item?.id === "string" && typeof item?.codexHome === "string",
        ),
      };
    } catch {
      return { accounts: [] };
    }
  }

  private writeState(state: StoredState): void {
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(this.statePath, `${JSON.stringify(state, null, 2)}\n`);
  }
}

function toLoginState(pending: PendingLogin): CodexLoginState {
  return {
    mode: pending.mode,
    status: pending.status,
    authUrl: pending.authUrl,
    verificationUrl: pending.verificationUrl,
    userCode: pending.userCode,
    error: pending.error,
    startedAt: pending.startedAt,
  };
}

function normalizeAccount(value: unknown): CodexAccountIdentity | null {
  const account = (value as { account?: unknown } | null)?.account as
    | { type?: string; email?: string | null; planType?: string | null }
    | null
    | undefined;
  if (!account || typeof account.type !== "string") return null;
  return {
    type: account.type,
    email: typeof account.email === "string" ? account.email : null,
    planType: typeof account.planType === "string" ? account.planType : null,
  };
}
