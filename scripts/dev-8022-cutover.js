export const DEV_CUTOVER_WAIT_MARKER = "YEP_DEV_8022_WAITING_FOR_IDLE";

/**
 * Classify whether replacing the current web/API process can interrupt work
 * owned by that process. External runtimes survive a shell replacement.
 */
export function classifyDevCutover(activity) {
  if (!activity) return "unknown";
  if (activity.runtimeMode === "external") return "safe";
  return activity.hasActiveWork ? "wait" : "safe";
}

export function formatDevCutoverWait(activity) {
  const workerCount = activity?.activeWorkers ?? "unknown";
  const queueLength = activity?.queueLength ?? "unknown";
  return `${DEV_CUTOVER_WAIT_MARKER} workers=${workerCount} queue=${queueLength}`;
}

export function findDuplicateDevPort(entries) {
  const byPort = new Map();
  for (const [name, port] of entries) {
    if (!port) continue;
    const names = byPort.get(port) ?? [];
    names.push(name);
    byPort.set(port, names);
  }
  for (const [port, names] of byPort) {
    if (names.length > 1) return { port, names };
  }
  return null;
}

export function classifyMaintenanceOwner({
  listenPids,
  status,
  mainServerPort,
}) {
  if (listenPids.length === 0) return "free";
  if (
    status &&
    Number(status.mainServerPort) === mainServerPort &&
    listenPids.includes(String(status.pid))
  ) {
    return "owned";
  }
  return "conflict";
}

export function hasUnknownViteOwner(listenPids, repoVitePids) {
  const owned = new Set(repoVitePids);
  return listenPids.some((pid) => !owned.has(pid));
}
