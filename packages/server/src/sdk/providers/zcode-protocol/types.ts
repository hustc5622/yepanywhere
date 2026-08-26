/**
 * Internal types for the ZCode protocol infrastructure.
 *
 * These types are server-only and not exported to the shared package.  They
 * complement the Zod contract schemas in `@yep-anywhere/shared` (see
 * `zcode-schema/protocol.ts`) with implementation-specific shapes: error
 * classes, client config, discovery/capability results, and config adapter
 * types.
 */

import type {
  ZCodeDeliveryKind,
  ZCodeErrorCode,
  ZCodeJsonRpcId,
  ZCodeJsonRpcNotification,
  ZCodeJsonRpcServerRequest,
  ZCodeMethod,
  ZCodeMode,
} from "@yep-anywhere/shared";

// =============================================================================
// Error classes
// =============================================================================

/**
 * Protocol-level error carrying a stable `ZCodeErrorCode`.
 *
 * Thrown for transport issues (timeout, closed, start failed) and capability
 * gate failures (CLI not found, unsupported version, unsupported server
 * request).  The `code` field is the stable identifier Yep routes on; the
 * `message` retains the original diagnostic text.
 */
export class ZCodeProtocolError extends Error {
  constructor(
    readonly code: ZCodeErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(
      message,
      options?.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = "ZCodeProtocolError";
  }
}

/**
 * JSON-RPC error returned by the ZCode app-server.
 *
 * Wraps the server's numeric `code`, human-readable `message`, optional
 * `data`, and the `requestId` that triggered it.  Distinct from
 * `ZCodeProtocolError` because these originate from the server, not from
 * Yep's transport layer.
 */
export class ZCodeServerError extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
    readonly data?: unknown,
    readonly requestId?: ZCodeJsonRpcId,
  ) {
    super(message);
    this.name = "ZCodeServerError";
  }
}

// =============================================================================
// Protocol client
// =============================================================================

/**
 * Configuration for `ZCodeProtocolClient`.
 *
 * `command` + `args` form the spawn vector:
 *   - `.cjs` CLI → `command = process.execPath`, `args = ["<path>", "app-server"]`
 *   - native wrapper → `command = "<path>"`, `args = ["app-server"]`
 */
export interface ZCodeProtocolClientConfig {
  /** Executable to spawn (Node binary for `.cjs`, CLI path for native). */
  readonly command: string;
  /** Arguments passed to the executable. */
  readonly args: string[];
  /** Environment for the child process. */
  readonly env?: NodeJS.ProcessEnv;
  /** Working directory for the child process. */
  readonly cwd?: string;
  /** Default per-request timeout in ms (default 30 000). */
  readonly requestTimeoutMs?: number;
  /** Max stderr buffer size in bytes (default 64 KiB). */
  readonly stderrBound?: number;
}

/** Internal pending-request entry. */
export interface ZCodePendingRequest {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly method: string;
  readonly params?: unknown;
  /** Timer for per-request timeout. */
  readonly timer?: ReturnType<typeof setTimeout>;
}

/**
 * Handler for server-to-client requests (permission, user input, runtime
 * headers, runtime preferences).  Must return a result object or throw;
 * `ZCodeProtocolClient` sends the JSON-RPC response back.
 */
export type ZCodeServerRequestHandler = (
  request: ZCodeJsonRpcServerRequest,
) => Promise<unknown>;

// =============================================================================
// Discovery & capability
// =============================================================================

/** Where the CLI was discovered from. */
export type ZCodeDiscoverySource =
  | "env" // YEP_ZCODE_CLI_PATH
  | "path" // `which zcode`
  | "app-bundle" // /Applications/ZCode.app/...
  | "user-app-bundle"; // ~/Applications/ZCode.app/...

/**
 * Result of CLI discovery.
 *
 * `errorCode` is populated when the CLI cannot be used (not found, version
 * incompatible, Node runtime missing).  When `errorCode` is set, `path` and
 * `version` may still be present for diagnostics.
 */
export interface ZCodeDiscoveryResult {
  /** Resolved CLI path, or `null` when not found. */
  readonly path: string | null;
  /** Parsed CLI version string (e.g. `"0.16.1"`), or `null`. */
  readonly version: string | null;
  /** Where the CLI was discovered. */
  readonly source: ZCodeDiscoverySource | null;
  /** `true` when the CLI is a `.cjs` bundle requiring a Node wrapper. */
  readonly isCjs: boolean;
  /** Stable error code when discovery failed. */
  readonly errorCode: ZCodeErrorCode | null;
}

/**
 * Resolved launch command for spawning an app-server.
 *
 * For `.cjs`: `{ command: process.execPath, args: ["<path>", "app-server"] }`.
 * For native: `{ command: "<path>", args: ["app-server"] }`.
 */
export interface ZCodeLaunchCommand {
  readonly command: string;
  readonly args: string[];
  readonly isCjs: boolean;
  readonly cliPath: string;
}

/**
 * Result of capability probing after the app-server starts.
 *
 * P0 smoke uses this to verify the CLI can start and respond to read-only
 * methods.  A non-null `errorCode` means the CLI version or protocol surface
 * is insufficient for Yep's integration.
 */
export interface ZCodeCapabilityResult {
  readonly cliVersion: string | null;
  /** Methods the app-server responded to successfully. */
  readonly availableMethods: readonly ZCodeMethod[];
  /** Delivery kinds accepted by `session/subscribe`. */
  readonly deliveryKinds: readonly ZCodeDeliveryKind[];
  /** Execution modes reported by the CLI. */
  readonly modes: readonly ZCodeMode[];
  readonly errorCode: ZCodeErrorCode | null;
}

// =============================================================================
// Config & registry adapter
// =============================================================================

/**
 * Provider kinds recognised by the ZCode config whitelist.
 *
 * Unknown kinds are not mapped to the closest match — they are marked
 * unavailable (fail-closed).
 */
export type ZCodeProviderKind = "anthropic" | "openai" | "openai-compatible";

/**
 * Where a provider's API key is sourced from.
 * Used for marking models unavailable when the source is
 * missing.
 *
 * Real ZCode 0.16.1 stores secrets inside `options`:
 *   - `options.apiKey` → `inline`
 *   - `options.headers` → `runtime-headers`
 *   - Credentials file → `inline`
 */
export type ZCodeApiKeySource = "inline" | "runtime-headers";

/** A parsed provider entry after whitelist filtering. */
export interface ZCodeParsedProvider {
  readonly id: string;
  readonly label?: string;
  readonly kind: ZCodeProviderKind;
  readonly apiKeySource: ZCodeApiKeySource | null;
  /** `true` when a usable API key or runtime-header mechanism exists. */
  readonly hasSecret: boolean;
  /** Unknown fields retained for diagnostics (never logged raw). */
  readonly unknownFieldCount: number;
  /** `false` when the config explicitly disables this provider. */
  readonly enabled?: boolean;
  /** Non-null when the system has disabled this provider (e.g. oauth_provider_inactive). */
  readonly systemDisabledReason?: string;
  /**
   * The actual API key value (from options.apiKey or credentials), or null.
   * Used to build the registry entry as `{source: "inline", value: ...}`.
   * This value is server-only and never logged or returned to the client.
   */
  readonly apiKeyValue?: string | null;
  /** Base URL from options, used in registry entry. */
  readonly baseURL?: string;
  /** Headers from options, used in registry entry. */
  readonly headers?: Record<string, string>;
}

/** A parsed model entry after whitelist filtering. */
export interface ZCodeParsedModel {
  readonly id: string;
  readonly label?: string;
  readonly providerId: string;
}

/**
 * A catalog entry keyed by composite ID `providerId/modelId`.
 *
 * The composite ID is the only model identifier exposed to the client.
 * The server holds a reverse map to resolve the original provider/model pair.
 */
export interface ZCodeModelCatalogEntry {
  /** `providerId/modelId` — the public-facing model identifier. */
  readonly compositeId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly providerLabel?: string;
  readonly modelLabel?: string;
  /** `false` when the provider lacks a secret or the kind is unknown. */
  readonly available: boolean;
  readonly unavailableReason?: ZCodeErrorCode;
  /**
   * Thought levels this model advertises, in config order.
   *
   * Derived from the model's `reasoning.variants` capability. Empty when the
   * model has no reasoning capability — the real CLI's `listThoughtLevels()`
   * returns `[]` in that case and rejects any thought-level selection, so the
   * picker must stay hidden rather than offer a no-op control.
   */
  readonly thoughtLevels: readonly string[];
  /** The model's `reasoning.defaultVariant`, when it names a known level. */
  readonly defaultThoughtLevel?: string;
}

/**
 * Result of parsing `~/.zcode/v2/config.json` + `credentials.json`.
 *
 * Raw config and credentials are never persisted, never logged, and never
 * returned to the client.  Only the parsed catalog and stable error codes
 * leave this function.
 */
export interface ZCodeConfigParseResult {
  readonly providers: readonly ZCodeParsedProvider[];
  readonly models: readonly ZCodeParsedModel[];
  readonly catalog: readonly ZCodeModelCatalogEntry[];
  readonly errorCode: ZCodeErrorCode | null;
}

// =============================================================================
// Shared notification alias (re-exported for convenience)
// =============================================================================

export type { ZCodeJsonRpcNotification, ZCodeJsonRpcServerRequest };
