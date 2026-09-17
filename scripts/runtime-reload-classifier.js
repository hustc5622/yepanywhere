const RUNTIME_PREFIXES = [
  "packages/server/src/runtime/",
  "packages/server/src/supervisor/",
];

const RUNTIME_AND_SHELL_PREFIXES = [
  "packages/server/src/augments/",
  "packages/server/src/codex/",
  "packages/server/src/sdk/providers/",
];

const RUNTIME_FILES = new Set([
  "packages/server/src/sdk/messageQueue.ts",
  "packages/server/src/subscriptions.ts",
]);

const RUNTIME_AND_SHELL_FILES = new Set([
  "packages/server/src/config.ts",
  "packages/server/src/runtime/types.ts",
  "packages/server/src/runtime/EmbeddedRuntimeController.ts",
  "packages/server/src/runtime/HttpRuntimeController.ts",
  "packages/server/src/sdk/real.ts",
  "packages/server/src/subscriptions.ts",
  "packages/server/src/supervisor/ExternalSessionTracker.ts",
  "packages/server/src/supervisor/types.ts",
  "packages/server/src/watcher/EventBus.ts",
]);

/**
 * Paths whose content ends up inside the browser bundle. They can be applied
 * to a running deployment by swapping `client-dist` without touching any
 * server process.
 */
const CLIENT_PREFIXES = [
  "packages/client/src/",
  "packages/client/public/",
  "packages/client/index.html",
  "packages/client/vite.config",
  "packages/client/tailwind.config",
  "packages/client/postcss.config",
  "packages/client/package.json",
];

/**
 * Files the running services read from disk at spawn time. They travel with
 * the server bundle but are consumed by provider child processes, so the
 * runtime worker — not the web/API shell — owns them.
 */
const RUNTIME_RESOURCE_PREFIXES = ["packages/server/resources/"];

/**
 * Paths that never affect an already-running deployment (docs, marketing site,
 * mobile app, test-only code, tooling).
 */
const IGNORED_PREFIXES = [
  "docs/",
  "site/",
  "references/",
  "packages/mobile/",
  "packages/client/e2e/",
  "packages/client/test/",
  "packages/server/test/",
  "packages/shared/test/",
  "scripts/",
  ".github/",
  ".vscode/",
];

const IGNORED_FILES = new Set([
  "AGENTS.md",
  "CHANGELOG.md",
  "README.md",
  "GEMINI.md",
  "DEVELOPMENT.md",
  "biome.json",
]);

export function classifyBackendFile(file) {
  const normalized = file.replaceAll("\\", "/");
  if (normalized.startsWith("packages/shared/src/")) return "shared";
  if (
    RUNTIME_AND_SHELL_FILES.has(normalized) ||
    RUNTIME_AND_SHELL_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  ) {
    return "shared";
  }
  if (
    RUNTIME_FILES.has(normalized) ||
    RUNTIME_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  ) {
    return "runtime";
  }
  return "shell";
}

export function classifyBackendFiles(files) {
  const result = {
    shellFiles: [],
    runtimeFiles: [],
    sharedFiles: [],
  };
  for (const file of files) {
    const kind = classifyBackendFile(file);
    if (kind === "runtime") result.runtimeFiles.push(file);
    else if (kind === "shared") result.sharedFiles.push(file);
    else result.shellFiles.push(file);
  }
  return result;
}

/**
 * Classify any repository path for `scripts/hot-apply.mjs`.
 *
 * Returns one of:
 * - `client`  browser bundle only; hot-swappable with zero downtime
 * - `shell`   web/API process only; needs a shell restart
 * - `runtime` agent runtime worker; needs a runtime restart (kills live turns)
 * - `shared`  affects shell, runtime and the browser bundle
 * - `ignored` cannot affect an already-running deployment
 */
/** Test-only sources never reach a running deployment. */
function isTestOnlyPath(file) {
  return (
    file.includes("/__tests__/") ||
    file.includes("/__mocks__/") ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(file)
  );
}

export function classifyChangedFile(file) {
  const normalized = file.replaceAll("\\", "/");
  if (IGNORED_FILES.has(normalized)) return "ignored";
  if (isTestOnlyPath(normalized)) return "ignored";
  if (IGNORED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return "ignored";
  }
  if (CLIENT_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return "client";
  }
  if (
    RUNTIME_RESOURCE_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  ) {
    return "runtime";
  }
  // `packages/shared` is compiled into both the server bundle and the browser
  // bundle, so the backend classifier's "shared" verdict also implies a client
  // rebuild. Callers distinguish that via getHotApplyPlan().
  if (!normalized.startsWith("packages/")) return "ignored";
  if (
    !normalized.startsWith("packages/server/") &&
    !normalized.startsWith("packages/shared/")
  ) {
    return "ignored";
  }
  return classifyBackendFile(normalized);
}

/**
 * Build the apply plan for a set of changed files.
 *
 * `needsClientBuild` covers both client-only edits and `packages/shared`
 * edits, because shared schema/helpers are bundled into the browser build too.
 */
export function getHotApplyPlan(files) {
  const buckets = {
    clientFiles: [],
    shellFiles: [],
    runtimeFiles: [],
    sharedFiles: [],
    ignoredFiles: [],
  };
  for (const file of files) {
    const normalized = file.replaceAll("\\", "/");
    switch (classifyChangedFile(normalized)) {
      case "client":
        buckets.clientFiles.push(normalized);
        break;
      case "shell":
        buckets.shellFiles.push(normalized);
        break;
      case "runtime":
        buckets.runtimeFiles.push(normalized);
        break;
      case "shared":
        buckets.sharedFiles.push(normalized);
        break;
      default:
        buckets.ignoredFiles.push(normalized);
        break;
    }
  }

  const isSharedPackage = (file) => file.startsWith("packages/shared/src/");
  const needsClientBuild =
    buckets.clientFiles.length > 0 || buckets.sharedFiles.some(isSharedPackage);
  const needsShellRestart =
    buckets.shellFiles.length > 0 || buckets.sharedFiles.length > 0;
  const needsRuntimeRestart =
    buckets.runtimeFiles.length > 0 || buckets.sharedFiles.length > 0;

  let level = "none";
  if (needsRuntimeRestart) level = "runtime";
  else if (needsShellRestart) level = "shell";
  else if (needsClientBuild) level = "client";

  return {
    ...buckets,
    needsClientBuild,
    needsShellRestart,
    needsRuntimeRestart,
    /** Highest disruption tier required: none < client < shell < runtime. */
    level,
  };
}

export function getBackendReloadPlan(files) {
  const classification = classifyBackendFiles(files);
  return {
    ...classification,
    runtimeImpactingFiles: [
      ...classification.runtimeFiles,
      ...classification.sharedFiles,
    ],
    // Shared protocol/schema changes affect both sides of the control boundary.
    shouldReloadShell:
      classification.shellFiles.length > 0 ||
      classification.sharedFiles.length > 0,
  };
}
