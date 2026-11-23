/**
 * AuthService manages cookie-based authentication and device sessions.
 *
 * Features:
 * - Single user account (self-hosted apps typically have one owner)
 * - Opaque 256-bit session tokens stored with sliding expiration (default 30d)
 *   and an absolute maximum lifetime cap (default 90d)
 * - Password hashing with bcrypt
 * - Device session listing and selective/global revocation
 *
 * State is persisted to a JSON file (0600) for durability across server restarts.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import bcrypt from "bcrypt";
import {
  OWNER_READ_WRITE_FILE_MODE,
  enforceOwnerReadWriteFilePermissions,
} from "../utils/filePermissions.js";

const BCRYPT_ROUNDS = 12;
const SESSION_ID_BYTES = 32;
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days sliding
const DEFAULT_MAX_SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days absolute cap
const SLIDING_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // refresh cookie at most once per 24h

export type SessionAuthMethod = "password" | "pairing";

export interface StoredSession {
  createdAt: string;
  lastActiveAt: string;
  /** Sliding expiration timestamp (extended on active use up to maxExpiresAt). */
  expiresAt?: string;
  /** Absolute maximum expiration timestamp from initial login. */
  maxExpiresAt?: string;
  /** Last time the sliding window / cookie expiry was refreshed. */
  refreshedAt?: string;
  userAgent?: string;
  deviceLabel?: string;
  authMethod?: SessionAuthMethod;
  lastIp?: string;
}

export interface PublicSessionInfo {
  /** Safe public identifier (SHA-256 prefix of sessionId, never the raw token). */
  id: string;
  createdAt: string;
  lastActiveAt: string;
  expiresAt: string;
  maxExpiresAt: string;
  userAgent?: string;
  deviceLabel?: string;
  authMethod: SessionAuthMethod;
  isCurrent: boolean;
}

export interface CreateSessionOptions {
  authMethod?: SessionAuthMethod;
  deviceLabel?: string;
  ip?: string;
}

export interface SessionValidationResult {
  valid: boolean;
  shouldRefreshCookie: boolean;
  cookieMaxAgeSec?: number;
}

export interface AccountReloadResult {
  /** The on-disk state was newer than the in-memory copy and has been adopted. */
  reloaded: boolean;
  /** The stored password hash changed, so rate limits earned under the old one are void. */
  credentialChanged: boolean;
}

export interface AuthState {
  /** Schema version for future migrations */
  version: number;
  /** Whether auth is enabled (can be enabled via settings UI) */
  enabled?: boolean;
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
  sessions: Record<string, StoredSession>;
}

const CURRENT_VERSION = 2;

export interface AuthServiceOptions {
  /** Directory to store auth state (defaults to dataDir) */
  dataDir: string;
  /** Sliding session TTL in milliseconds (default: 30 days) */
  sessionTtlMs?: number;
  /** Absolute maximum session lifetime in milliseconds (default: 90 days) */
  maxSessionTtlMs?: number;
  /** Cookie signing secret (auto-generated if not provided) */
  cookieSecret?: string;
  /** Injectable clock for deterministic tests */
  now?: () => number;
}

function publicSessionId(sessionId: string): string {
  return crypto
    .createHash("sha256")
    .update(sessionId)
    .digest("hex")
    .slice(0, 16);
}

export class AuthService {
  private state: AuthState;
  private dataDir: string;
  private filePath: string;
  private sessionTtlMs: number;
  private maxSessionTtlMs: number;
  private cookieSecret: string;
  private now: () => number;
  private savePromise: Promise<void> | null = null;
  private pendingSave = false;
  /** Identity of the auth.json content this process last read or wrote. */
  private lastFileSignature: string | null = null;

  constructor(options: AuthServiceOptions) {
    this.dataDir = options.dataDir;
    this.filePath = path.join(this.dataDir, "auth.json");
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.maxSessionTtlMs = Math.max(
      this.sessionTtlMs,
      options.maxSessionTtlMs ?? DEFAULT_MAX_SESSION_TTL_MS,
    );
    this.cookieSecret = options.cookieSecret ?? "";
    this.now = options.now ?? (() => Date.now());
    this.state = { version: CURRENT_VERSION, sessions: {} };
  }

  /**
   * Initialize the service by loading state from disk.
   * Creates the data directory if it doesn't exist.
   * Generates cookie secret if not provided.
   */
  async initialize(): Promise<void> {
    try {
      await fs.mkdir(this.dataDir, { recursive: true });
      await enforceOwnerReadWriteFilePermissions(
        this.filePath,
        "[AuthService]",
      );

      const content = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(content) as AuthState;

      if (parsed.version === CURRENT_VERSION) {
        this.state = {
          ...parsed,
          sessions: parsed.sessions ?? {},
        };
      } else {
        // Migrate v1 (or older) state to v2 with sliding/max expiration fields
        const migratedSessions: Record<string, StoredSession> = {};
        for (const [sid, session] of Object.entries(parsed.sessions ?? {})) {
          const createdMs = new Date(session.createdAt).getTime();
          const baseMs = Number.isFinite(createdMs) ? createdMs : this.now();
          migratedSessions[sid] = {
            ...session,
            expiresAt:
              session.expiresAt ??
              new Date(baseMs + this.sessionTtlMs).toISOString(),
            maxExpiresAt:
              session.maxExpiresAt ??
              new Date(baseMs + this.maxSessionTtlMs).toISOString(),
            refreshedAt: session.refreshedAt ?? session.createdAt,
            authMethod: session.authMethod ?? "password",
          };
        }
        this.state = {
          version: CURRENT_VERSION,
          enabled: parsed.enabled,
          localhostOpen: parsed.localhostOpen,
          account: parsed.account,
          sessions: migratedSessions,
        };
        await this.save();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          "[AuthService] Failed to load state, starting fresh:",
          error,
        );
      }
      this.state = { version: CURRENT_VERSION, sessions: {} };
    }

    // Generate cookie secret if not provided
    if (!this.cookieSecret) {
      this.cookieSecret = crypto.randomBytes(32).toString("hex");
    }

    // Clean up expired sessions on startup
    await this.cleanupExpiredSessions();
    this.lastFileSignature = await this.readFileSignature();
  }

  /**
   * Adopt credentials written by another process (for example
   * `yepanywhere --setup-auth "<password>"` running while this server is up).
   *
   * Only the account fields are adopted: the running server stays the owner of
   * the session table, so a short-lived CLI process cannot resurrect a session
   * this server already revoked. Returns whether the password changed, which
   * lets callers void the login rate limit earned by the old password.
   */
  async refreshAccountFromDisk(): Promise<AccountReloadResult> {
    const signature = await this.readFileSignature();
    if (!signature || signature === this.lastFileSignature) {
      return { reloaded: false, credentialChanged: false };
    }

    let parsed: AuthState;
    try {
      const content = await fs.readFile(this.filePath, "utf-8");
      parsed = JSON.parse(content) as AuthState;
    } catch (error) {
      // A half-written or corrupt file must never drop the live account.
      console.warn("[AuthService] Failed to reload auth.json:", error);
      return { reloaded: false, credentialChanged: false };
    }

    const nextHash = parsed?.account?.passwordHash;
    const hasUsableCredential =
      typeof nextHash === "string" && nextHash.length > 0;
    if (parsed?.enabled === true && !hasUsableCredential) {
      // Auth is enabled but the file carries no hash: treat this as a torn
      // write rather than an account reset, which would hand out setup mode.
      console.warn(
        "[AuthService] Ignoring auth.json without credentials; keeping in-memory account",
      );
      return { reloaded: false, credentialChanged: false };
    }

    this.lastFileSignature = signature;
    const previousHash = this.state.account?.passwordHash;
    this.state.enabled = parsed?.enabled;
    this.state.localhostOpen = parsed?.localhostOpen;
    this.state.account = parsed?.account;

    return { reloaded: true, credentialChanged: previousHash !== nextHash };
  }

  /**
   * Check if auth is enabled (via settings).
   */
  isEnabled(): boolean {
    return this.state.enabled === true;
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
    this.state.localhostOpen = open || undefined; // Don't persist false
    await this.save();
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
   * Get the configured sliding session TTL in whole seconds (for cookie Max-Age).
   */
  getSessionCookieMaxAgeSec(): number {
    return Math.max(60, Math.floor(this.sessionTtlMs / 1000));
  }

  /**
   * Enable auth with a password. Creates account if needed.
   * This is the main way to enable auth from the settings UI.
   */
  async enableAuth(password: string): Promise<boolean> {
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    this.state.enabled = true;
    this.state.account = {
      passwordHash,
      createdAt: new Date(this.now()).toISOString(),
    };
    await this.save();
    return true;
  }

  /**
   * Disable auth and clear credentials.
   */
  async disableAuth(): Promise<void> {
    this.state.enabled = false;
    this.state.account = undefined;
    this.state.sessions = {}; // Clear all sessions
    await this.save();
  }

  /**
   * Create the initial account. Only works if no account exists.
   * @deprecated Use enableAuth instead which also sets the enabled flag.
   */
  async createAccount(password: string): Promise<boolean> {
    if (this.state.account) {
      return false; // Account already exists
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    this.state.account = {
      passwordHash,
      createdAt: new Date(this.now()).toISOString(),
    };
    await this.save();
    return true;
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
   * Change the account password and revoke other active sessions so stolen
   * cookies cannot survive a password rotation.
   */
  async changePassword(
    newPassword: string,
    keepSessionId?: string,
  ): Promise<boolean> {
    if (!this.state.account) {
      return false;
    }

    this.state.account.passwordHash = await bcrypt.hash(
      newPassword,
      BCRYPT_ROUNDS,
    );

    if (keepSessionId && this.state.sessions[keepSessionId]) {
      this.state.sessions = {
        [keepSessionId]: this.state.sessions[keepSessionId],
      };
    } else if (!keepSessionId) {
      this.state.sessions = {};
    }

    await this.save();
    return true;
  }

  /**
   * Create a new session and return the opaque session ID.
   */
  async createSession(
    userAgent?: string,
    options?: CreateSessionOptions,
  ): Promise<string> {
    const sessionId = crypto.randomBytes(SESSION_ID_BYTES).toString("hex");
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();

    this.state.sessions[sessionId] = {
      createdAt: nowIso,
      lastActiveAt: nowIso,
      expiresAt: new Date(nowMs + this.sessionTtlMs).toISOString(),
      maxExpiresAt: new Date(nowMs + this.maxSessionTtlMs).toISOString(),
      refreshedAt: nowIso,
      userAgent,
      deviceLabel: options?.deviceLabel?.trim().slice(0, 64) || undefined,
      authMethod: options?.authMethod ?? "password",
      lastIp: options?.ip,
    };
    await this.save();

    return sessionId;
  }

  /**
   * Validate a session ID and update last active time (simple boolean wrapper).
   */
  async validateSession(sessionId: string): Promise<boolean> {
    const result = await this.validateSessionWithRefresh(sessionId);
    return result.valid;
  }

  /**
   * Validate a session ID, extend its sliding expiration window when due, and
   * tell the caller whether the browser cookie's Max-Age should be refreshed.
   */
  async validateSessionWithRefresh(
    sessionId: string,
    meta?: { ip?: string },
  ): Promise<SessionValidationResult> {
    const session = this.state.sessions[sessionId];
    if (!session) {
      return { valid: false, shouldRefreshCookie: false };
    }

    const nowMs = this.now();
    const { expiresAtMs, maxExpiresAtMs } = this.resolveExpiryBounds(session);
    const effectiveExpiryMs = Math.min(expiresAtMs, maxExpiresAtMs);

    if (nowMs > effectiveExpiryMs) {
      delete this.state.sessions[sessionId];
      await this.save();
      return { valid: false, shouldRefreshCookie: false };
    }

    const nowIso = new Date(nowMs).toISOString();
    session.lastActiveAt = nowIso;
    if (meta?.ip) {
      session.lastIp = meta.ip;
    }

    const lastRefreshedMs = session.refreshedAt
      ? new Date(session.refreshedAt).getTime()
      : new Date(session.createdAt).getTime();

    let shouldRefreshCookie = false;
    let cookieMaxAgeSec: number | undefined;

    if (
      !Number.isFinite(lastRefreshedMs) ||
      nowMs - lastRefreshedMs >= SLIDING_REFRESH_INTERVAL_MS
    ) {
      const nextExpiresAtMs = Math.min(
        nowMs + this.sessionTtlMs,
        maxExpiresAtMs,
      );
      session.expiresAt = new Date(nextExpiresAtMs).toISOString();
      session.maxExpiresAt = new Date(maxExpiresAtMs).toISOString();
      session.refreshedAt = nowIso;
      shouldRefreshCookie = true;
      cookieMaxAgeSec = Math.max(
        60,
        Math.floor((nextExpiresAtMs - nowMs) / 1000),
      );
    }

    // Don't await save here to avoid blocking every request
    void this.save();

    return { valid: true, shouldRefreshCookie, cookieMaxAgeSec };
  }

  /**
   * List active sessions with safe public identifiers (never exposing raw session tokens).
   */
  async listSessions(currentSessionId?: string): Promise<PublicSessionInfo[]> {
    await this.cleanupExpiredSessions();
    const items: PublicSessionInfo[] = [];

    for (const [sid, session] of Object.entries(this.state.sessions)) {
      const { expiresAtMs, maxExpiresAtMs } = this.resolveExpiryBounds(session);
      items.push({
        id: publicSessionId(sid),
        createdAt: session.createdAt,
        lastActiveAt: session.lastActiveAt,
        expiresAt: new Date(
          Math.min(expiresAtMs, maxExpiresAtMs),
        ).toISOString(),
        maxExpiresAt: new Date(maxExpiresAtMs).toISOString(),
        userAgent: session.userAgent,
        deviceLabel: session.deviceLabel,
        authMethod: session.authMethod ?? "password",
        isCurrent: Boolean(currentSessionId && sid === currentSessionId),
      });
    }

    // Sort current session first, then most recently active
    items.sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
      return (
        new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime()
      );
    });

    return items;
  }

  /**
   * Revoke a single session by its safe public ID.
   */
  async revokeSessionByPublicId(publicId: string): Promise<boolean> {
    for (const sid of Object.keys(this.state.sessions)) {
      if (publicSessionId(sid) === publicId) {
        delete this.state.sessions[sid];
        await this.save();
        return true;
      }
    }
    return false;
  }

  /**
   * Invalidate a session (logout).
   */
  async invalidateSession(sessionId: string): Promise<void> {
    if (this.state.sessions[sessionId]) {
      delete this.state.sessions[sessionId];
      await this.save();
    }
  }

  /**
   * Invalidate all sessions except the specified current session.
   */
  async invalidateOtherSessions(keepSessionId: string): Promise<number> {
    let removed = 0;
    for (const sid of Object.keys(this.state.sessions)) {
      if (sid !== keepSessionId) {
        delete this.state.sessions[sid];
        removed += 1;
      }
    }
    if (removed > 0) {
      await this.save();
    }
    return removed;
  }

  /**
   * Invalidate all sessions (logout everywhere).
   */
  async invalidateAllSessions(): Promise<void> {
    this.state.sessions = {};
    await this.save();
  }

  /**
   * Get the cookie secret for signing.
   */
  getCookieSecret(): string {
    return this.cookieSecret;
  }

  /**
   * Feedback-free identity of the current auth.json content. Nanosecond mtime
   * plus size and inode is enough to notice a rewrite by another process
   * without re-reading the file on every request.
   */
  private async readFileSignature(): Promise<string | null> {
    try {
      const stat = await fs.stat(this.filePath, { bigint: true });
      return `${stat.ino}:${stat.size}:${stat.mtimeNs}`;
    } catch {
      return null;
    }
  }

  private resolveExpiryBounds(session: StoredSession): {
    expiresAtMs: number;
    maxExpiresAtMs: number;
  } {
    const createdAtMs = new Date(session.createdAt).getTime();
    const baseMs = Number.isFinite(createdAtMs) ? createdAtMs : this.now();
    const parsedExpires = session.expiresAt
      ? new Date(session.expiresAt).getTime()
      : Number.NaN;
    const parsedMax = session.maxExpiresAt
      ? new Date(session.maxExpiresAt).getTime()
      : Number.NaN;
    const expiresAtMs = Number.isFinite(parsedExpires)
      ? parsedExpires
      : baseMs + this.sessionTtlMs;
    const maxExpiresAtMs = Number.isFinite(parsedMax)
      ? parsedMax
      : baseMs + this.maxSessionTtlMs;
    return { expiresAtMs, maxExpiresAtMs };
  }

  /**
   * Clean up expired sessions.
   */
  private async cleanupExpiredSessions(): Promise<void> {
    const nowMs = this.now();
    let changed = false;

    for (const [sessionId, session] of Object.entries(this.state.sessions)) {
      const { expiresAtMs, maxExpiresAtMs } = this.resolveExpiryBounds(session);
      if (nowMs > Math.min(expiresAtMs, maxExpiresAtMs)) {
        delete this.state.sessions[sessionId];
        changed = true;
      }
    }

    if (changed) {
      await this.save();
    }
  }

  /**
   * Save state to disk with debouncing.
   */
  private async save(): Promise<void> {
    if (this.savePromise) {
      this.pendingSave = true;
      return;
    }

    this.savePromise = this.doSave();
    await this.savePromise;
    this.savePromise = null;

    if (this.pendingSave) {
      this.pendingSave = false;
      await this.save();
    }
  }

  private async doSave(): Promise<void> {
    try {
      const content = JSON.stringify(this.state, null, 2);
      await fs.writeFile(this.filePath, content, {
        encoding: "utf-8",
        mode: OWNER_READ_WRITE_FILE_MODE,
      });
      await enforceOwnerReadWriteFilePermissions(
        this.filePath,
        "[AuthService]",
      );
      this.lastFileSignature = await this.readFileSignature();
    } catch (error) {
      console.error("[AuthService] Failed to save state:", error);
      throw error;
    }
  }
}
