import { CODEX_PROTOCOL_BASELINE } from "./codex-protocol/baseline.js";
import type { ReviewDelivery } from "./codex-protocol/generated/v2/ReviewDelivery.js";
import type { ReviewStartResponse } from "./codex-protocol/generated/v2/ReviewStartResponse.js";
import type { ReviewTarget } from "./codex-protocol/generated/v2/ReviewTarget.js";
import type { SkillsListResponse } from "./codex-protocol/generated/v2/SkillsListResponse.js";
import type { ThreadGoal } from "./codex-protocol/generated/v2/ThreadGoal.js";
import type { ThreadGoalStatus } from "./codex-protocol/generated/v2/ThreadGoalStatus.js";

export type CodexStableNativeControlMethod =
  | "skills/list"
  | "review/start"
  | "thread/compact/start"
  | "thread/goal/get"
  | "thread/goal/set"
  | "thread/goal/clear"
  | "thread/shellCommand";

export type CodexExperimentalNativeControlMethod =
  | "thread/backgroundTerminals/list"
  | "thread/backgroundTerminals/terminate"
  | "thread/backgroundTerminals/clean";

export type CodexNativeControlMethod =
  | CodexStableNativeControlMethod
  | CodexExperimentalNativeControlMethod;

/** Stable control surface pinned to the checked-in Codex protocol manifest. */
export const CODEX_NATIVE_CAPABILITIES = Object.freeze({
  codexVersion: CODEX_PROTOCOL_BASELINE.codexVersion,
  experimentalApi: false,
  methods: Object.freeze({
    "skills/list": true,
    "review/start": true,
    "thread/compact/start": true,
    "thread/goal/get": true,
    "thread/goal/set": true,
    "thread/goal/clear": true,
    "thread/shellCommand": true,
    "thread/backgroundTerminals/list": false,
    "thread/backgroundTerminals/terminate": false,
    "thread/backgroundTerminals/clean": false,
  }),
}) satisfies CodexNativeCapabilities;

export interface CodexNativeCapabilities {
  readonly codexVersion: string;
  readonly experimentalApi: boolean;
  readonly methods: Readonly<Record<CodexNativeControlMethod, boolean>>;
}

export function isCodexNativeControlMethod(
  value: unknown,
): value is CodexNativeControlMethod {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(
      CODEX_NATIVE_CAPABILITIES.methods,
      value,
    )
  );
}

export type CodexNativeControlRequest =
  | {
      control: "skills/list";
      forceReload?: boolean;
    }
  | {
      control: "review/start";
      target: ReviewTarget;
      delivery?: ReviewDelivery;
    }
  | {
      control: "thread/compact/start";
    }
  | {
      control: "thread/goal/get";
    }
  | {
      control: "thread/goal/set";
      objective?: string | null;
      status?: ThreadGoalStatus | null;
      tokenBudget?: number | null;
    }
  | {
      control: "thread/goal/clear";
    }
  | {
      control: "thread/shellCommand";
      command: string;
      /** Shell commands run unsandboxed, so callers must confirm explicitly. */
      confirmed: boolean;
    }
  | {
      control: "thread/backgroundTerminals/list";
      cursor?: string | null;
      limit?: number | null;
    }
  | {
      control: "thread/backgroundTerminals/terminate";
      processId: string;
    }
  | {
      control: "thread/backgroundTerminals/clean";
    };

export interface CodexNativeControlDataMap {
  "skills/list": SkillsListResponse;
  "review/start": ReviewStartResponse;
  "thread/compact/start": Record<string, never>;
  "thread/goal/get": { goal: ThreadGoal | null };
  "thread/goal/set": { goal: ThreadGoal };
  "thread/goal/clear": { cleared: boolean };
  "thread/shellCommand": Record<string, never>;
}

export type CodexNativeControlSuccess = {
  [Method in keyof CodexNativeControlDataMap]: {
    ok: true;
    control: Method;
    data: CodexNativeControlDataMap[Method];
  };
}[keyof CodexNativeControlDataMap];

export type CodexNativeControlErrorCode =
  | "unsupported_provider"
  | "unsupported_method"
  | "experimental_api_disabled"
  | "not_ready"
  | "invalid_request"
  | "provider_error";

export interface CodexNativeControlFailure {
  ok: false;
  control: CodexNativeControlMethod;
  error: {
    code: CodexNativeControlErrorCode;
    message: string;
    retryable: boolean;
  };
}

export type CodexNativeControlResult =
  | CodexNativeControlSuccess
  | CodexNativeControlFailure;

export interface CodexSessionControls {
  readonly capabilities: CodexNativeCapabilities;
  invoke(request: CodexNativeControlRequest): Promise<CodexNativeControlResult>;
}

export function codexControlFailure(
  control: CodexNativeControlMethod,
  code: CodexNativeControlErrorCode,
  message: string,
  retryable = false,
): CodexNativeControlFailure {
  return {
    ok: false,
    control,
    error: { code, message, retryable },
  };
}
