export type BuildRecoveryReason =
  | "routine"
  | "vite-preload-error"
  | "dynamic-import-error";

export type BuildRecoveryResult =
  | "disabled"
  | "unavailable"
  | "current"
  | "already-reloaded"
  | "reloaded";

export interface BuildRecoveryDeps {
  baseUrl: string;
  currentBuildId: string;
  buildProfile: string;
  fetchImpl: typeof fetch;
  storage: Pick<Storage, "getItem" | "setItem">;
  reload: () => void;
  now: () => number;
}

interface BuildInfo {
  buildId?: unknown;
}

export const CLIENT_BUILD_ID =
  typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "unknown";

const BUILD_PROFILE =
  typeof __BUILD_PROFILE__ === "string" ? __BUILD_PROFILE__ : "dev";

function getDefaultDeps(): BuildRecoveryDeps {
  return {
    baseUrl: import.meta.env.BASE_URL ?? "/",
    currentBuildId: CLIENT_BUILD_ID,
    buildProfile: BUILD_PROFILE,
    fetchImpl: (input, init) => fetch(input, init),
    storage: window.sessionStorage,
    reload: () => window.location.reload(),
    now: () => Date.now(),
  };
}

function normalizeBase(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed || trimmed === "/") return "/";

  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.endsWith("/")
    ? withLeadingSlash
    : `${withLeadingSlash}/`;
}

export async function checkForBuildRecovery(
  reason: BuildRecoveryReason,
  deps?: BuildRecoveryDeps,
): Promise<BuildRecoveryResult> {
  let recoveryDeps: BuildRecoveryDeps;
  try {
    recoveryDeps = deps ?? getDefaultDeps();
  } catch {
    return "unavailable";
  }

  if (
    recoveryDeps.currentBuildId.length === 0 ||
    recoveryDeps.buildProfile === "dev"
  ) {
    return "disabled";
  }

  let serverBuildId: string;
  try {
    const normalizedBase = normalizeBase(recoveryDeps.baseUrl);
    const response = await recoveryDeps.fetchImpl(
      `${normalizedBase}build-info.json?fresh=1&t=${recoveryDeps.now()}`,
      {
        cache: "no-store",
        credentials: "same-origin",
      },
    );
    if (!response.ok) return "unavailable";

    const buildInfo = (await response.json()) as BuildInfo;
    if (
      typeof buildInfo.buildId !== "string" ||
      buildInfo.buildId.length === 0
    ) {
      return "unavailable";
    }
    serverBuildId = buildInfo.buildId;
  } catch {
    return "unavailable";
  }

  if (reason === "routine" && serverBuildId === recoveryDeps.currentBuildId) {
    return "current";
  }

  const effectiveReason =
    serverBuildId === recoveryDeps.currentBuildId ? reason : "build-mismatch";
  const key = `yep-anywhere:auto-reloaded:${recoveryDeps.currentBuildId}->${serverBuildId}:${effectiveReason}`;

  try {
    if (recoveryDeps.storage.getItem(key) === "1") {
      return "already-reloaded";
    }
    recoveryDeps.storage.setItem(key, "1");
    recoveryDeps.reload();
  } catch {
    return "unavailable";
  }

  return "reloaded";
}

const DYNAMIC_IMPORT_MESSAGES = [
  "Importing a module script failed",
  "Failed to fetch dynamically imported module",
];

function messageFrom(value: unknown): string {
  if (typeof value === "string") return value;
  if (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string"
  ) {
    return value.message;
  }
  return "";
}

function isDynamicImportFailure(value: unknown): boolean {
  const message = messageFrom(value);
  return DYNAMIC_IMPORT_MESSAGES.some((known) => message.includes(known));
}

export function installBuildRecoveryListeners(
  deps?: BuildRecoveryDeps,
): () => void {
  const onVitePreloadError = (event: Event) => {
    event.preventDefault();
    void checkForBuildRecovery("vite-preload-error", deps);
  };
  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    if (isDynamicImportFailure(event.reason)) {
      void checkForBuildRecovery("dynamic-import-error", deps);
    }
  };
  const onError = (event: ErrorEvent) => {
    if (
      isDynamicImportFailure(event.message) ||
      isDynamicImportFailure(event.error)
    ) {
      void checkForBuildRecovery("dynamic-import-error", deps);
    }
  };

  window.addEventListener("vite:preloadError", onVitePreloadError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);
  window.addEventListener("error", onError);

  return () => {
    window.removeEventListener("vite:preloadError", onVitePreloadError);
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
    window.removeEventListener("error", onError);
  };
}
