/**
 * CLI setup commands for headless authentication configuration.
 *
 * These commands allow setting up auth without the web interface,
 * useful for headless/automated deployments.
 */

import { AuthService } from "./auth/AuthService.js";
import { getDataDir } from "./config.js";

export interface SetupAuthOptions {
  password: string;
  /** Data directory override (defaults to the resolved Yep data dir). */
  dataDir?: string;
}

/**
 * Set up local cookie-based authentication.
 * Creates or updates the password in auth.json.
 *
 * A running server notices the rewrite on its next login attempt and adopts the
 * new password (see AuthService.refreshAccountFromDisk), and it drops the login
 * lockout earned by the previous password, so no restart is required.
 */
export async function setupAuth(options: SetupAuthOptions): Promise<void> {
  const { password } = options;

  if (!password || password.length < 6) {
    throw new Error("Password must be at least 6 characters");
  }

  const dataDir = options.dataDir ?? getDataDir();
  const authService = new AuthService({ dataDir });
  await authService.initialize();

  await authService.enableAuth(password);
  console.log("Local authentication configured successfully.");
  console.log(`Auth file: ${authService.getFilePath()}`);
  console.log(
    "A running server picks this up on the next login attempt; existing login lockouts are cleared.",
  );
}
