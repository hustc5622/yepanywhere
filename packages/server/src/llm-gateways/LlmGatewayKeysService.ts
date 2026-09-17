/**
 * Manages the selectable API keys of every configured LLM gateway channel and
 * reports what can be learned about each key (reachability, model access and —
 * when the gateway publishes it — remaining balance).
 *
 * See `./gateway-keys.ts` for the storage format and why a session picks a key
 * at all.
 */

import {
  type StoredGatewayKey,
  envGatewayKeyId,
  maskApiKey,
  newGatewayKeyId,
  readStoredGatewayKeys,
  writeStoredGatewayKeys,
} from "./gateway-keys.js";
import {
  type Env,
  type LlmGatewayChannel,
  gatewayAuthHeaders,
  resolveLlmGatewayChannels,
} from "./index.js";

const PROBE_CACHE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 12_000;

/**
 * Aggregator gateways built on new-api answer the OpenAI billing endpoints
 * with a sentinel "unlimited" limit instead of a real quota. Anything at or
 * above this is reported as "no quota information" rather than as a balance,
 * because showing "$100,000,000 left" is worse than showing nothing.
 */
const UNLIMITED_USD_SENTINEL = 100_000_000;

export interface LlmGatewayKeyStatus {
  ok: boolean;
  checkedAt: string;
  latencyMs: number | null;
  /** Number of models this key can reach, or `null` when unreachable. */
  modelCount: number | null;
  /** Bare model ids this key can reach. Empty when unreachable. */
  models: string[];
  /** Remaining balance in USD when the gateway publishes a real quota. */
  balanceUsd: number | null;
  limitUsd: number | null;
  usedUsd: number | null;
  /** True when the gateway reports an unlimited (sentinel) quota. */
  unlimited: boolean;
  error: string | null;
}

export interface LlmGatewayKeyEntry {
  id: string;
  channelId: string;
  label: string | null;
  /** Masked credential, e.g. `sk-tmm…a8pN`. Never the full key. */
  preview: string;
  /** True for the built-in entry backed by the service environment. */
  isEnvKey: boolean;
  createdAt: string;
  status: LlmGatewayKeyStatus | null;
}

export interface LlmGatewayChannelEntry {
  id: string;
  label: string;
  apiBase: string;
  isDefault: boolean;
  keys: LlmGatewayKeyEntry[];
}

interface ProbeCacheEntry {
  status: LlmGatewayKeyStatus;
  expiresAt: number;
}

export interface LlmGatewayKeysServiceOptions {
  env?: Env;
  fetchImpl?: typeof fetch;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "TimeoutError" ? "Request timed out" : error.message;
  }
  return String(error);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export class LlmGatewayKeysService {
  private readonly env: Env;
  private readonly fetchImpl: typeof fetch;
  /** Keyed by the credential itself, so two channels sharing a key share a probe. */
  private readonly probeCache = new Map<string, ProbeCacheEntry>();

  constructor(options: LlmGatewayKeysServiceOptions = {}) {
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Configured channels, newest catalog first, without any credentials. */
  channels(): LlmGatewayChannel[] {
    return resolveLlmGatewayChannels(this.env);
  }

  /**
   * Every channel with its selectable keys.
   *
   * `probe` is opt-in because the picker renders instantly from cached state;
   * the settings card asks for fresh probes explicitly.
   */
  async list(
    options: { probe?: boolean; fresh?: boolean } = {},
  ): Promise<LlmGatewayChannelEntry[]> {
    const channels = this.channels();
    const stored = readStoredGatewayKeys(this.env);
    return Promise.all(
      channels.map(async (channel) => ({
        id: channel.id,
        label: channel.label,
        apiBase: channel.apiBase,
        isDefault: channel.isDefault,
        keys: await Promise.all(
          this.keysForChannel(channel, stored).map(async ({ entry, apiKey }) =>
            options.probe
              ? {
                  ...entry,
                  status: await this.probe(channel, apiKey, options.fresh),
                }
              : { ...entry, status: this.cachedStatus(apiKey) },
          ),
        ),
      })),
    );
  }

  /** Add a key to one channel after checking that the gateway accepts it. */
  async addKey(input: {
    channelId: string;
    apiKey: string;
    label?: string | null;
  }): Promise<LlmGatewayKeyEntry> {
    const apiKey = input.apiKey?.trim();
    if (!apiKey) throw new Error("apiKey is required");
    const channel = this.requireChannel(input.channelId);

    const stored = readStoredGatewayKeys(this.env);
    const duplicate = stored.find(
      (key) => key.channelId === channel.id && key.apiKey === apiKey,
    );
    if (duplicate) throw new Error("This key is already configured");
    if (apiKey === channel.apiKey) {
      throw new Error("This key is already the channel's environment key");
    }

    const status = await this.probe(channel, apiKey, true);
    if (!status.ok) {
      // The most common mistake is pasting a key issued by another aggregator,
      // which only shows up as a bare 401, so name the channel being tested.
      throw new Error(
        `${channel.label} (${channel.apiBase}) rejected this key: ${
          status.error ?? "unknown error"
        }`,
      );
    }

    const record: StoredGatewayKey = {
      id: newGatewayKeyId(),
      channelId: channel.id,
      label: input.label?.trim() || null,
      apiKey,
      createdAt: new Date().toISOString(),
    };
    writeStoredGatewayKeys([...stored, record], this.env);
    return { ...this.describeStored(record), status };
  }

  renameKey(keyId: string, label: string | null): void {
    const stored = readStoredGatewayKeys(this.env);
    const match = stored.find((key) => key.id === keyId);
    if (!match) throw new Error("Unknown gateway key");
    match.label = label?.trim() || null;
    writeStoredGatewayKeys(stored, this.env);
  }

  removeKey(keyId: string): void {
    const stored = readStoredGatewayKeys(this.env);
    const next = stored.filter((key) => key.id !== keyId);
    if (next.length === stored.length) throw new Error("Unknown gateway key");
    writeStoredGatewayKeys(next, this.env);
  }

  /** Whether a session may be started with this key id. */
  isSelectable(keyId: string): boolean {
    const channels = this.channels();
    if (channels.some((channel) => envGatewayKeyId(channel.id) === keyId)) {
      return true;
    }
    const match = readStoredGatewayKeys(this.env).find(
      (key) => key.id === keyId,
    );
    return Boolean(
      match && channels.some((channel) => channel.id === match.channelId),
    );
  }

  private requireChannel(channelId: string): LlmGatewayChannel {
    const channel = this.channels().find(
      (candidate) => candidate.id === channelId,
    );
    if (!channel) throw new Error(`Unknown gateway channel "${channelId}"`);
    return channel;
  }

  /** Built-in environment entry first, then the stored keys of that channel. */
  private keysForChannel(
    channel: LlmGatewayChannel,
    stored: StoredGatewayKey[],
  ): Array<{ entry: LlmGatewayKeyEntry; apiKey: string }> {
    return [
      {
        entry: {
          id: envGatewayKeyId(channel.id),
          channelId: channel.id,
          label: null,
          preview: maskApiKey(channel.apiKey),
          isEnvKey: true,
          createdAt: new Date(0).toISOString(),
          status: null,
        },
        apiKey: channel.apiKey,
      },
      ...stored
        .filter((key) => key.channelId === channel.id)
        .map((key) => ({
          entry: this.describeStored(key),
          apiKey: key.apiKey,
        })),
    ];
  }

  private describeStored(key: StoredGatewayKey): LlmGatewayKeyEntry {
    return {
      id: key.id,
      channelId: key.channelId,
      label: key.label,
      preview: maskApiKey(key.apiKey),
      isEnvKey: false,
      createdAt: key.createdAt,
      status: null,
    };
  }

  private cachedStatus(apiKey: string): LlmGatewayKeyStatus | null {
    const cached = this.probeCache.get(apiKey);
    return cached && cached.expiresAt > Date.now() ? cached.status : null;
  }

  /**
   * Check one credential against its gateway.
   *
   * Model access is the reliable signal: two keys on the same aggregator
   * routinely differ in which models they may call, and a session pinned to a
   * model the key cannot reach would only fail at the first turn. Balance is
   * best-effort on top of it — see {@link UNLIMITED_USD_SENTINEL}.
   */
  async probe(
    channel: LlmGatewayChannel,
    apiKey: string,
    fresh = false,
  ): Promise<LlmGatewayKeyStatus> {
    if (!fresh) {
      const cached = this.cachedStatus(apiKey);
      if (cached) return cached;
    }

    const credentials = { ...channel, apiKey };
    const startedAt = Date.now();
    let status: LlmGatewayKeyStatus;
    try {
      const response = await this.fetchImpl(`${channel.apiBase}/models`, {
        headers: {
          accept: "application/json",
          ...gatewayAuthHeaders(credentials),
        },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      const latencyMs = Date.now() - startedAt;
      if (!response.ok) {
        throw new Error(`Gateway returned ${response.status}`);
      }
      const payload = (await response.json()) as {
        success?: unknown;
        data?: unknown;
      };
      if (payload.success === false || !Array.isArray(payload.data)) {
        throw new Error("Gateway returned an invalid catalog");
      }
      const models = payload.data
        .map((item) =>
          typeof item === "object" && item !== null
            ? (item as { id?: unknown }).id
            : undefined,
        )
        .filter((id): id is string => typeof id === "string" && id.length > 0)
        .sort((a, b) => a.localeCompare(b));

      status = {
        ok: true,
        checkedAt: new Date().toISOString(),
        latencyMs,
        modelCount: models.length,
        models,
        error: null,
        ...(await this.fetchBalance(channel, apiKey)),
      };
    } catch (error) {
      status = {
        ok: false,
        checkedAt: new Date().toISOString(),
        latencyMs: null,
        modelCount: null,
        models: [],
        balanceUsd: null,
        limitUsd: null,
        usedUsd: null,
        unlimited: false,
        error: errorMessage(error),
      };
    }

    this.probeCache.set(apiKey, {
      status,
      expiresAt: Date.now() + PROBE_CACHE_TTL_MS,
    });
    return status;
  }

  /**
   * Best-effort balance from the OpenAI-compatible billing endpoints.
   *
   * Most aggregator deployments either do not implement them or answer with an
   * unlimited sentinel, in which case every field stays `null` and the UI says
   * the gateway publishes no quota. Real quota is only reachable with a
   * console access token, which Yep does not have.
   */
  private async fetchBalance(
    channel: LlmGatewayChannel,
    apiKey: string,
  ): Promise<
    Pick<
      LlmGatewayKeyStatus,
      "balanceUsd" | "limitUsd" | "usedUsd" | "unlimited"
    >
  > {
    const empty = {
      balanceUsd: null,
      limitUsd: null,
      usedUsd: null,
      unlimited: false,
    };
    const headers = {
      accept: "application/json",
      ...gatewayAuthHeaders({ ...channel, apiKey }),
    };
    try {
      const response = await this.fetchImpl(
        `${channel.apiBase}/dashboard/billing/subscription`,
        { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
      );
      if (!response.ok) return empty;
      const payload = (await response.json()) as Record<string, unknown>;
      const limitUsd =
        finiteNumber(payload.hard_limit_usd) ??
        finiteNumber(payload.system_hard_limit_usd);
      if (limitUsd === null) return empty;
      if (limitUsd >= UNLIMITED_USD_SENTINEL) {
        return { ...empty, unlimited: true };
      }

      const usedUsd = await this.fetchUsage(channel, headers);
      return {
        limitUsd,
        usedUsd,
        balanceUsd: usedUsd === null ? null : Math.max(0, limitUsd - usedUsd),
        unlimited: false,
      };
    } catch {
      return empty;
    }
  }

  /** Usage since the start of the current month, in USD. */
  private async fetchUsage(
    channel: LlmGatewayChannel,
    headers: Record<string, string>,
  ): Promise<number | null> {
    const now = new Date();
    const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const end = new Date(now.getTime() + 24 * 60 * 60 * 1_000);
    const query = `start_date=${start.toISOString().slice(0, 10)}&end_date=${end
      .toISOString()
      .slice(0, 10)}`;
    try {
      const response = await this.fetchImpl(
        `${channel.apiBase}/dashboard/billing/usage?${query}`,
        { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
      );
      if (!response.ok) return null;
      const payload = (await response.json()) as Record<string, unknown>;
      // The endpoint reports cents, matching OpenAI's original shape.
      const totalUsage = finiteNumber(payload.total_usage);
      return totalUsage === null ? null : totalUsage / 100;
    } catch {
      return null;
    }
  }
}
