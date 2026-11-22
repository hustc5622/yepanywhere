/**
 * Yep-driven sign-in for Antigravity CLI.
 *
 * `agy acp --login` is agy's terminal sign-in (works over SSH): it prints a
 * Google OAuth URL on stdout, then reads the authorization code — or the full
 * URL of the page the browser lands on — from stdin and exits 0 on success.
 * A bad code exits 1 with `couldn't log in: …` on stderr and leaves any
 * existing sign-in untouched (references/antigravity/README.md).
 *
 * The child runs on the Yep host, so the credentials land in that host's
 * keyring exactly as if the user had signed in from a terminal there. Yep
 * never sees a token; the code passes straight through to agy's stdin and is
 * never logged.
 */

import { type ChildProcess, spawn } from "node:child_process";
import type {
  AgyAccountResponse,
  AgyLoginState,
  AgyLoginStatus,
} from "@yep-anywhere/shared";
import { getLogger } from "../../logging/logger.js";
import { ACPClient } from "./acp/client.js";
import { type AgyProvider, agySpawnEnv, findAgyPath } from "./agy.js";

const URL_TIMEOUT_MS = 30_000;
/** How long a started sign-in waits for the user to paste the code. */
const CODE_TIMEOUT_MS = 15 * 60_000;
/** How long agy may take to exchange a submitted code. */
const EXCHANGE_TIMEOUT_MS = 60_000;
const LOGOUT_TIMEOUT_MS = 30_000;
const OUTPUT_TAIL = 4_000;

const log = getLogger();

/** First `https://` URL in agy's sign-in banner. */
export function parseAgyLoginUrl(output: string): string | null {
  const match = /https:\/\/\S+/u.exec(output);
  return match ? match[0] : null;
}

/** agy's own failure text, e.g. `couldn't log in: token exchange failed: …`. */
export function agyLoginErrorText(stderr: string, stdout: string): string {
  const lines = `${stderr}\n${stdout}`
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const reported =
    lines.find((line) => /couldn't log in|error|failed/i.test(line)) ??
    lines.at(-1);
  return (reported ?? "Sign-in failed").slice(0, 500);
}

/**
 * Accept one pasted line: an authorization code or the landing page URL.
 * Anything multi-line would feed extra input to agy, so it is rejected.
 */
export function normalizeAgyLoginCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim();
  if (!code || code.length > 4096 || /[\r\n]/u.test(code)) return null;
  return code;
}

interface ActiveLogin {
  state: AgyLoginState;
  child: ChildProcess;
  stdout: string;
  stderr: string;
  timer: ReturnType<typeof setTimeout>;
}

export class AgyLoginService {
  private active: ActiveLogin | null = null;
  private finished: AgyLoginState | null = null;

  constructor(
    private readonly provider: Pick<
      AgyProvider,
      "isInstalled" | "getAuthStatus" | "refreshAuthStatus"
    >,
    private readonly resolveAgyPath: () => Promise<string | null> = () =>
      findAgyPath(),
  ) {}

  getLoginState(): AgyLoginState | null {
    return this.active ? { ...this.active.state } : this.finished;
  }

  async getAccount(
    options: { fresh?: boolean } = {},
  ): Promise<AgyAccountResponse> {
    const agyPath = await this.resolveAgyPath();
    if (!agyPath) {
      return {
        installed: false,
        authenticated: false,
        agyPath: null,
        login: this.getLoginState(),
      };
    }
    const authenticated = options.fresh
      ? await this.provider.refreshAuthStatus()
      : (await this.provider.getAuthStatus()).authenticated;
    return {
      installed: true,
      authenticated,
      agyPath,
      login: this.getLoginState(),
    };
  }

  /** Start (or restart) a sign-in and resolve once the OAuth URL is known. */
  async startLogin(): Promise<AgyLoginState> {
    this.cancelLogin();
    const agyPath = await this.resolveAgyPath();
    if (!agyPath) throw new Error("Antigravity CLI (agy) is not installed");

    const child = spawn(agyPath, ["acp", "--login"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(await agySpawnEnv(agyPath)) },
    });
    const login: ActiveLogin = {
      state: {
        status: "pending",
        authUrl: null,
        error: null,
        startedAt: new Date().toISOString(),
      },
      child,
      stdout: "",
      stderr: "",
      timer: setTimeout(() => {
        this.finish(login, "failed", "Sign-in timed out");
      }, CODE_TIMEOUT_MS),
    };
    login.timer.unref?.();
    this.active = login;
    this.finished = null;

    const url = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("agy did not print a sign-in link"));
      }, URL_TIMEOUT_MS);
      timeout.unref?.();
      const settle = () => {
        const found = parseAgyLoginUrl(login.stdout);
        if (found) {
          clearTimeout(timeout);
          resolve(found);
        }
      };
      child.stdout?.on("data", (chunk: Buffer) => {
        login.stdout = (login.stdout + chunk.toString("utf8")).slice(
          -OUTPUT_TAIL,
        );
        settle();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        login.stderr = (login.stderr + chunk.toString("utf8")).slice(
          -OUTPUT_TAIL,
        );
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timeout);
        reject(new Error(agyLoginErrorText(login.stderr, login.stdout)));
      });
    });
    child.stdin?.on("error", () => {
      // EPIPE when agy exits first; its exit is reported separately.
    });
    child.once("exit", (code) => {
      void this.onExit(login, code);
    });

    try {
      login.state.authUrl = await url;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.finish(login, "failed", message);
      throw new Error(message);
    }
    log.info({ event: "agy_login_started" }, "Antigravity sign-in started");
    return { ...login.state };
  }

  /** Hand the pasted code to agy; resolves with the final state. */
  async submitCode(rawCode: unknown): Promise<AgyLoginState> {
    const login = this.active;
    if (!login || login.state.status !== "pending") {
      throw new Error("No Antigravity sign-in is waiting for a code");
    }
    const code = normalizeAgyLoginCode(rawCode);
    if (!code) throw new Error("Paste the authorization code or landing URL");
    login.state.status = "submitting";
    clearTimeout(login.timer);
    login.timer = setTimeout(() => {
      this.finish(login, "failed", "agy did not finish the sign-in in time");
    }, EXCHANGE_TIMEOUT_MS);
    login.timer.unref?.();
    const done = new Promise<void>((resolve) => {
      if (login.child.exitCode !== null) resolve();
      else login.child.once("exit", () => resolve());
    });
    login.child.stdin?.end(`${code}\n`);
    await done;
    // onExit verifies asynchronously; wait for it to settle the state.
    for (let i = 0; i < 800 && this.active === login; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return this.getLoginState() ?? { ...login.state };
  }

  cancelLogin(): void {
    const login = this.active;
    if (!login) return;
    this.finish(login, "canceled", null);
  }

  /**
   * Sign out through ACP `logout` (agy advertises `auth.logout`). This ends
   * the keyring session for every agy on the host, terminal ones included.
   */
  async logout(): Promise<void> {
    this.cancelLogin();
    const agyPath = await this.resolveAgyPath();
    if (!agyPath) throw new Error("Antigravity CLI (agy) is not installed");
    const client = new ACPClient();
    const timeout = setTimeout(() => client.close(), LOGOUT_TIMEOUT_MS);
    try {
      await client.connect({
        command: agyPath,
        args: ["acp"],
        cwd: process.cwd(),
        env: await agySpawnEnv(agyPath),
      });
      const init = await client.initialize({});
      const auth = (init.agentCapabilities as { auth?: { logout?: unknown } })
        ?.auth;
      if (!auth?.logout) {
        throw new Error(
          "This agy version does not support signing out over ACP",
        );
      }
      await client.logout();
      log.info({ event: "agy_logout" }, "Antigravity signed out");
    } finally {
      clearTimeout(timeout);
      client.close();
      await this.provider.refreshAuthStatus().catch(() => false);
    }
  }

  private async onExit(login: ActiveLogin, code: number | null): Promise<void> {
    if (this.active !== login) return;
    if (code !== 0) {
      this.finish(
        login,
        "failed",
        login.state.status === "pending"
          ? `agy exited before a code was submitted: ${agyLoginErrorText(login.stderr, login.stdout)}`
          : agyLoginErrorText(login.stderr, login.stdout),
      );
      return;
    }
    const authenticated = await this.provider
      .refreshAuthStatus()
      .catch(() => false);
    if (this.active !== login) return;
    this.finish(
      login,
      authenticated ? "completed" : "failed",
      authenticated
        ? null
        : "agy reported success but is still signed out; check the Yep host's keychain",
    );
  }

  private finish(
    login: ActiveLogin,
    status: Exclude<AgyLoginStatus, "pending" | "submitting">,
    error: string | null,
  ): void {
    if (this.active !== login) return;
    clearTimeout(login.timer);
    this.active = null;
    if (login.child.exitCode === null && !login.child.killed) {
      login.child.kill("SIGTERM");
    }
    // The OAuth link is single-use; never hand out a stale one.
    login.state = { ...login.state, status, error, authUrl: null };
    this.finished = { ...login.state };
    log.info(
      { event: "agy_login_finished", status, ...(error ? { error } : {}) },
      "Antigravity sign-in finished",
    );
  }
}

let shared: AgyLoginService | null = null;

/** Process-wide service backed by the registered agy provider. */
export async function getAgyLoginService(): Promise<AgyLoginService> {
  if (!shared) {
    const { agyProvider } = await import("./agy.js");
    shared = new AgyLoginService(agyProvider);
  }
  return shared;
}
