import type { CodexRuntimeIdentity } from "./types.js";

/**
 * Generated protocol baseline from codex-cli 0.147.0. The protocol manifest
 * contract test keeps these runtime-safe constants in sync with manifest.json.
 */
export const CODEX_EVENT_RUNTIME_IDENTITY = {
  codexVersion: "0.147.0",
  schemaHash:
    "sha256:3539e05467a752e6d8575b293b149e4fe6d6ffd3550d649baf8e43187907c681",
  profile: "stable",
  experimentalApi: false,
} as const satisfies CodexRuntimeIdentity;

/**
 * The direct Codex provider opts into the pinned experimental transport only
 * so `/stop` can terminate the current turn's unified-exec processes after a
 * stable `turn/interrupt`. Public experimental controls remain blocked by the
 * capability registry.
 */
export const CODEX_PROVIDER_RUNTIME_IDENTITY = {
  codexVersion: "0.147.0",
  schemaHash:
    "sha256:e46a86223fe756a8d93a7acb1a0a8a6371381b6d0d11c41dbda5a978637865a3",
  profile: "experimental",
  experimentalApi: true,
} as const satisfies CodexRuntimeIdentity;
