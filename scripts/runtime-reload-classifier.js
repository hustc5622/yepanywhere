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
