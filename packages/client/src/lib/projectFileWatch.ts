/**
 * Tiny client-side pub/sub used to trigger an immediate (optimistic) refresh
 * of a project's repository file tree — e.g. right after the in-app editor
 * saves a file. The same channel is also fed by the WebSocket "project-files"
 * subscription, so consumers get unified, debounced real-time updates.
 */

type Listener = (projectId: string) => void;

const listenersByProject = new Map<string, Set<Listener>>();

/** Notify listeners that a project's repository files changed. */
export function emitProjectFilesChanged(projectId: string): void {
  const listeners = listenersByProject.get(projectId);
  if (!listeners) return;
  for (const listener of listeners) {
    try {
      listener(projectId);
    } catch (err) {
      console.error("[projectFileWatch] listener failed:", err);
    }
  }
}

/** Subscribe to optimistic project-file-change notifications. */
export function subscribeProjectFilesChanged(
  projectId: string,
  listener: Listener,
): () => void {
  let set = listenersByProject.get(projectId);
  if (!set) {
    set = new Set();
    listenersByProject.set(projectId, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
  };
}
