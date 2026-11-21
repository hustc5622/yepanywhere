/**
 * Antigravity CLI (`agy`) sign-in state exposed to clients. Credentials live
 * in the OS keyring of the Yep host; neither the authorization code nor any
 * token is ever echoed back.
 */
export type AgyLoginStatus =
  /** Waiting for the user to paste the authorization code. */
  | "pending"
  /** Code submitted; agy is exchanging it and Yep is verifying. */
  | "submitting"
  | "completed"
  | "failed"
  | "canceled";

export interface AgyLoginState {
  status: AgyLoginStatus;
  /** Google OAuth URL printed by `agy acp --login`. */
  authUrl: string | null;
  error: string | null;
  startedAt: string;
}

export interface AgyAccountResponse {
  installed: boolean;
  authenticated: boolean;
  /** Absolute path of the agy binary Yep uses, when installed. */
  agyPath: string | null;
  login: AgyLoginState | null;
}

/**
 * One quota window as `agy -p /usage --output-format json` reports it.
 * `window` is agy's own name (`5h`, `weekly`, or whatever it adds next).
 */
export interface AgyUsageBucket {
  id: string;
  name: string;
  window: string;
  /** 0..1, exactly as agy reports it. */
  remainingFraction: number;
  /** RFC3339 UTC, or null when agy reported no reset time. */
  resetTime: string | null;
}

/** Models in a group share its weekly and five-hour limits. */
export interface AgyUsageGroup {
  name: string;
  /** Parsed from `Models within this group: …`; empty when not listed. */
  models: string[];
  buckets: AgyUsageBucket[];
}

export interface AgyCredits {
  remaining: number;
  upgradeUrl: string | null;
}

export type AgyUsageState =
  | "ok"
  | "not-installed"
  | "signed-out"
  /** agy itself reported no quota (e.g. enterprise workspace). */
  | "unavailable"
  /** Spawn failure, timeout, or an answer Yep could not parse. */
  | "error";

export interface AgyUsageResponse {
  state: AgyUsageState;
  groups: AgyUsageGroup[];
  /** `/credits` answer; null when it was not available. */
  credits: AgyCredits | null;
  message: string | null;
  fetchedAt: string | null;
}
