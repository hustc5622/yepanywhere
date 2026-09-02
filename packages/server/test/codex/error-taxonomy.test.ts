import { describe, expect, it } from "vitest";
import {
  type CanonicalCodexErrorCode,
  type CodexErrorCategory,
  classifyCodexError,
} from "../../src/codex/error-taxonomy.js";

interface ErrorCase {
  name: string;
  input: unknown;
  code: CanonicalCodexErrorCode;
  category: CodexErrorCategory;
  retryable: boolean;
  quotaKind?:
    | "usage_limit"
    | "context_window"
    | "session_budget"
    | "rate_limit";
}

const CASES: ErrorCase[] = [
  {
    name: "empty thread without a rollout",
    input: new Error(
      "no rollout found for thread id thread-secret at /Users/alice/private/repository",
    ),
    code: "CODEX_NO_ROLLOUT",
    category: "no_rollout",
    retryable: true,
  },
  {
    name: "JSON-RPC overload",
    input: {
      error: {
        code: -32001,
        message: "raw-provider-diagnostic token=sk-secret-token",
      },
    },
    code: "CODEX_OVERLOADED",
    category: "overloaded",
    retryable: true,
  },
  {
    name: "native unauthorized info",
    input: {
      error: {
        codexErrorInfo: "unauthorized",
        message: "Bearer private-token",
      },
    },
    code: "CODEX_AUTH_REQUIRED",
    category: "auth",
    retryable: false,
  },
  {
    name: "native usage limit info",
    input: {
      codexErrorInfo: "usageLimitExceeded",
      additionalDetails: "raw-provider-diagnostic",
    },
    code: "CODEX_QUOTA_EXCEEDED",
    category: "quota",
    retryable: true,
    quotaKind: "usage_limit",
  },
  {
    name: "native cyber policy info",
    input: {
      codexErrorInfo: "cyberPolicy",
      message: "permission denied for /Users/alice/private/repository",
    },
    code: "CODEX_PERMISSION_DENIED",
    category: "permission",
    retryable: false,
  },
  {
    name: "attachment parsing failure",
    input: new Error(
      "failed to parse attachment /private/tmp/confidential.pdf: sk-secret-token",
    ),
    code: "CODEX_ATTACHMENT_FAILED",
    category: "attachment",
    retryable: false,
  },
  {
    name: "app-server process exit",
    input: new Error(
      "Codex app-server exited (code=1): raw-provider-diagnostic sk-secret-token",
    ),
    code: "CODEX_PROCESS_EXITED",
    category: "process_exit",
    retryable: true,
  },
  {
    name: "bridge-owned session reconnect failure",
    input: new Error("Codex bridge execution failed", {
      cause: new Error("Unexpected server response: 401"),
    }),
    code: "CODEX_BRIDGE_UNAVAILABLE",
    category: "bridge",
    retryable: true,
  },
  {
    name: "native sandbox error",
    input: {
      codexErrorInfo: "sandboxError",
      additionalDetails: "/Users/alice/private/repository",
    },
    code: "CODEX_SANDBOX_DENIED",
    category: "sandbox",
    retryable: false,
  },
  {
    name: "unknown raw error",
    input: new Error(
      "raw-provider-diagnostic sk-secret-token /Users/alice/private/repository",
    ),
    code: "CODEX_UNKNOWN",
    category: "unknown",
    retryable: false,
  },
];

describe("Codex canonical error taxonomy", () => {
  it.each(CASES)(
    "classifies $name while retaining original diagnostics",
    ({ input, code, category, retryable, quotaKind }) => {
      const classified = classifyCodexError(input);

      expect(classified).toMatchObject({
        code,
        category,
        retryable,
        ...(quotaKind ? { quotaKind } : {}),
      });
      expect(classified.publicMessage).toMatch(/[A-Za-z]/u);
      expect(classified.nextAction).toMatch(/[A-Za-z]/u);
      expect(classified.publicMessage).not.toMatch(/[\u4e00-\u9fff]/u);
      expect(classified.nextAction).not.toMatch(/[\u4e00-\u9fff]/u);
      const record = input as {
        message?: string;
        error?: { message?: string };
      };
      const original =
        input instanceof Error
          ? input.message
          : (record.message ?? record.error?.message);
      if (original) expect(classified.publicMessage).toBe(original);
      expect(classified).not.toHaveProperty("diagnosticMessage");
      expect(classified).not.toHaveProperty("stack");
    },
  );

  it("maps native connection error status without exposing its payload", () => {
    const classified = classifyCodexError({
      codexErrorInfo: {
        responseStreamConnectionFailed: {
          httpStatusCode: 503,
          stderr: "raw-provider-diagnostic sk-secret-token",
        },
      },
    });

    expect(classified).toMatchObject({
      code: "CODEX_OVERLOADED",
      category: "overloaded",
      retryable: true,
    });
    expect(JSON.stringify(classified)).not.toContain("sk-secret-token");
  });

  it("returns only an explicitly supplied safe correlation id", () => {
    const input = {
      message: "raw-provider-diagnostic",
      correlationId: "raw-object-id-must-not-be-used",
    };

    expect(
      classifyCodexError(input, { correlationId: "feishu:dispatch-123" }),
    ).toMatchObject({ correlationId: "feishu:dispatch-123" });
    expect(classifyCodexError(input)).not.toHaveProperty("correlationId");
    expect(
      classifyCodexError(input, {
        correlationId: "token=sk-secret-token /Users/alice/private/repository",
      }),
    ).not.toHaveProperty("correlationId");
    expect(
      classifyCodexError(input, { correlationId: "sk-secret-token" }),
    ).toHaveProperty("correlationId", "sk-secret-token");
  });
});
