/**
 * Detects a tab that runs a different client bundle than the server serves and
 * reloads it.
 *
 * A tab normally goes stale after a server-only deploy. It can also be revived
 * stale: Chrome serves a cross-document back/forward navigation from its HTTP
 * cache without revalidating, even for `Cache-Control: no-cache`, so the old
 * `index.html` and its immutable hashed bundles come back to life. That revived
 * document is not the result of our own reload, so it must not be held back by
 * the loop guard that a previous deploy left in this tab's sessionStorage.
 */

export const CURRENT_BUILD_ID =
  typeof __BUILD_ID__ === "undefined" ? "" : __BUILD_ID__;
const BUILD_PROFILE =
  typeof __BUILD_PROFILE__ === "undefined" ? "dev" : __BUILD_PROFILE__;

const CHECK_DEBOUNCE_MS = 2_000;
const AUTO_RELOAD_PREFIX = "yep-anywhere:auto-reloaded:";
/** A fresh document loaded by our reload checks immediately; skip that one. */
export const RELOAD_COOLDOWN_MS = 60_000;
/** Reloads allowed per window before giving up on a server that stays stale. */
export const RELOAD_WINDOW_MS = 10 * 60_000;
export const MAX_RELOADS_PER_WINDOW = 3;

export interface AutoReloadRecord {
  firstAt: number;
  lastAt: number;
  count: number;
}

export type BuildCheckResult =
  | { status: "disabled" }
  | { status: "unavailable" }
  | { status: "current"; serverBuildId: string }
  | { status: "reloading"; serverBuildId: string }
  /** Server build differs, but the loop guard held the reload back. */
  | { status: "stale"; serverBuildId: string };

export function shouldAutoRefreshBuild(
  buildId = CURRENT_BUILD_ID,
  profile = BUILD_PROFILE,
): boolean {
  return buildId.length > 0 && profile !== "dev";
}

/**
 * Whether this tab may reload again for the same build transition.
 *
 * `revived` documents came from history/bfcache rather than a reload, so the
 * guard does not apply to them; reloading turns them into a normal `reload`
 * navigation, which the guard does cover, so this cannot loop.
 */
export function canAutoReload(
  record: AutoReloadRecord | null,
  now: number,
  revived: boolean,
): boolean {
  if (revived || !record) return true;
  if (now - record.lastAt < RELOAD_COOLDOWN_MS) return false;
  if (
    now - record.firstAt < RELOAD_WINDOW_MS &&
    record.count >= MAX_RELOADS_PER_WINDOW
  )
    return false;
  return true;
}

export function nextAutoReloadRecord(
  record: AutoReloadRecord | null,
  now: number,
): AutoReloadRecord {
  if (!record || now - record.firstAt >= RELOAD_WINDOW_MS)
    return { firstAt: now, lastAt: now, count: 1 };
  return { firstAt: record.firstAt, lastAt: now, count: record.count + 1 };
}

/** Parses a stored record; legacy `"1"` markers carry no time and expire. */
export function parseAutoReloadRecord(
  raw: string | null,
): AutoReloadRecord | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<AutoReloadRecord> | null;
    if (
      value &&
      typeof value === "object" &&
      Number.isFinite(value.firstAt) &&
      Number.isFinite(value.lastAt) &&
      Number.isFinite(value.count)
    )
      return {
        firstAt: value.firstAt as number,
        lastAt: value.lastAt as number,
        count: value.count as number,
      };
  } catch {
    // Fall through: unreadable markers do not block a reload.
  }
  return null;
}

function getAutoReloadKey(nextBuildId: string): string {
  return `${AUTO_RELOAD_PREFIX}${CURRENT_BUILD_ID}->${nextBuildId}`;
}

function readRecord(nextBuildId: string): AutoReloadRecord | null {
  try {
    return parseAutoReloadRecord(
      sessionStorage.getItem(getAutoReloadKey(nextBuildId)),
    );
  } catch {
    return null;
  }
}

function writeRecord(nextBuildId: string, record: AutoReloadRecord): void {
  try {
    sessionStorage.setItem(
      getAutoReloadKey(nextBuildId),
      JSON.stringify(record),
    );
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}

function loadedFromHistory(): boolean {
  try {
    const entry = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    return entry?.type === "back_forward";
  } catch {
    return false;
  }
}

let revivedDocument = loadedFromHistory();

/** Marks the document as restored from the back/forward cache. */
export function markDocumentRevived(): void {
  revivedDocument = true;
}

function getBuildInfoUrl(): string {
  const base = import.meta.env.BASE_URL ?? "/";
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  return `${normalizedBase}build-info.json?fresh=1&t=${Date.now()}`;
}

let reloadPage = () => window.location.reload();

/** Test seam: jsdom cannot navigate. */
export function setReloadPageForTests(reload: () => void): void {
  reloadPage = reload;
}

let inFlight: Promise<BuildCheckResult> | null = null;
let lastCheck: { at: number; result: BuildCheckResult } | null = null;

async function runCheck(): Promise<BuildCheckResult> {
  try {
    const response = await fetch(getBuildInfoUrl(), {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!response.ok) return { status: "unavailable" };
    const buildInfo = (await response.json()) as { buildId?: unknown };
    const serverBuildId =
      typeof buildInfo.buildId === "string" ? buildInfo.buildId : "";
    if (!serverBuildId) return { status: "unavailable" };
    if (serverBuildId === CURRENT_BUILD_ID)
      return { status: "current", serverBuildId };

    const now = Date.now();
    const record = readRecord(serverBuildId);
    if (!canAutoReload(record, now, revivedDocument)) {
      console.warn(
        `[BuildRefresh] Server build ${serverBuildId} differs from client build ${CURRENT_BUILD_ID}, but this tab reloaded for it recently.`,
      );
      return { status: "stale", serverBuildId };
    }
    writeRecord(serverBuildId, nextAutoReloadRecord(record, now));
    reloadPage();
    return { status: "reloading", serverBuildId };
  } catch (err) {
    console.warn("[BuildRefresh] Failed to check deployed build metadata", err);
    return { status: "unavailable" };
  }
}

/**
 * Compares the running bundle with the deployed one and reloads a stale tab.
 * Concurrent and back-to-back calls share one request.
 */
export function checkForNewBuild(): Promise<BuildCheckResult> {
  if (!shouldAutoRefreshBuild()) return Promise.resolve({ status: "disabled" });
  if (inFlight) return inFlight;
  if (lastCheck && Date.now() - lastCheck.at < CHECK_DEBOUNCE_MS)
    return Promise.resolve(lastCheck.result);
  const task = runCheck().then((result) => {
    lastCheck = { at: Date.now(), result };
    return result;
  });
  inFlight = task.finally(() => {
    inFlight = null;
  });
  return inFlight;
}
