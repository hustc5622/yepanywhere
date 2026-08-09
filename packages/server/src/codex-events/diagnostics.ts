import { createHash } from "node:crypto";
import type { ServerRequest } from "../sdk/providers/codex-protocol/index.js";
import { CODEX_EVENT_RUNTIME_IDENTITY } from "./runtime.js";
import type { CodexRuntimeIdentity } from "./types.js";

export const CODEX_UNKNOWN_METHOD_BUCKET_LIMIT = 32;

const MAX_COUNTER_VALUE = Number.MAX_SAFE_INTEGER;
const FINGERPRINT_HEX_LENGTH = 20;

type CodexKnownServerRequestMethod = ServerRequest["method"];

/**
 * Exhaustive against the generated ServerRequest union. An upstream request
 * addition must fail type-checking until its compatibility policy is audited.
 */
const CODEX_KNOWN_SERVER_REQUEST_METHODS = {
  "account/chatgptAuthTokens/refresh": true,
  applyPatchApproval: true,
  "attestation/generate": true,
  "currentTime/read": true,
  execCommandApproval: true,
  "item/commandExecution/requestApproval": true,
  "item/fileChange/requestApproval": true,
  "item/permissions/requestApproval": true,
  "item/tool/call": true,
  "item/tool/requestUserInput": true,
  "mcpServer/elicitation/request": true,
} as const satisfies Record<CodexKnownServerRequestMethod, true>;

export type CodexUnknownMethodDirection =
  | "server_notification"
  | "server_request";

export interface CodexUnknownMethodDiagnosticBucket {
  direction: CodexUnknownMethodDirection;
  /** One-way, bounded identifier; the upstream method itself is never retained. */
  methodFingerprint: string;
  /** Only the checked-in baseline is displayed; other values are fingerprinted. */
  runtimeVersion: string;
  /** One-way dimension for the protocol schema used by the event ingress. */
  schemaFingerprint: string;
  profile: CodexRuntimeIdentity["profile"];
  total: number;
}

export interface CodexEventDiagnostics {
  /** Metrics are deliberately in-memory only; restart resets all counters. */
  scope: "process_lifetime";
  unknownNotificationsTotal: number;
  unknownServerRequestsTotal: number;
  /** Maximum retained distinct direction/method/runtime/schema combinations. */
  bucketLimit: number;
  /** Events whose new bucket could not be retained after reaching bucketLimit. */
  bucketOverflowTotal: number;
  buckets: CodexUnknownMethodDiagnosticBucket[];
}

let unknownNotificationsTotal = 0;
let unknownServerRequestsTotal = 0;
let bucketOverflowTotal = 0;
const buckets = new Map<string, CodexUnknownMethodDiagnosticBucket>();

export function isKnownCodexServerRequestMethod(method: string): boolean {
  return Object.hasOwn(CODEX_KNOWN_SERVER_REQUEST_METHODS, method);
}

export function recordUnknownCodexNotification(
  method: string,
  runtime: CodexRuntimeIdentity,
): void {
  unknownNotificationsTotal = saturatingIncrement(unknownNotificationsTotal);
  recordUnknownMethod("server_notification", method, runtime);
}

export function recordUnknownCodexServerRequest(
  method: string,
  runtime: CodexRuntimeIdentity,
): void {
  unknownServerRequestsTotal = saturatingIncrement(unknownServerRequestsTotal);
  recordUnknownMethod("server_request", method, runtime);
}

export function getCodexEventDiagnostics(): CodexEventDiagnostics {
  return {
    scope: "process_lifetime",
    unknownNotificationsTotal,
    unknownServerRequestsTotal,
    bucketLimit: CODEX_UNKNOWN_METHOD_BUCKET_LIMIT,
    bucketOverflowTotal,
    buckets: [...buckets.values()]
      .map((bucket) => ({ ...bucket }))
      .sort(compareBuckets),
  };
}

function recordUnknownMethod(
  direction: CodexUnknownMethodDirection,
  method: string,
  runtime: CodexRuntimeIdentity,
): void {
  const methodFingerprint = diagnosticFingerprint(method);
  const runtimeVersion = safeRuntimeVersion(runtime.codexVersion);
  const schemaFingerprint = diagnosticFingerprint(runtime.schemaHash);
  const profile =
    runtime.profile === "experimental" ? "experimental" : "stable";
  const key = [
    direction,
    methodFingerprint,
    runtimeVersion,
    schemaFingerprint,
    profile,
  ].join("|");
  const existing = buckets.get(key);
  if (existing) {
    existing.total = saturatingIncrement(existing.total);
    return;
  }
  if (buckets.size >= CODEX_UNKNOWN_METHOD_BUCKET_LIMIT) {
    bucketOverflowTotal = saturatingIncrement(bucketOverflowTotal);
    return;
  }
  buckets.set(key, {
    direction,
    methodFingerprint,
    runtimeVersion,
    schemaFingerprint,
    profile,
    total: 1,
  });
}

function safeRuntimeVersion(version: string): string {
  return version === CODEX_EVENT_RUNTIME_IDENTITY.codexVersion
    ? version
    : `other:${diagnosticFingerprint(version)}`;
}

function diagnosticFingerprint(value: string): string {
  return `sha256:${createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, FINGERPRINT_HEX_LENGTH)}`;
}

function saturatingIncrement(value: number): number {
  return value >= MAX_COUNTER_VALUE ? MAX_COUNTER_VALUE : value + 1;
}

function compareBuckets(
  left: CodexUnknownMethodDiagnosticBucket,
  right: CodexUnknownMethodDiagnosticBucket,
): number {
  return (
    left.direction.localeCompare(right.direction) ||
    left.runtimeVersion.localeCompare(right.runtimeVersion) ||
    left.schemaFingerprint.localeCompare(right.schemaFingerprint) ||
    left.methodFingerprint.localeCompare(right.methodFingerprint)
  );
}
