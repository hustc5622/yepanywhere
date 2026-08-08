export type CodexErrorCategory =
  | "no_rollout"
  | "overloaded"
  | "auth"
  | "quota"
  | "permission"
  | "attachment"
  | "process_exit"
  | "sandbox"
  | "unknown";

export type CanonicalCodexErrorCode =
  | "CODEX_NO_ROLLOUT"
  | "CODEX_OVERLOADED"
  | "CODEX_AUTH_REQUIRED"
  | "CODEX_QUOTA_EXCEEDED"
  | "CODEX_PERMISSION_DENIED"
  | "CODEX_ATTACHMENT_FAILED"
  | "CODEX_PROCESS_EXITED"
  | "CODEX_SANDBOX_DENIED"
  | "CODEX_UNKNOWN";

export interface CanonicalCodexError {
  code: CanonicalCodexErrorCode;
  category: CodexErrorCategory;
  retryable: boolean;
  /** English wire fallback; clients/channels localize the stable code. */
  publicMessage: string;
  /** English wire fallback; clients/channels localize the stable code. */
  nextAction: string;
  correlationId?: string;
}

export interface ClassifyCodexErrorOptions {
  /**
   * Caller-provided diagnostic identifier. It is never inferred from raw error
   * data and is returned only when it contains a conservative safe character
   * set.
   */
  correlationId?: string;
}

interface ErrorDescriptor {
  code: CanonicalCodexErrorCode;
  retryable: boolean;
  publicMessage: string;
  nextAction: string;
}

const ERROR_DESCRIPTORS: Record<CodexErrorCategory, ErrorDescriptor> = {
  no_rollout: {
    code: "CODEX_NO_ROLLOUT",
    retryable: true,
    publicMessage:
      "This Codex session is not ready, so the task could not start.",
    nextAction: "Create a new session and try again.",
  },
  overloaded: {
    code: "CODEX_OVERLOADED",
    retryable: true,
    publicMessage: "Codex is busy and cannot process the request right now.",
    nextAction: "Try again shortly.",
  },
  auth: {
    code: "CODEX_AUTH_REQUIRED",
    retryable: false,
    publicMessage: "Codex authentication has expired or is incomplete.",
    nextAction: "Sign in to Codex again in Yep, then retry.",
  },
  quota: {
    code: "CODEX_QUOTA_EXCEEDED",
    retryable: true,
    publicMessage: "The Codex usage quota or context budget has been reached.",
    nextAction: "Check the quota or retry after the limit resets.",
  },
  permission: {
    code: "CODEX_PERMISSION_DENIED",
    retryable: false,
    publicMessage: "The operation was denied by the permission policy.",
    nextAction: "Review approval and permission settings, or adjust the task.",
  },
  attachment: {
    code: "CODEX_ATTACHMENT_FAILED",
    retryable: false,
    publicMessage: "The attachment could not be read or processed.",
    nextAction: "Upload it again or use a supported format and size.",
  },
  process_exit: {
    code: "CODEX_PROCESS_EXITED",
    retryable: true,
    publicMessage:
      "The Codex process exited unexpectedly before the task completed.",
    nextAction:
      "Try again; if the problem persists, inspect diagnostics in Yep.",
  },
  sandbox: {
    code: "CODEX_SANDBOX_DENIED",
    retryable: false,
    publicMessage: "The operation was blocked by the runtime sandbox.",
    nextAction: "Review sandbox settings or use an allowed path and operation.",
  },
  unknown: {
    code: "CODEX_UNKNOWN",
    retryable: false,
    publicMessage:
      "Codex encountered an unclassified error before the task completed.",
    nextAction:
      "Try again; if the problem persists, inspect diagnostics in Yep.",
  },
};

const CODEX_ERROR_INFO_NAMES = new Set([
  "contextWindowExceeded",
  "sessionBudgetExceeded",
  "usageLimitExceeded",
  "serverOverloaded",
  "cyberPolicy",
  "httpConnectionFailed",
  "responseStreamConnectionFailed",
  "internalServerError",
  "unauthorized",
  "badRequest",
  "threadRollbackFailed",
  "sandboxError",
  "responseStreamDisconnected",
  "responseTooManyFailedAttempts",
  "activeTurnNotSteerable",
  "other",
]);

const SAFE_CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SENSITIVE_CORRELATION_MARKER =
  /(?:^sk-|(?:^|[._:-])(?:bearer|token|secret|password|api[_-]?key)(?:[._:-]|$))/i;
const MAX_SIGNAL_DEPTH = 5;
const MAX_SIGNAL_TEXT_LENGTH = 16_000;

interface ErrorSignals {
  rpcCodes: Set<number>;
  httpStatuses: Set<number>;
  codexErrorInfo: Set<string>;
  text: string[];
}

/** Convert provider-native or untyped Codex failures into a safe public error. */
export function classifyCodexError(
  error: unknown,
  options: ClassifyCodexErrorOptions = {},
): CanonicalCodexError {
  const category = classifySignals(collectErrorSignals(error));
  const descriptor = ERROR_DESCRIPTORS[category];
  const correlationId = safeCorrelationId(options.correlationId);
  return {
    code: descriptor.code,
    category,
    retryable: descriptor.retryable,
    publicMessage: descriptor.publicMessage,
    nextAction: descriptor.nextAction,
    ...(correlationId ? { correlationId } : {}),
  };
}

function classifySignals(signals: ErrorSignals): CodexErrorCategory {
  if (signals.rpcCodes.has(-32001)) return "overloaded";

  const text = signals.text.join("\n");
  if (/\bno rollout found(?: for thread id)?\b/i.test(text)) {
    return "no_rollout";
  }

  if (signals.codexErrorInfo.has("unauthorized")) return "auth";
  if (
    signals.codexErrorInfo.has("contextWindowExceeded") ||
    signals.codexErrorInfo.has("sessionBudgetExceeded") ||
    signals.codexErrorInfo.has("usageLimitExceeded")
  ) {
    return "quota";
  }
  if (signals.codexErrorInfo.has("sandboxError")) return "sandbox";
  if (signals.codexErrorInfo.has("cyberPolicy")) return "permission";
  if (
    signals.codexErrorInfo.has("serverOverloaded") ||
    signals.codexErrorInfo.has("internalServerError") ||
    signals.codexErrorInfo.has("httpConnectionFailed") ||
    signals.codexErrorInfo.has("responseStreamConnectionFailed") ||
    signals.codexErrorInfo.has("responseStreamDisconnected") ||
    signals.codexErrorInfo.has("responseTooManyFailedAttempts")
  ) {
    return classifyHttpStatus(signals.httpStatuses) ?? "overloaded";
  }

  const httpCategory = classifyHttpStatus(signals.httpStatuses);
  if (httpCategory) return httpCategory;

  if (
    /\b(?:unauthori[sz]ed|authentication failed|not authenticated|login required|invalid api key)\b|\b401\b/i.test(
      text,
    )
  ) {
    return "auth";
  }
  if (
    /\b(?:usage limit|quota|rate limit|context window|session budget|budget exceeded|too many tokens)\b|\b429\b/i.test(
      text,
    )
  ) {
    return "quota";
  }
  if (/\bsandbox(?:ed| error| denied| violation)?\b/i.test(text)) {
    return "sandbox";
  }
  if (
    /\b(?:permission denied|operation not permitted|access denied|policy denied|forbidden|eacces|eperm)\b|\b403\b/i.test(
      text,
    )
  ) {
    return "permission";
  }
  if (
    /\b(?:attachment|upload|mime type|file too large|unsupported file|unsupported format)\b|(?:failed|unable) to (?:read|parse|download) (?:the )?(?:attachment|file)/i.test(
      text,
    )
  ) {
    return "attachment";
  }
  if (
    /\b(?:app-server|codex process|provider process|child process)\b[^\n]*(?:exited|terminated|closed|crashed)|\bspawn\b[^\n]*\b(?:enoent|eacces)\b/i.test(
      text,
    )
  ) {
    return "process_exit";
  }
  if (
    /\b(?:server overloaded|service unavailable|temporarily unavailable|too many requests)\b|\b(?:502|503|504)\b/i.test(
      text,
    )
  ) {
    return "overloaded";
  }
  return "unknown";
}

function classifyHttpStatus(
  statuses: ReadonlySet<number>,
): CodexErrorCategory | undefined {
  if (statuses.has(401)) return "auth";
  if (statuses.has(403)) return "permission";
  if (statuses.has(429)) return "quota";
  if (statuses.has(502) || statuses.has(503) || statuses.has(504)) {
    return "overloaded";
  }
  return undefined;
}

function collectErrorSignals(error: unknown): ErrorSignals {
  const signals: ErrorSignals = {
    rpcCodes: new Set(),
    httpStatuses: new Set(),
    codexErrorInfo: new Set(),
    text: [],
  };
  const seen = new Set<object>();

  const visit = (value: unknown, depth: number): void => {
    if (depth > MAX_SIGNAL_DEPTH || value === null || value === undefined) {
      return;
    }
    if (typeof value === "string") {
      signals.text.push(value.slice(0, MAX_SIGNAL_TEXT_LENGTH));
      if (CODEX_ERROR_INFO_NAMES.has(value)) {
        signals.codexErrorInfo.add(value);
      }
      return;
    }
    if (typeof value !== "object" || seen.has(value)) return;
    seen.add(value);

    if (value instanceof Error) {
      visit(value.name, depth + 1);
      visit(value.message, depth + 1);
      visit(value.cause, depth + 1);
    }

    const record = value as Record<string, unknown>;
    addNumberSignal(safeRead(record, "code"), signals.rpcCodes);
    addNumberSignal(safeRead(record, "httpStatusCode"), signals.httpStatuses);
    addNumberSignal(safeRead(record, "statusCode"), signals.httpStatuses);
    addNumberSignal(safeRead(record, "status"), signals.httpStatuses);

    for (const field of ["message", "reason", "stderr", "additionalDetails"]) {
      visit(safeRead(record, field), depth + 1);
    }

    for (const infoName of CODEX_ERROR_INFO_NAMES) {
      if (safeRead(record, infoName) !== undefined) {
        signals.codexErrorInfo.add(infoName);
        visit(safeRead(record, infoName), depth + 1);
      }
    }

    for (const field of [
      "error",
      "cause",
      "data",
      "details",
      "codexErrorInfo",
      "errorInfo",
      "turn",
    ]) {
      visit(safeRead(record, field), depth + 1);
    }
  };

  visit(error, 0);
  return signals;
}

function addNumberSignal(value: unknown, target: Set<number>): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    target.add(value);
    return;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    target.add(Number(value));
  }
}

function safeRead(record: Record<string, unknown>, key: string): unknown {
  try {
    return record[key];
  } catch {
    return undefined;
  }
}

function safeCorrelationId(value: unknown): string | undefined {
  return typeof value === "string" &&
    SAFE_CORRELATION_ID.test(value) &&
    !SENSITIVE_CORRELATION_MARKER.test(value)
    ? value
    : undefined;
}
