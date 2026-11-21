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
