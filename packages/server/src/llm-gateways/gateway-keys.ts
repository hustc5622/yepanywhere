/**
 * Per-session gateway API keys.
 *
 * A gateway channel (see `./index.ts`) carries exactly one credential, taken
 * from the service environment. That is enough to reach a gateway, but not
 * enough to answer "run this session with my other key": the same aggregator
 * hands out several tokens with different quotas and different model
 * allowlists, and which one a session should burn is a per-session decision,
 * the same way a Codex session picks an account.
 *
 * This module owns the extra keys. They live in a small JSON file next to the
 * other data-dir state so a key can be added or rotated while the server runs,
 * and they are addressed by a stable id that a session stores in its metadata.
 *
 * The environment credential of every channel stays available as a built-in,
 * non-removable entry (`env:<channelId>`), so an existing session that never
 * chose a key keeps behaving exactly as before.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type Env, clean, resolveLlmGatewayChannels } from "./index.js";

/** File name looked up inside the data directory. */
export const GATEWAY_KEYS_FILE_NAME = "llm-gateway-keys.json";

/** Path override, mainly for tests. */
export const GATEWAY_KEYS_FILE_ENV = "YEP_LLM_GATEWAY_KEYS_FILE";

/** Prefix of the synthetic id given to a channel's environment credential. */
export const ENV_GATEWAY_KEY_PREFIX = "env:";

/** An operator-added key for one channel. */
export interface StoredGatewayKey {
  id: string;
  channelId: string;
  label: string | null;
  apiKey: string;
  createdAt: string;
}

interface StoredState {
  keys: StoredGatewayKey[];
}

/** Id of the built-in entry that resolves to a channel's environment key. */
export function envGatewayKeyId(channelId: string): string {
  return `${ENV_GATEWAY_KEY_PREFIX}${channelId}`;
}

/** Channel id an `env:<channelId>` key id refers to, or `null`. */
export function channelIdFromEnvGatewayKeyId(keyId: string): string | null {
  return keyId.startsWith(ENV_GATEWAY_KEY_PREFIX)
    ? keyId.slice(ENV_GATEWAY_KEY_PREFIX.length) || null
    : null;
}

/**
 * Display form of a credential: enough to tell two keys apart in a picker,
 * never enough to use one. Keys are never returned to clients in full.
 */
export function maskApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length <= 10) return "sk-****";
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`;
}

/**
 * Resolve the state file path. Mirrors `resolveLlmGatewayOverlayPath`: the
 * data directory is derived from the same variables `config.ts` uses so this
 * module keeps depending on node builtins only.
 */
export function resolveGatewayKeysPath(env: Env = process.env): string {
  const explicit = clean(env[GATEWAY_KEYS_FILE_ENV]);
  if (explicit) return explicit;
  const profile = clean(env.YEP_ANYWHERE_PROFILE);
  const dataDir =
    clean(env.YEP_ANYWHERE_DATA_DIR) ??
    join(homedir(), profile ? `.yep-anywhere-${profile}` : ".yep-anywhere");
  return join(dataDir, GATEWAY_KEYS_FILE_NAME);
}

function isStoredGatewayKey(value: unknown): value is StoredGatewayKey {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    record.id.length > 0 &&
    typeof record.channelId === "string" &&
    record.channelId.length > 0 &&
    typeof record.apiKey === "string" &&
    record.apiKey.length > 0
  );
}

/**
 * Read the stored keys.
 *
 * A malformed or missing file yields an empty list rather than throwing: a
 * hand-edited file must not take Pi sessions down, it only costs the extra
 * keys until it is fixed.
 */
export function readStoredGatewayKeys(
  env: Env = process.env,
): StoredGatewayKey[] {
  let raw: string;
  try {
    raw = readFileSync(resolveGatewayKeysPath(env), "utf-8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list =
    typeof parsed === "object" && parsed !== null
      ? (parsed as StoredState).keys
      : undefined;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const keys: StoredGatewayKey[] = [];
  for (const item of list) {
    if (!isStoredGatewayKey(item) || seen.has(item.id)) continue;
    seen.add(item.id);
    keys.push({
      id: item.id,
      channelId: item.channelId,
      label:
        typeof item.label === "string" && item.label.trim()
          ? item.label.trim()
          : null,
      apiKey: item.apiKey,
      createdAt:
        typeof item.createdAt === "string" && item.createdAt
          ? item.createdAt
          : new Date(0).toISOString(),
    });
  }
  return keys;
}

/** Persist the key list atomically. */
export function writeStoredGatewayKeys(
  keys: StoredGatewayKey[],
  env: Env = process.env,
): void {
  const path = resolveGatewayKeysPath(env);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify({ keys }, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(tmp, path);
}

/** Id for a newly added key. Opaque and stable across restarts. */
export function newGatewayKeyId(): string {
  return `gwkey-${randomUUID().slice(0, 8)}`;
}

/**
 * Whether a session may be started with this key id.
 *
 * `env:<channelId>` is accepted for any configured channel and means "use the
 * environment credential"; callers normalize it to `undefined`. Any other id
 * must still exist and still belong to a configured channel.
 */
export function isKnownGatewayKeyId(
  keyId: string,
  env: Env = process.env,
): boolean {
  const channels = resolveLlmGatewayChannels(env);
  const envChannelId = channelIdFromEnvGatewayKeyId(keyId);
  if (envChannelId !== null) {
    return channels.some((channel) => channel.id === envChannelId);
  }
  const match = readStoredGatewayKeys(env).find((key) => key.id === keyId);
  return Boolean(
    match && channels.some((channel) => channel.id === match.channelId),
  );
}

/**
 * Resolve the credential a session should use on one channel.
 *
 * Returns `null` when the id belongs to another channel or no longer exists,
 * which callers treat as "fall back to the channel's environment key" so a
 * removed key degrades to the previous behaviour instead of failing the run.
 */
export function resolveGatewayKeyForChannel(
  channelId: string,
  keyId: string | undefined,
  env: Env = process.env,
): string | null {
  if (!keyId) return null;
  if (channelIdFromEnvGatewayKeyId(keyId) !== null) return null;
  const match = readStoredGatewayKeys(env).find((key) => key.id === keyId);
  return match && match.channelId === channelId ? match.apiKey : null;
}
