import { createHash } from "node:crypto";
import { classifyCodexError } from "../codex/error-taxonomy.js";
import type { SafeJsonValue } from "./types.js";

export const SECRET_KEY_PATTERN =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|password|passphrase|secret|token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|private[_-]?key|credential|credentials|stdin|_authToken|[a-z][a-z0-9_-]*[_-]token)$/i;
const SECRET_VALUE_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\bBasic\s+[A-Za-z0-9+/]{4,}={0,2}(?=$|[\s,;])/i,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{24,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[a-z]-[A-Za-z0-9-]{8,}\b/i,
  /(?:^|[\r\n])\s*(?:Cookie|Set-Cookie)\s*:\s*\S[^\r\n]*/i,
  /\b(?:cookie|set-cookie|password|passwd|passphrase|secret|token|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|credential)\s*[:=]\s*(?:["'][^"'\r\n]{4,}["']|[^\s,;#]{8,})/i,
  /(?:^|[^A-Za-z0-9])(?:_authToken|[A-Za-z][A-Za-z0-9_]*_TOKEN)\s*[:=]\s*[^\s#]{4,}/i,
] as const;
const DATA_URL_PATTERN = /^data:([^;,]+)?(?:;[^,]*)?;base64,/i;
const PATH_FIELD_KEYS = new Set([
  "agentpath",
  "configpath",
  "cwd",
  "cwds",
  "files",
  "localpath",
  "move_path",
  "path",
  "rolloutpath",
  "root",
  "roots",
  "runtimeworkspaceroots",
  "savedpath",
  "scriptpath",
  "sessionpath",
  "sourcepath",
  "targetpath",
  "workspaceroot",
  "workspaceroots",
]);
const ABSOLUTE_WINDOWS_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\)/;
const FILE_URL_PATTERN = /^file:\/\//i;

type CodexPayloadLocation =
  | "root"
  | "thread"
  | "turn"
  | "threadItem"
  | "turnArray"
  | "threadItemArray"
  | "threadItemEntry"
  | "threadItemEntryArray"
  | "other";

export interface CodexPayloadRedactionOptions {
  /** Raw chain-of-thought is never needed by the compatibility projection. */
  allowRawReasoning?: boolean;
  /**
   * Keep absolute filesystem references embedded in ordinary text. Structured
   * path fields are still fingerprinted. This is intended for already-public
   * assistant replies and their outbound delivery records.
   */
  preserveAbsolutePathsInText?: boolean;
  maxDepth?: number;
  maxArrayItems?: number;
  maxObjectEntries?: number;
  maxStringLength?: number;
}

export interface RedactedCodexPayload {
  data: SafeJsonValue;
  redactionCount: number;
  truncated: boolean;
}

export interface CodexServerRequestSecretContext {
  secretFieldIds: ReadonlySet<string>;
  /** Fail closed when the persisted request schema was incomplete. */
  redactAllResponseFields: boolean;
}

export interface RedactedCodexServerRequestPayload
  extends RedactedCodexPayload {
  secretContext: CodexServerRequestSecretContext;
}

const MAX_TRACKED_SECRET_SCHEMA_ENTRIES = 10_000;
const SECRET_ANSWER_REDACTION = "[REDACTED:secret-answer]";
const SECRET_DEFAULT_REDACTION = "[REDACTED:secret-default]";

/** Shared value detector for every persistence and outbound trust boundary. */
export function containsSensitiveText(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/** Redact a public label as one unit so partial credentials never survive. */
export function redactSensitivePublicText(
  value: string,
  replacement = "[REDACTED:secret]",
): string {
  return containsSensitiveText(value) ? replacement : value;
}

/**
 * Redact a server request and retain only the schema metadata required to
 * redact its later JSON-RPC resolution. The context itself contains no answer
 * or default values and is safe to reconstruct from a canonical replay.
 */
export function redactCodexServerRequestPayload(
  method: string,
  value: unknown,
  options: CodexPayloadRedactionOptions = {},
): RedactedCodexServerRequestPayload {
  const discovered = inspectCodexServerRequestSecrets(method, value);
  const redacted = redactCodexPayload(method, value, options);
  const defaults = redactSecretSchemaDefaults(
    redacted.data,
    discovered.secretFieldIds,
  );
  return {
    ...redacted,
    data: defaults.data,
    redactionCount: redacted.redactionCount + defaults.redactionCount,
    secretContext: {
      secretFieldIds: discovered.secretFieldIds,
      redactAllResponseFields:
        discovered.redactAllResponseFields || redacted.truncated,
    },
  };
}

/**
 * Reconstruct the correlation metadata from a persisted server request. A
 * truncated request cannot prove that every secret field was retained, so its
 * later response is redacted fail-closed.
 */
export function restoreCodexServerRequestSecretContext(
  method: string,
  value: unknown,
  truncated = false,
): CodexServerRequestSecretContext {
  const context = inspectCodexServerRequestSecrets(method, value);
  return {
    secretFieldIds: context.secretFieldIds,
    redactAllResponseFields: context.redactAllResponseFields || truncated,
  };
}

/** Redact answers/content using the schema from the correlated server request. */
export function redactCodexServerRequestResolutionPayload(
  method: string,
  value: unknown,
  secretContext: CodexServerRequestSecretContext | undefined,
  options: CodexPayloadRedactionOptions = {},
): RedactedCodexPayload {
  const redacted = redactCodexPayload(method, value, options);
  const effectiveContext =
    secretContext ?? missingServerRequestSecretContext(method);
  const answers = redactSecretResponseFields(redacted.data, effectiveContext);
  return {
    ...redacted,
    data: answers.data,
    redactionCount: redacted.redactionCount + answers.redactionCount,
  };
}

/**
 * Convert an app-server payload into JSON-safe, bounded data at the event-store
 * trust boundary. Secrets and raw reasoning are replaced before persistence;
 * callers must never put the original object into an envelope or diagnostic.
 */
export function redactCodexPayload(
  method: string,
  value: unknown,
  options: CodexPayloadRedactionOptions = {},
): RedactedCodexPayload {
  const limits = {
    maxDepth: options.maxDepth ?? 32,
    maxArrayItems: options.maxArrayItems ?? 10_000,
    maxObjectEntries: options.maxObjectEntries ?? 10_000,
    maxStringLength: options.maxStringLength ?? 64 * 1024,
  };
  let redactionCount = 0;
  let truncated = false;

  const visit = (
    input: unknown,
    depth: number,
    key?: string,
    preserveAbsolutePathsInText = options.preserveAbsolutePathsInText === true,
    location: CodexPayloadLocation = "other",
  ): SafeJsonValue => {
    if (
      key?.toLowerCase() === "error" &&
      input !== null &&
      (typeof input === "object" || typeof input === "string")
    ) {
      const safeError = classifyCodexError(input);
      redactionCount += 1;
      return {
        code: safeError.code,
        category: safeError.category,
        retryable: safeError.retryable,
        message: safeErrorSignal(safeError.category),
        publicMessage: safeError.publicMessage,
        nextAction: safeError.nextAction,
      };
    }
    if (key && SECRET_KEY_PATTERN.test(key)) {
      redactionCount += 1;
      return "[REDACTED:secret]";
    }
    if (input === null) return null;
    if (typeof input === "boolean") return input;
    if (typeof input === "number") {
      return Number.isFinite(input) ? input : String(input);
    }
    if (typeof input === "string") {
      const dataUrl = DATA_URL_PATTERN.exec(input);
      if (dataUrl) {
        redactionCount += 1;
        return `[REDACTED:data-url:${dataUrl[1] ?? "unknown"}:sha256:${digest(input)}]`;
      }
      if (containsSensitiveText(input)) {
        redactionCount += 1;
        return "[REDACTED:secret-value]";
      }
      const filesystemRedaction = preserveAbsolutePathsInText
        ? { value: input, redactionCount: 0 }
        : redactAbsoluteFilesystemReferences(input);
      if (filesystemRedaction.redactionCount > 0) {
        redactionCount += filesystemRedaction.redactionCount;
      }
      if (filesystemRedaction.value.length > limits.maxStringLength) {
        truncated = true;
        return `${filesystemRedaction.value.slice(0, limits.maxStringLength)}[TRUNCATED:${filesystemRedaction.value.length - limits.maxStringLength}]`;
      }
      return filesystemRedaction.value;
    }
    if (
      typeof input === "undefined" ||
      typeof input === "function" ||
      typeof input === "symbol" ||
      typeof input === "bigint"
    ) {
      redactionCount += 1;
      return `[REDACTED:non-json:${typeof input}]`;
    }
    if (depth >= limits.maxDepth) {
      truncated = true;
      return "[TRUNCATED:max-depth]";
    }
    if (Array.isArray(input)) {
      if (input.length > limits.maxArrayItems) truncated = true;
      return input
        .slice(0, limits.maxArrayItems)
        .map((entry) =>
          visit(
            entry,
            depth + 1,
            undefined,
            preserveAbsolutePathsInText,
            codexArrayEntryLocation(location),
          ),
        );
    }

    const source = input as Record<string, unknown>;
    const taggedType =
      typeof source.type === "string" ? source.type : undefined;
    const imageGenerationPayload = isImageGenerationPayloadType(taggedType);
    if (
      taggedType === "skill" ||
      taggedType === "mention" ||
      taggedType === "localImage" ||
      taggedType === "localAudio"
    ) {
      return projectStructuredUserInput(source, taggedType, visit, () => {
        redactionCount += 1;
      });
    }
    const entries = Object.entries(source);
    if (entries.length > limits.maxObjectEntries) truncated = true;
    const output: Record<string, SafeJsonValue> = {};
    for (const [entryKey, entryValue] of entries.slice(
      0,
      limits.maxObjectEntries,
    )) {
      if (imageGenerationPayload && entryKey === "result") {
        if (typeof entryValue === "string") {
          output.resultSummary = {
            encoding: looksLikeBase64(entryValue) ? "base64" : "opaque",
            encodedLength: entryValue.length,
            encodedSha256: `sha256:${fullDigest(entryValue)}`,
          };
        } else {
          output.resultSummary = "[REDACTED:invalid-image-result]";
        }
        redactionCount += 1;
        continue;
      }
      if (isPathFieldKey(entryKey)) {
        const projectedPath = projectPathField(entryKey, entryValue);
        if (projectedPath) {
          output[projectedPath.key] = projectedPath.value;
          redactionCount += projectedPath.redactionCount;
          continue;
        }
      }
      output[entryKey] = visit(
        entryValue,
        depth + 1,
        entryKey,
        preserveAbsolutePathsInText ||
          (typeof entryValue === "string" &&
            isUserVisibleAgentText(method, location, taggedType, entryKey)),
        childCodexPayloadLocation(method, location, entryKey),
      );
    }
    return output;
  };

  let data = visit(
    value ?? null,
    0,
    undefined,
    options.preserveAbsolutePathsInText === true,
    "root",
  );
  const reasoningSnapshotResult = redactReasoningSnapshots(data);
  data = reasoningSnapshotResult.data;
  redactionCount += reasoningSnapshotResult.redactionCount;
  if (method === "item/reasoning/textDelta" && !options.allowRawReasoning) {
    const object = asObject(data);
    if (object && typeof object.delta === "string") {
      redactionCount += 1;
      data = {
        ...object,
        delta: `[REDACTED:raw-reasoning:${object.delta.length}:sha256:${digest(object.delta)}]`,
      };
    }
  }

  return { data, redactionCount, truncated };
}

function isUserVisibleAgentText(
  method: string,
  location: CodexPayloadLocation,
  taggedType: string | undefined,
  key: string,
): boolean {
  return (
    (location === "threadItem" &&
      taggedType === "agentMessage" &&
      key === "text") ||
    (location === "root" &&
      method === "item/agentMessage/delta" &&
      key === "delta")
  );
}

function childCodexPayloadLocation(
  method: string,
  parent: CodexPayloadLocation,
  key: string,
): CodexPayloadLocation {
  if (parent === "root") {
    if (
      key === "item" &&
      (method === "item/started" || method === "item/completed")
    ) {
      return "threadItem";
    }
    if (
      key === "turn" &&
      (method === "turn/start" ||
        method === "turn/started" ||
        method === "turn/completed")
    ) {
      return "turn";
    }
    if (
      key === "thread" &&
      (method === "thread/start" ||
        method === "thread/resume" ||
        method === "thread/fork" ||
        method === "thread/rollback" ||
        method === "thread/read" ||
        method === "thread/started")
    ) {
      return "thread";
    }
    if (key === "data" && method === "thread/turns/list") {
      return "turnArray";
    }
    if (key === "data" && method === "thread/items/list") {
      return "threadItemEntryArray";
    }
  }
  if (parent === "thread" && key === "turns") return "turnArray";
  if (parent === "turn" && key === "items") return "threadItemArray";
  if (parent === "threadItemEntry" && key === "item") return "threadItem";
  return "other";
}

function codexArrayEntryLocation(
  location: CodexPayloadLocation,
): CodexPayloadLocation {
  if (location === "turnArray") return "turn";
  if (location === "threadItemArray") return "threadItem";
  if (location === "threadItemEntryArray") return "threadItemEntry";
  return "other";
}

function isImageGenerationPayloadType(type: string | undefined): boolean {
  return (
    type === "imageGeneration" ||
    type === "image_generation" ||
    type === "image_generation_call"
  );
}

function looksLikeBase64(value: string): boolean {
  return (
    value.length >= 16 &&
    value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  );
}

type PersistenceVisit = (
  input: unknown,
  depth: number,
  key?: string,
) => SafeJsonValue;

function projectStructuredUserInput(
  source: Record<string, unknown>,
  type: "skill" | "mention" | "localImage" | "localAudio",
  visit: PersistenceVisit,
  recordRedaction: () => void,
): SafeJsonValue {
  const output: Record<string, SafeJsonValue> = { type };
  if ((type === "skill" || type === "mention") && "name" in source) {
    output.name = visit(source.name, 1, "name");
  }
  if (
    (type === "localImage" || type === "localAudio") &&
    (source.detail === "auto" ||
      source.detail === "low" ||
      source.detail === "high" ||
      source.detail === "original")
  ) {
    output.detail = source.detail;
  }
  if (typeof source.path === "string" && source.path.length > 0) {
    output.pathFingerprint = pathFingerprint(source.path);
    recordRedaction();
  }
  // UserInput variants have a closed generated schema. Unknown properties are
  // dropped so a future provider field cannot silently become a path-bearing
  // persistence channel.
  return output;
}

function isPathFieldKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (PATH_FIELD_KEYS.has(lower)) return true;
  const normalized = lower.replaceAll("_", "").replaceAll("-", "");
  return (
    normalized === "directory" ||
    normalized === "directories" ||
    normalized.endsWith("path") ||
    normalized.endsWith("paths") ||
    normalized.endsWith("directory") ||
    normalized.endsWith("directories")
  );
}

function projectPathField(
  key: string,
  value: unknown,
): { key: string; value: SafeJsonValue; redactionCount: number } | null {
  if (typeof value === "string") {
    return {
      key: pathFingerprintKey(key, false),
      value: pathFingerprint(value),
      redactionCount: 1,
    };
  }
  if (Array.isArray(value)) {
    const paths = value.filter(
      (candidate): candidate is string => typeof candidate === "string",
    );
    return {
      key: pathFingerprintKey(key, true),
      value: paths.map(pathFingerprint),
      redactionCount: paths.length,
    };
  }
  if (value === null || value === undefined) {
    return { key, value: null, redactionCount: 0 };
  }
  return null;
}

function pathFingerprintKey(key: string, plural: boolean): string {
  if (key === "runtimeWorkspaceRoots") {
    return "runtimeWorkspaceRootFingerprints";
  }
  if (key === "workspaceRoots") return "workspaceRootFingerprints";
  if (key === "cwds") return "cwdFingerprints";
  if (key === "files") return "fileFingerprints";
  if (key === "roots") return "rootFingerprints";
  return `${key}${plural ? "Fingerprints" : "Fingerprint"}`;
}

function pathFingerprint(value: string): string {
  return `sha256:${digest(value)}`;
}

function filesystemFingerprint(value: string): string {
  return `[REDACTED:absolute-path:${pathFingerprint(value)}]`;
}

function redactAbsoluteFilesystemReferences(value: string): {
  value: string;
  redactionCount: number;
} {
  if (
    value.startsWith("/") ||
    ABSOLUTE_WINDOWS_PATH_PATTERN.test(value) ||
    FILE_URL_PATTERN.test(value)
  ) {
    return { value: filesystemFingerprint(value), redactionCount: 1 };
  }
  let redactionCount = 0;
  const replacePath = (
    _match: string,
    prefix: string,
    path: string,
  ): string => {
    redactionCount += 1;
    return `${prefix}${filesystemFingerprint(path)}`;
  };
  let redacted = value.replace(
    /(^|[\s"'`=(:,;])(file:\/\/\/[^\s"'`<>|]+)/gi,
    replacePath,
  );
  redacted = redacted.replace(
    /(^|[\s"'`=(:,;])([A-Za-z]:[\\/][^\s"'`<>|]+)/g,
    replacePath,
  );
  redacted = redacted.replace(
    /(^|[\s"'`=(:,;])(\\\\[^\s"'`<>|]+)/g,
    replacePath,
  );
  redacted = redacted.replace(
    /(^|[\s"'`=(:,;])(\/(?!\/)[^\s"'`<>|]+)/g,
    replacePath,
  );
  return { value: redacted, redactionCount };
}

function inspectCodexServerRequestSecrets(
  method: string,
  value: unknown,
): CodexServerRequestSecretContext {
  const secretFieldIds = new Set<string>();
  let redactAllResponseFields = false;
  const payload = asUnknownObject(value);

  if (method === "item/tool/requestUserInput") {
    const questions = payload?.questions;
    if (Array.isArray(questions)) {
      if (questions.length > MAX_TRACKED_SECRET_SCHEMA_ENTRIES) {
        redactAllResponseFields = true;
      }
      for (const questionValue of questions.slice(
        0,
        MAX_TRACKED_SECRET_SCHEMA_ENTRIES,
      )) {
        const question = asUnknownObject(questionValue);
        const id = readUnknownString(question, "id");
        const format = (
          readUnknownString(question, "format") ??
          readUnknownString(question, "type")
        )?.toLowerCase();
        if (
          id &&
          (isTrueFlag(question?.isSecret) ||
            SECRET_KEY_PATTERN.test(id) ||
            format === "password" ||
            format === "secret")
        ) {
          secretFieldIds.add(id);
        }
      }
    }
  }

  if (method === "mcpServer/elicitation/request") {
    const requestedSchema = asUnknownObject(payload?.requestedSchema);
    const properties = asUnknownObject(requestedSchema?.properties);
    const entries = Object.entries(properties ?? {});
    if (entries.length > MAX_TRACKED_SECRET_SCHEMA_ENTRIES) {
      redactAllResponseFields = true;
    }
    for (const [name, schemaValue] of entries.slice(
      0,
      MAX_TRACKED_SECRET_SCHEMA_ENTRIES,
    )) {
      const schema = asUnknownObject(schemaValue);
      const format = readUnknownString(schema, "format")?.toLowerCase();
      if (
        SECRET_KEY_PATTERN.test(name) ||
        isTrueFlag(schema?.writeOnly) ||
        isTrueFlag(schema?.isSecret) ||
        format === "password" ||
        format === "secret"
      ) {
        secretFieldIds.add(name);
      }
    }
  }

  return { secretFieldIds, redactAllResponseFields };
}

function missingServerRequestSecretContext(
  method: string,
): CodexServerRequestSecretContext {
  return {
    secretFieldIds: new Set(),
    redactAllResponseFields:
      method === "item/tool/requestUserInput" ||
      method === "mcpServer/elicitation/request",
  };
}

function redactSecretResponseFields(
  input: SafeJsonValue,
  context: CodexServerRequestSecretContext,
  parentKey?: string,
): { data: SafeJsonValue; redactionCount: number } {
  if (context.secretFieldIds.size === 0 && !context.redactAllResponseFields) {
    return { data: input, redactionCount: 0 };
  }
  if (Array.isArray(input)) {
    let redactionCount = 0;
    const data = input.map((entry) => {
      const result = redactSecretResponseFields(entry, context, parentKey);
      redactionCount += result.redactionCount;
      return result.data;
    });
    return { data, redactionCount };
  }
  const object = asObject(input);
  if (!object) return { data: input, redactionCount: 0 };

  let redactionCount = 0;
  const data: Record<string, SafeJsonValue> = {};
  for (const [key, entry] of Object.entries(object)) {
    if (
      (parentKey === "answers" || parentKey === "content") &&
      (context.redactAllResponseFields || context.secretFieldIds.has(key))
    ) {
      data[key] =
        parentKey === "answers"
          ? { answers: [SECRET_ANSWER_REDACTION] }
          : SECRET_ANSWER_REDACTION;
      redactionCount += 1;
      continue;
    }
    const result = redactSecretResponseFields(entry, context, key);
    data[key] = result.data;
    redactionCount += result.redactionCount;
  }
  return { data, redactionCount };
}

function redactSecretSchemaDefaults(
  input: SafeJsonValue,
  secretFieldIds: ReadonlySet<string>,
  parentKey?: string,
): { data: SafeJsonValue; redactionCount: number } {
  if (secretFieldIds.size === 0) {
    return { data: input, redactionCount: 0 };
  }
  if (Array.isArray(input)) {
    let redactionCount = 0;
    const data = input.map((entry) => {
      const result = redactSecretSchemaDefaults(
        entry,
        secretFieldIds,
        parentKey,
      );
      redactionCount += result.redactionCount;
      return result.data;
    });
    return { data, redactionCount };
  }
  const object = asObject(input);
  if (!object) return { data: input, redactionCount: 0 };

  let redactionCount = 0;
  const data: Record<string, SafeJsonValue> = {};
  for (const [key, entry] of Object.entries(object)) {
    if (parentKey === "properties" && secretFieldIds.has(key)) {
      const schema = asObject(entry);
      if (schema?.default !== undefined) {
        data[key] = { ...schema, default: SECRET_DEFAULT_REDACTION };
        redactionCount += 1;
        continue;
      }
    }
    const result = redactSecretSchemaDefaults(entry, secretFieldIds, key);
    data[key] = result.data;
    redactionCount += result.redactionCount;
  }
  return { data, redactionCount };
}

function asUnknownObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readUnknownString(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const candidate = value?.[key];
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : undefined;
}

function isTrueFlag(value: unknown): boolean {
  // Older canonical journals stringified booleans at the generic boundary.
  return value === true || value === "true";
}

function asObject(
  value: SafeJsonValue,
): Record<string, SafeJsonValue> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function fullDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function redactReasoningSnapshots(value: SafeJsonValue): {
  data: SafeJsonValue;
  redactionCount: number;
} {
  if (Array.isArray(value)) {
    let redactionCount = 0;
    const data = value.map((entry) => {
      const result = redactReasoningSnapshots(entry);
      redactionCount += result.redactionCount;
      return result.data;
    });
    return { data, redactionCount };
  }
  const object = asObject(value);
  if (!object) return { data: value, redactionCount: 0 };

  let redactionCount = 0;
  const data: Record<string, SafeJsonValue> = {};
  for (const [key, entry] of Object.entries(object)) {
    if (object.type === "reasoning" && key === "content") {
      // Preserve the generated ThreadItem shape while ensuring downstream
      // compatibility projectors fall back to the user-visible summary.
      data[key] = [];
      redactionCount += 1;
      continue;
    }
    const result = redactReasoningSnapshots(entry);
    data[key] = result.data;
    redactionCount += result.redactionCount;
  }
  return { data, redactionCount };
}

function safeErrorSignal(
  category: ReturnType<typeof classifyCodexError>["category"],
): string {
  switch (category) {
    case "no_rollout":
      return "no rollout found";
    case "overloaded":
      return "server overloaded";
    case "auth":
      return "unauthorized";
    case "quota":
      return "usage limit exceeded";
    case "permission":
      return "permission denied";
    case "attachment":
      return "attachment failed";
    case "bridge":
      return "Codex bridge unavailable";
    case "process_exit":
      return "Codex app-server process exited";
    case "sandbox":
      return "sandbox denied";
    case "unknown":
      return "unknown Codex error";
  }
}
