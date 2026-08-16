import type { ProviderName, SessionBranchState } from "@yep-anywhere/shared";
import {
  type ResumeSessionResponse,
  type ResumeSessionStartedResponse,
  isQueuedResumeSessionResponse,
} from "../api/client";

export class HistoricalEditQueueError extends Error {
  readonly retrySafe: boolean;

  constructor(message: string, retrySafe: boolean) {
    super(message);
    this.name = "HistoricalEditQueueError";
    this.retrySafe = retrySafe;
  }
}

export async function requireStartedHistoricalEdit(
  response: ResumeSessionResponse,
  cancelQueuedRequest: (queueId: string) => Promise<{ cancelled: boolean }>,
  requestLabel = "historical edit",
): Promise<ResumeSessionStartedResponse> {
  if (!isQueuedResumeSessionResponse(response)) return response;

  let cancellation: { cancelled: boolean };
  try {
    cancellation = await cancelQueuedRequest(response.queueId);
  } catch {
    throw new HistoricalEditQueueError(
      `The ${requestLabel} was queued, but cancellation could not be confirmed. Stay on this page and do not retry until its status is known.`,
      false,
    );
  }

  if (!cancellation.cancelled) {
    throw new HistoricalEditQueueError(
      `The ${requestLabel} was queued but could not be cancelled. Stay on this page and do not retry until its status is known.`,
      false,
    );
  }

  throw new HistoricalEditQueueError(
    `The ${requestLabel} did not start because all workers are busy (queue position ${response.position}). The queued request was cancelled; retry when a worker is available.`,
    true,
  );
}

export function shouldRestoreHistoricalEditAfterFailure(
  error: unknown,
  requestStarted: boolean,
  postAttempted: boolean,
): boolean {
  if (requestStarted) return false;
  if (error instanceof HistoricalEditQueueError) return error.retrySafe;
  if (!postAttempted) return true;

  // fetchJSON attaches a numeric status only after the server explicitly
  // rejected the POST. A transport failure has no such proof, so retrying it
  // could duplicate a request that the server already accepted.
  return (
    error instanceof Error &&
    typeof (error as Error & { status?: unknown }).status === "number"
  );
}

export type SessionEditSubmission =
  | {
      kind: "codex-fork";
      rollbackNumTurns: number;
      optimisticTruncate: false;
      refreshSameSessionBranches: false;
    }
  | {
      kind: "claude-resume";
      resumeSessionAt: string;
      optimisticTruncate: true;
      refreshSameSessionBranches: true;
    }
  | {
      kind: "opencode-fork";
      resumeSessionAt: string;
      optimisticTruncate: false;
      refreshSameSessionBranches: false;
    }
  | { kind: "start-new" }
  | { kind: "invalid-codex-boundary" }
  | { kind: "unsupported" };

export interface EditablePromptIdentity {
  uuid: string;
  parentUuid: string | null;
  rollbackNumTurns?: number | null;
}

export function isOpenCodeProvider(
  provider: ProviderName | string | undefined | null,
): provider is "opencode" | "pi" {
  return provider === "opencode" || provider === "pi";
}

export function supportsHistoricalMessageEditing(
  provider: ProviderName | string | undefined | null,
): boolean {
  return (
    provider == null ||
    provider === "claude" ||
    provider === "codex" ||
    provider === "opencode" ||
    provider === "pi" ||
    provider === "zcode"
  );
}

/**
 * OpenCode, Pi, and ZCode can only fork at an authoritative native message ID.
 * Their live echo temporarily carries a Yep UUID, so editing stays
 * unavailable until the persisted message replaces that echo. Other
 * supported providers retain their existing edit behavior.
 */
export function canEditPersistedUserPrompt(
  provider: ProviderName | string | undefined | null,
  source: "sdk" | "jsonl" | undefined,
): boolean {
  if (!supportsHistoricalMessageEditing(provider)) return false;
  return (
    (!isOpenCodeProvider(provider) && provider !== "zcode") ||
    source === "jsonl"
  );
}

export function resolveSessionEditSubmission(
  provider: ProviderName | string | undefined | null,
  edit: EditablePromptIdentity,
): SessionEditSubmission {
  if (provider === "codex") {
    return edit.rollbackNumTurns && edit.rollbackNumTurns > 0
      ? {
          kind: "codex-fork",
          rollbackNumTurns: edit.rollbackNumTurns,
          optimisticTruncate: false,
          refreshSameSessionBranches: false,
        }
      : { kind: "invalid-codex-boundary" };
  }

  if (isOpenCodeProvider(provider) || provider === "zcode") {
    return {
      // The "opencode-fork" submission shape is provider-agnostic: SessionPage
      // only consumes `resumeSessionAt` and navigates to the returned fork id.
      kind: "opencode-fork",
      // The native fork excludes this message and everything after it.
      // This must be the persisted user message's own native ID.
      resumeSessionAt: edit.uuid,
      optimisticTruncate: false,
      refreshSameSessionBranches: false,
    };
  }

  if (provider == null || provider === "claude") {
    return edit.parentUuid
      ? {
          kind: "claude-resume",
          resumeSessionAt: edit.parentUuid,
          optimisticTruncate: true,
          refreshSameSessionBranches: true,
        }
      : { kind: "start-new" };
  }

  return { kind: "unsupported" };
}

export interface BranchNavigationTarget {
  branchId: string;
  sessionId: string;
  crossesSession: boolean;
  focusBranchId: string;
  focusMessageId: string;
}

export interface BranchNavigationFocus {
  branchId: string | null;
  messageId: string | null;
}

export function resolveBranchNavigationFocus(
  navigationState:
    | { targetBranchId?: string; targetMessageId?: string }
    | null
    | undefined,
  selectedBranchId?: string,
): BranchNavigationFocus {
  const branchId = navigationState?.targetBranchId ?? selectedBranchId ?? null;
  return {
    branchId,
    messageId:
      navigationState?.targetMessageId ??
      navigationState?.targetBranchId ??
      selectedBranchId ??
      null,
  };
}

export function resolveBranchNavigationTarget(
  branchId: string,
  currentSessionId: string,
  branchState: SessionBranchState | undefined,
): BranchNavigationTarget {
  const option = branchState?.branches.find(
    (candidate) => candidate.id === branchId,
  );
  const sessionId = option?.sessionId ?? currentSessionId;
  return {
    branchId,
    sessionId,
    crossesSession: sessionId !== currentSessionId,
    focusBranchId: branchId,
    focusMessageId: branchId,
  };
}
