import type { LlmGatewayRequestProtocol } from "@yep-anywhere/shared";

/**
 * Naming rules shared by the Pi provider and the Pi session reader.
 *
 * Pi identifies a model as a (provider, modelId) pair, so the same bare model
 * id may exist on several gateways without ambiguity inside Pi. Yep's
 * `ModelInfo.id` is a single string, so models from non-default gateway
 * channels are namespaced as `<channelId>/<bareModelId>`.
 *
 * The default channel deliberately keeps bare ids and the unsuffixed provider
 * ids: every Pi session and saved default recorded before multi-gateway
 * support stores a bare id, and Pi persists the selected provider id in its
 * settings, so renaming those would break resume for existing sessions.
 */

/** Yep-generated Pi provider id for OpenAI-compatible traffic. */
export const PI_PROVIDER_OPENAI = "yep-openai-compatible";
/** Yep-generated Pi provider id for Anthropic-messages traffic. */
export const PI_PROVIDER_ANTHROPIC = "yep-anthropic";

const PI_PROVIDER_BASE_IDS: Record<LlmGatewayRequestProtocol, string> = {
  "openai-compatible": PI_PROVIDER_OPENAI,
  anthropic: PI_PROVIDER_ANTHROPIC,
};

/**
 * Pi provider id for one protocol on one gateway channel. The default channel
 * keeps the historic unsuffixed id.
 */
export function piProviderId(
  protocol: LlmGatewayRequestProtocol,
  channel: { id: string; isDefault: boolean },
): string {
  const base = PI_PROVIDER_BASE_IDS[protocol];
  return channel.isDefault ? base : `${base}-${channel.id}`;
}

/**
 * Inverse of {@link piProviderId}. Returns the channel id for a suffixed
 * provider, or undefined for the default channel and for any provider Yep did
 * not generate (a user-configured Pi provider, for example).
 */
export function parsePiProviderId(providerId: string | undefined): {
  protocol?: LlmGatewayRequestProtocol;
  channelId?: string;
} {
  if (!providerId) return {};
  // Longest base id first: "yep-openai-compatible" must not be matched as a
  // channel-suffixed form of some shorter id.
  for (const protocol of ["openai-compatible", "anthropic"] as const) {
    const base = PI_PROVIDER_BASE_IDS[protocol];
    if (providerId === base) return { protocol };
    if (providerId.startsWith(`${base}-`)) {
      return { protocol, channelId: providerId.slice(base.length + 1) };
    }
  }
  return {};
}

/**
 * Namespace a bare gateway model id for a channel.
 *
 * The slash form is intentionally backward-compatible but not injective: a
 * default gateway's native `openai/gpt-5` collides with `gpt-5` on a channel
 * named `openai`. Catalog callers must retain the source channel separately
 * and reject duplicate public ids; never recover a request route from this
 * formatted id alone.
 */
export function qualifyPiModelId(
  channel: { id: string; isDefault: boolean },
  bareModelId: string,
): string {
  return channel.isDefault ? bareModelId : `${channel.id}/${bareModelId}`;
}

/**
 * Strip a known channel prefix from a Yep-facing Pi model id.
 *
 * Gateway model ids may themselves contain slashes (`openai/gpt-5`), so only a
 * prefix that matches a configured channel id is removed, and only the first
 * segment is considered because channel ids cannot contain a slash.
 * This helper is for presentation/filtering paths where source metadata is not
 * available; request routing must use the source retained with the catalog.
 */
export function stripPiChannelPrefix(
  modelId: string,
  channelIds: Iterable<string>,
): { channelId?: string; bareModelId: string } {
  const slash = modelId.indexOf("/");
  if (slash <= 0) return { bareModelId: modelId };
  const candidate = modelId.slice(0, slash);
  for (const channelId of channelIds) {
    if (channelId === candidate) {
      return { channelId: candidate, bareModelId: modelId.slice(slash + 1) };
    }
  }
  return { bareModelId: modelId };
}
