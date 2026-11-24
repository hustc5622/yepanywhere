/**
 * Antigravity (`agy acp`) helpers shared by the main provider and its side
 * conversations: vendor tool names from raw frames, live tool result text,
 * and model / thinking selection through ACP config options.
 */

import { getLogger } from "../../logging/logger.js";
import {
  cleanAgyToolOutput,
  inferAgyNativeToolName,
} from "../../sessions/agy-tools.js";
import type { ACPClient } from "./acp/client.js";
import {
  AGY_MODEL_CONFIG_ID,
  AGY_THOUGHT_CONFIG_ID,
  resolveAgyModelChoice,
} from "./agy-models.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** ACP error code agy returns before the user signed in. */
const AUTH_REQUIRED_CODE = -32000;
export const AGY_AUTH_REQUIRED_MESSAGE =
  "Antigravity CLI is not signed in. Run `agy` once in a terminal on the Yep host (or `agy acp --login` over SSH) and complete the Google sign-in, then retry.";

/** agy's "Authentication required" (signed out, or token refresh failed). */
export function isAgyAuthRequiredError(error: unknown): boolean {
  if (isRecord(error)) {
    if (error.code === AUTH_REQUIRED_CODE) return true;
    if (
      typeof error.message === "string" &&
      /authentication required/i.test(error.message)
    ) {
      return true;
    }
  }
  return (
    error instanceof Error && /authentication required/i.test(error.message)
  );
}

function textFromContentList(list: unknown): string {
  if (!Array.isArray(list)) return "";
  const parts: string[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const inner = item.type === "content" ? item.content : item;
    if (
      isRecord(inner) &&
      inner.type === "text" &&
      typeof inner.text === "string" &&
      inner.text
    ) {
      parts.push(inner.text);
    }
  }
  return parts.join("\n");
}

/** Live tool result text; the persisted transcript replaces it later. */
export function agyToolResultText(update: {
  content?: unknown;
  rawOutput?: unknown;
}): string {
  const raw = update.rawOutput;
  if (typeof raw === "string") return cleanAgyToolOutput(raw);
  if (isRecord(raw)) {
    if (typeof raw.output === "string" && raw.output) {
      return cleanAgyToolOutput(raw.output);
    }
    if (typeof raw.error === "string") return raw.error;
    if (isRecord(raw.error) && typeof raw.error.message === "string") {
      return raw.error.message;
    }
  }
  return textFromContentList(update.content);
}

/**
 * agy adds a non-standard `name` (native tool name) next to `title`. The ACP
 * SDK drops it while validating, so the provider records it from raw frames
 * (`names`); an argument-shape inference covers anything it missed.
 */
export function agyNativeToolName(
  update: unknown,
  names?: ReadonlyMap<string, string>,
): string {
  if (!isRecord(update)) return "tool";
  const recorded =
    typeof update.toolCallId === "string"
      ? names?.get(update.toolCallId)
      : undefined;
  if (recorded) return recorded;
  if (typeof update.name === "string" && update.name) return update.name;
  return inferAgyNativeToolName(update);
}

/** Remember agy's vendor tool names from raw ACP frames (see ACPClient). */
export function recordAgyToolNames(
  frame: Record<string, unknown>,
  names: Map<string, string>,
): void {
  const params = isRecord(frame.params) ? frame.params : undefined;
  if (!params) return;
  const candidate =
    frame.method === "session/update"
      ? params.update
      : frame.method === "session/request_permission"
        ? params.toolCall
        : undefined;
  if (
    isRecord(candidate) &&
    typeof candidate.toolCallId === "string" &&
    typeof candidate.name === "string" &&
    candidate.name
  ) {
    names.set(candidate.toolCallId, candidate.name);
  }
}

/** A tool call's native arguments (`rawInput`, or agy's own `args`). */
export function agyToolRawInput(update: unknown): unknown {
  if (!isRecord(update)) return undefined;
  return update.rawInput ?? ("args" in update ? update.args : undefined);
}

/** Current value and every offered value of a select config option. */
export function selectAgyConfigValues(
  configOptions: unknown,
  id: string,
): { current?: string; values: string[] } {
  if (!Array.isArray(configOptions)) return { values: [] };
  const option = configOptions.find(
    (candidate) => isRecord(candidate) && candidate.id === id,
  );
  if (!isRecord(option)) return { values: [] };
  const values: string[] = [];
  const collect = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      if (!isRecord(entry)) continue;
      if (Array.isArray(entry.options)) collect(entry.options);
      else if (typeof entry.value === "string") values.push(entry.value);
    }
  };
  collect(option.options);
  return {
    current:
      typeof option.currentValue === "string" ? option.currentValue : undefined,
    values,
  };
}

/**
 * Select `model` (a family or a persisted tiered slug) and its thinking
 * level on an ACP session, verifying that agy applied the family.
 */
export async function applyAgyModel(
  client: ACPClient,
  sessionId: string,
  model: string,
  reasoningEffort: string | undefined,
): Promise<void> {
  const models = selectAgyConfigValues(
    client.getSessionConfigOptions(sessionId),
    AGY_MODEL_CONFIG_ID,
  );
  const choice = resolveAgyModelChoice(models.values, model, reasoningEffort);
  if (!choice) {
    throw new Error(`Antigravity does not offer model "${model}"`);
  }
  if (models.current !== choice.family) {
    const result = await client.setSessionConfigOption(
      sessionId,
      AGY_MODEL_CONFIG_ID,
      choice.family,
    );
    const applied = selectAgyConfigValues(
      result.configOptions,
      AGY_MODEL_CONFIG_ID,
    ).current;
    if (applied !== choice.family) {
      throw new Error(
        `Antigravity did not apply model "${model}" (active: "${applied ?? "unknown"}")`,
      );
    }
  }
  if (!choice.tier) return;
  const tiers = selectAgyConfigValues(
    client.getSessionConfigOptions(sessionId),
    AGY_THOUGHT_CONFIG_ID,
  );
  if (tiers.current === choice.tier) return;
  if (!tiers.values.includes(choice.tier)) {
    // Families differ in tiers (Flash has no `xhigh`); keep agy's default
    // rather than failing the turn.
    getLogger().info(
      { sessionId, model: choice.family, tier: choice.tier },
      "Antigravity model does not offer the requested thinking level",
    );
    return;
  }
  await client.setSessionConfigOption(
    sessionId,
    AGY_THOUGHT_CONFIG_ID,
    choice.tier,
  );
}
