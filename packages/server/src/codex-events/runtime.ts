import { CODEX_PROTOCOL_BASELINE } from "../sdk/providers/codex-protocol/baseline.js";
import type { CodexRuntimeIdentity } from "./types.js";

/**
 * Runtime identities derive from the generated app-server protocol baseline,
 * so a successful CLI sync updates journal compatibility automatically.
 */
export const CODEX_EVENT_RUNTIME_IDENTITY = {
  codexVersion: CODEX_PROTOCOL_BASELINE.codexVersion,
  schemaHash: CODEX_PROTOCOL_BASELINE.stableSchemaHash,
  profile: "stable",
  experimentalApi: false,
} as const satisfies CodexRuntimeIdentity;

/**
 * Runtime identity for connections that explicitly opt into experimentalApi,
 * including paginated-history bridge rejoin/edit-fork flows. Public
 * experimental controls remain blocked by the capability registry.
 */
export const CODEX_PROVIDER_RUNTIME_IDENTITY = {
  codexVersion: CODEX_PROTOCOL_BASELINE.codexVersion,
  schemaHash: CODEX_PROTOCOL_BASELINE.experimentalSchemaHash,
  profile: "experimental",
  experimentalApi: true,
} as const satisfies CodexRuntimeIdentity;
