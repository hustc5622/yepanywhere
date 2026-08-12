/**
 * AuthService manages cookie-based authentication.
 *
 * Features:
 * - Single user account (self-hosted apps typically have one owner)
 * - Session-based auth with signed cookies
 * - Password hashing with bcrypt
 *
 * State is persisted to a JSON file for durability across server restarts.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import bcrypt from "bcrypt";
import { enforceOwnerReadWriteFilePermissions } from "../utils/filePermissions.js";
import { AUTH_ERROR_CODES, AuthError } from "./authErrors.js";
import { writePrivateJsonAtomic } from "./privateJsonFile.js";

const BCRYPT_ROUNDS = 12;
const SESSION_ID_BYTES = 32;

export interface AuthState {
  /** Schema version for future migrations */
  version: 2;
  /** Whether unauthenticated localhost access is allowed (bypasses desktop token floor) */
  localhostOpen?: boolean;
  /** Account credentials (undefined = setup mode) */
  account?: {
    /** bcrypt-hashed password */
    passwordHash: string;
    /** When account was created */
    createdAt: string;
  };
  /** Active sessions: sessionId -> session data */
  sessions: Record<string, AuthSession>;
}

export interface AuthSession {
  createdAt: string;
  lastActiveAt: string;
  userAgent?: string;
}

const CURRENT_VERSION = 2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAccount(value: unknown): AuthState["account"] {
  if (!isRecord(value)) {
    throw new Error("Invalid authentication account");
  }
  if (
    typeof value.passwordHash !== "string" ||
    value.passwordHash.length === 0 ||
    typeof value.createdAt !== "string" ||
    value.createdAt.length === 0
  ) {
    throw new Error("Invalid authentication account");
  }
  return {
    passwordHash: value.passwordHash,
    createdAt: value.createdAt,
  };
}

function parseSessions(value: unknown): Record<string, AuthSession> {
  if (!isRecord(value)) {
    throw new Error("Invalid authentication sessions");
  }
  const sessions: Record<string, AuthSession> = {};
  for (const [sessionId, sessionValue] of Object.entries(value)) {
    if (
      !isRecord(sessionValue) ||
      typeof sessionValue.createdAt !== "string" ||
      typeof sessionValue.lastActiveAt !== "string" ||
      (sessionValue.userAgent !== undefined &&
        typeof sessionValue.userAgent !== "string")
    ) {
      throw new Error("Invalid authentication sessions");
    }
    sessions[sessionId] = {
      createdAt: sessionValue.createdAt,
      lastActiveAt: sessionValue.lastActiveAt,
      ...(sessionValue.userAgent === undefined
        ? {}
        : { userAgent: sessionValue.userAgent }),
    };
  }
  return sessions;
}

function parseStoredState(value: unknown): {
  state: AuthState;
  migrated: boolean;
} {
  if (!isRecord(value)) {
    throw new Error("Invalid authentication configuration");
  }
  if (
    value.localhostOpen !== undefined &&
    typeof value.localhostOpen !== "boolean"
  ) {
    throw new Error("Invalid localhostOpen value");
  }

  if (value.version === 2) {
    const account =
      value.account === undefined ? undefined : parseAccount(value.account);
    return {
      state: {
        version: CURRENT_VERSION,
        ...(value.localhostOpen === true ? { localhostOpen: true } : {}),
        ...(account === undefined ? {} : { account }),
        sessions: parseSessions(value.sessions),
      },
      migrated: false,
    };
  }

  if (value.version === 1) {
    if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
      throw new Error("Invalid enabled value");
    }
    const enabled = value.enabled === true;
    const account = enabled ? parseAccount(value.account) : undefined;
    const sessions = parseSessions(value.sessions ?? {});
    return {
      state: {
        version: CURRENT_VERSION,
        ...(value.localhostOpen === true ? { localhostOpen: true } : {}),
        ...(account === undefined ? {} : { account }),
        sessions: enabled ? sessions : {},
      },
      migrated: true,
    };
  }

  throw new Error("Unsupported authentication configuration version");
}

export interface AuthServiceOptions {
  /** Directory to store auth state (defaults to dataDir) */
  dataDir: string;
  /** Session TTL in milliseconds (default: 30 days) */
  sessionTtlMs?: number;
  /** Cookie signing secret (auto-generated if not provided) */
  cookieSecret?: string;
}

export class AuthService {
  private state: AuthState;
  private dataDir: string;
  private filePath: string;
  private sessionTtlMs: number;
  private cookieSecret: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: AuthServiceOptions) {
    this.dataDir = options.dataDir;
    this.filePath = path.join(this.dataDir, "auth.json");
    this.sessionTtlMs = options.sessionTtlMs ?? 30 * 24 * 60 * 60 * 1000; // 30 days
    this.cookieSecret = options.cookieSecret ?? "";
    this.state = { version: CURRENT_VERSION, sessions: {} };
  }

  /**
   * Initialize the service by loading state from disk.
   * Creates the data directory if it doesn't exist.
   * Generates cookie secret if not provided.
   */
  async initialize(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    await enforceOwnerReadWriteFilePermissions(this.filePath, "[AuthService]");

    try {
      const content = await fs.readFile(this.filePath, "utf-8");
      const parsed = parseStoredState(JSON.parse(content));
      if (parsed.migrated) {
        await writePrivateJsonAtomic(this.filePath, parsed.state);
      }
      this.state = parsed.state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.state = { version: CURRENT_VERSION, sessions: {} };
      } else if (error instanceof AuthError) {
        throw error;
      } else {
        throw new AuthError(
          AUTH_ERROR_CODES.configError,
          "Authentication configuration could not be read",
          { cause: error },
        );
      }
    }

    // Generate cookie secret if not provided
    if (!this.cookieSecret) {
      this.cookieSecret = crypto.randomBytes(32).toString("hex");
    }

    // Clean up expired sessions on startup
    await this.cleanupExpiredSessions();
  }

  /**
   * Check if auth is enabled (via settings).
   */
  isEnabled(): boolean {
    return this.hasAccount();
  }

  /**
   * Check if unauthenticated localhost access is allowed (bypasses desktop token floor).
   */
  isLocalhostOpen(): boolean {
    return this.state.localhostOpen === true;
  }

  /**
   * Set whether unauthenticated localhost access is allowed.
   */
  async setLocalhostOpen(open: boolean): Promise<void> {
    await this.enqueueWrite(async () => {
      const targetState: AuthState = {
        version: CURRENT_VERSION,
        ...(this.state.account ? { account: this.state.account } : {}),
        sessions: this.state.sessions,
        ...(open ? { localhostOpen: true } : {}),
      };
      await writePrivateJsonAtomic(this.filePath, targetState);
      this.state = targetState;
    });
  }

  /**
   * Check if an account has been set up.
   */
  hasAccount(): boolean {
    return !!this.state.account;
  }

  /**
   * Get the path to the auth state file (for recovery instructions).
   */
  getFilePath(): string {
    return this.filePath;
  }

  /**
   * Enable auth with a password. Creates account if needed.
   * This is the main way to enable auth from the settings UI.
   *
   */
  async setLoginPassword(newPassword: string): Promise<void> {
    if (newPassword.length < 6) {
      throw new AuthError(
        AUTH_ERROR_CODES.passwordInvalid,
        "Password must be at least 6 characters",
      );
    }
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await this.enqueueWrite(async () => {
      const targetState: AuthState = {
        version: CURRENT_VERSION,
        localhostOpen: this.state.localhostOpen,
        account: {
          passwordHash,
          createdAt: new Date().toISOString(),
        },
        sessions: {},
      };
      await writePrivateJsonAtomic(this.filePath, targetState);
      this.state = targetState;
    });
  }

  /**
   * Disable auth and clear credentials.
   *
   * This is intentionally destructive: when auth is turned off, the server
   * returns to the default localhost/no-auth baseline. Re-enabling auth later
   * should behave like fresh setup with a new password.
   */
  async disableAuth(): Promise<void> {
    await this.enqueueWrite(async () => {
      const targetState: AuthState = {
        version: CURRENT_VERSION,
        localhostOpen: this.state.localhostOpen,
        sessions: {},
      };
      await writePrivateJsonAtomic(this.filePath, targetState);
      this.state = targetState;
    });
  }

  /**
   * Verify a password against the stored hash.
   */
  async verifyPassword(password: string): Promise<boolean> {
    if (!this.state.account) {
      return false;
    }
    return bcrypt.compare(password, this.state.account.passwordHash);
  }

  /**
   * Verify the current login password and create a session only if the
   * credential is still current when the session write reaches the queue.
   */
  async createSessionForPassword(
    password: string,
    userAgent?: string,
  ): Promise<string | null> {
    const passwordHash = this.state.account?.passwordHash;
    if (!passwordHash || !(await bcrypt.compare(password, passwordHash))) {
      return null;
    }

    return this.enqueueWrite(async () => {
      if (this.state.account?.passwordHash !== passwordHash) {
        return null;
      }
      return this.persistNewSession(userAgent);
    });
  }

  /**
   * Create a new session and return the session ID.
   */
  async createSession(userAgent?: string): Promise<string> {
    return this.enqueueWrite(() => this.persistNewSession(userAgent));
  }

  private async persistNewSession(userAgent?: string): Promise<string> {
    const sessionId = crypto.randomBytes(SESSION_ID_BYTES).toString("hex");
    const now = new Date().toISOString();

    const targetState: AuthState = {
      version: CURRENT_VERSION,
      ...(this.state.localhostOpen ? { localhostOpen: true } : {}),
      ...(this.state.account ? { account: this.state.account } : {}),
      sessions: {
        ...this.state.sessions,
        [sessionId]: {
          createdAt: now,
          lastActiveAt: now,
          userAgent,
        },
      },
    };
    await writePrivateJsonAtomic(this.filePath, targetState);
    this.state = targetState;

    return sessionId;
  }

  /**
   * Validate a session ID and update last active time.
   * Returns true if valid, false if expired or not found.
   */
  async validateSession(sessionId: string): Promise<boolean> {
    return this.enqueueWrite(async () => {
      const session = this.state.sessions[sessionId];
      if (!session) {
        return false;
      }

      const sessions = { ...this.state.sessions };
      const createdAt = new Date(session.createdAt).getTime();
      const now = Date.now();
      if (now - createdAt <= this.sessionTtlMs) {
        return true;
      }

      delete sessions[sessionId];
      const targetState = this.withSessions(sessions);
      await writePrivateJsonAtomic(this.filePath, targetState);
      this.state = targetState;
      return false;
    });
  }

  /**
   * Invalidate a session (logout).
   */
  async invalidateSession(sessionId: string): Promise<void> {
    await this.enqueueWrite(async () => {
      if (!this.state.sessions[sessionId]) {
        return;
      }
      const sessions = { ...this.state.sessions };
      delete sessions[sessionId];
      const targetState = this.withSessions(sessions);
      await writePrivateJsonAtomic(this.filePath, targetState);
      this.state = targetState;
    });
  }

  /**
   * Invalidate all sessions (logout everywhere).
   */
  async invalidateAllSessions(): Promise<void> {
    await this.enqueueWrite(async () => {
      const targetState = this.withSessions({});
      await writePrivateJsonAtomic(this.filePath, targetState);
      this.state = targetState;
    });
  }

  /**
   * Get the cookie secret for signing.
   */
  getCookieSecret(): string {
    return this.cookieSecret;
  }

  /**
   * Clean up expired sessions.
   */
  private async cleanupExpiredSessions(): Promise<void> {
    await this.enqueueWrite(async () => {
      const now = Date.now();
      const sessions = Object.fromEntries(
        Object.entries(this.state.sessions).filter(
          ([, session]) =>
            now - new Date(session.createdAt).getTime() <= this.sessionTtlMs,
        ),
      );
      if (
        Object.keys(sessions).length === Object.keys(this.state.sessions).length
      ) {
        return;
      }
      const targetState = this.withSessions(sessions);
      await writePrivateJsonAtomic(this.filePath, targetState);
      this.state = targetState;
    });
  }

  private withSessions(sessions: Record<string, AuthSession>): AuthState {
    return {
      version: CURRENT_VERSION,
      ...(this.state.localhostOpen ? { localhostOpen: true } : {}),
      ...(this.state.account ? { account: this.state.account } : {}),
      sessions,
    };
  }

  private enqueueWrite<T>(write: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(write, write);
    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
