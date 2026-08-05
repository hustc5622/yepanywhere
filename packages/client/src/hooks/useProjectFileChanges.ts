import { useEffect } from "react";
import { activityBus } from "../lib/activityBus";
import type { ProjectFileChangedEvent } from "../lib/activityBus";

/**
 * Subscribe to `project-file-changed` events for a specific project and invoke
 * `onChanged` whenever the project's working directory changes on disk. The
 * callback is filtered by `projectId` so each repository tree only reacts to
 * its own project's changes.
 */
export function useProjectFileChanges(
  projectId: string,
  onChanged: (event: ProjectFileChangedEvent) => void,
): void {
  useEffect(() => {
    const unsubscribe = activityBus.on("project-file-changed", (event) => {
      if (event.projectId === projectId) {
        onChanged(event);
      }
    });
    return unsubscribe;
  }, [projectId, onChanged]);
}
