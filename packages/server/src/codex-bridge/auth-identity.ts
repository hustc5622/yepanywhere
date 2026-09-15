import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Identity only: ordinary OAuth token rotation must not replace an app-server. */
export async function readCodexAuthIdentity(
  home: string,
): Promise<string | null> {
  try {
    const auth = JSON.parse(await readFile(join(home, "auth.json"), "utf8"));
    // Match AuthDotJson::resolved_mode; an explicit mode takes precedence.
    const mode =
      auth?.auth_mode ??
      (auth?.personal_access_token
        ? "personalAccessToken"
        : auth?.bedrock_api_key || auth?.bedrock_access_keys
          ? "bedrock"
          : auth?.OPENAI_API_KEY != null
            ? "apikey"
            : "chatgpt");
    const tokens = auth?.tokens;
    let subject: unknown;
    try {
      subject = JSON.parse(
        Buffer.from(
          tokens?.id_token?.split(".")[1] ?? "",
          "base64url",
        ).toString(),
      ).sub;
    } catch {
      // Older auth files can identify the account without an ID token.
    }
    const identity =
      mode === "chatgpt" &&
      typeof tokens?.account_id === "string" &&
      tokens.account_id
        ? ["chatgpt", tokens.account_id, subject ?? null]
        : mode === "apikey" &&
            typeof auth?.OPENAI_API_KEY === "string" &&
            auth.OPENAI_API_KEY
          ? ["apikey", auth.OPENAI_API_KEY]
          : null;
    if (!identity) return null;
    return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  } catch {
    // Keyring storage, logout and partial writes are not proof of a new login.
    // The bridge also invalidates a generation on Codex's account-mismatch error.
    return null;
  }
}

export const CODEX_ACCOUNT_MISMATCH_MESSAGE =
  "Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.";
