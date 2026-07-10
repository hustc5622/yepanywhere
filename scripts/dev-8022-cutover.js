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
