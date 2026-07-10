import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJSON } from "../api/client";
import {
  type SourceChangeEvent,
  type WorkerActivityEvent,
  activityBus,
} from "../lib/activityBus";

// Re-export for consumers
export type {
  SourceChangeEvent,
  WorkerActivityEvent,
} from "../lib/activityBus";

export interface PendingReloads {
  backend: boolean;
  frontend: boolean;
  runtime: boolean;
}

interface DevStatus {
  noBackendReload: boolean;
  noFrontendReload: boolean;
  backendDirty?: boolean;
  runtimeMode?: "embedded" | "external";
  runtimeDirty?: boolean;
  runtimeDirtyFiles?: string[];
  runtimeDirtyGeneration?: string;
}

/**
 * Hook to manage reload notifications when running in manual reload mode.
 * Listens for source-change events via the global activityBus.
 */
export function useReloadNotifications() {
  const [pendingReloads, setPendingReloads] = useState<PendingReloads>({
    backend: false,
    frontend: false,
    runtime: false,
  });
  const [devStatus, setDevStatus] = useState<DevStatus | null>(null);
  const [connected, setConnected] = useState(activityBus.connected);
  const [workerActivity, setWorkerActivity] = useState<WorkerActivityEvent>({
    type: "worker-activity-changed",
    activeWorkers: 0,
    queueLength: 0,
    hasActiveWork: false,
    timestamp: "",
  });
  const runtimeDirtyGenerationRef = useRef<string | null>(null);
  const dismissedRuntimeGenerationRef = useRef<string | null>(null);

  const applyRuntimeDirtyStatus = useCallback((data: DevStatus) => {
    const generation =
      data.runtimeDirtyGeneration ??
      (data.runtimeDirty ? JSON.stringify(data.runtimeDirtyFiles ?? []) : null);
    runtimeDirtyGenerationRef.current = generation;
    if (!data.runtimeDirty) {
      dismissedRuntimeGenerationRef.current = null;
    }
    setPendingReloads((prev) => ({
      ...prev,
      runtime:
        data.runtimeDirty === true &&
        generation !== dismissedRuntimeGenerationRef.current,
    }));
  }, []);

  // Sync dev status and worker activity from server
  const syncFromServer = useCallback(() => {
    if (window.location.pathname === "/login") {
      return;
    }

    // Sync dev status
    fetchJSON<DevStatus>("/dev/status")
      .then((data) => {
        setDevStatus(data);
        if (data && !data.backendDirty) {
          setPendingReloads((prev) => ({ ...prev, backend: false }));
        }
        applyRuntimeDirtyStatus(data);
      })
      .catch(() => {
        // Ignore errors
      });

    // Sync worker activity
    fetchJSON<WorkerActivityEvent>("/status/workers")
      .then((data) => {
        if (data) setWorkerActivity(data);
      })
      .catch(() => {
        // Ignore errors
      });
  }, [applyRuntimeDirtyStatus]);

  // Check if server is in dev mode and get persisted dirty state
  useEffect(() => {
    if (window.location.pathname === "/login") {
      return;
    }

    fetchJSON<DevStatus>("/dev/status")
      .then((data) => {
        setDevStatus(data);
        if (data.backendDirty) {
          setPendingReloads((prev) => ({ ...prev, backend: true }));
        }
        applyRuntimeDirtyStatus(data);
      })
      .catch(() => {
        setDevStatus(null);
      });
  }, [applyRuntimeDirtyStatus]);

  // Subscribe to events from the bus
  useEffect(() => {
    const unsubscribers: (() => void)[] = [];

    unsubscribers.push(
      activityBus.on("source-change", (data: SourceChangeEvent) => {
        setPendingReloads((prev) => ({
          ...prev,
          [data.target]: true,
        }));
      }),
    );

    unsubscribers.push(
      activityBus.on("backend-reloaded", () => {
        setPendingReloads((prev) => ({ ...prev, backend: false }));
      }),
    );

    unsubscribers.push(
      activityBus.on("worker-activity-changed", (data: WorkerActivityEvent) => {
        setWorkerActivity(data);
      }),
    );

    // On reconnect, sync state from server
    unsubscribers.push(
      activityBus.on("reconnect", () => {
        setConnected(true);
        syncFromServer();
      }),
    );

    // On visibility restore, refresh data
    unsubscribers.push(
      activityBus.on("refresh", () => {
        syncFromServer();
      }),
    );

    return () => {
      for (const unsub of unsubscribers) {
        unsub();
      }
    };
  }, [syncFromServer]);

  // Sync connected state with bus
  useEffect(() => {
    const checkConnection = () => {
      setConnected(activityBus.connected);
    };
    const interval = setInterval(checkConnection, 1000);
    return () => clearInterval(interval);
  }, []);

  // Initial sync when dev mode is detected
  useEffect(() => {
    if (devStatus?.noBackendReload || devStatus?.noFrontendReload) {
      syncFromServer();
    }
  }, [devStatus, syncFromServer]);

  useEffect(() => {
    if (devStatus?.runtimeMode !== "external") return;
    const interval = setInterval(syncFromServer, 2_000);
    return () => clearInterval(interval);
  }, [devStatus?.runtimeMode, syncFromServer]);

  // Reload the backend (triggers server restart)
  const reloadBackend = useCallback(async () => {
    console.log("[ReloadNotifications] Requesting backend reload...");
    try {
      await fetchJSON<{ ok: boolean }>("/server/restart", { method: "POST" });
      console.log("[ReloadNotifications] Reload completed");
      setPendingReloads((prev) => ({ ...prev, backend: false }));
    } catch (err) {
      console.log("[ReloadNotifications] Reload error (may be expected):", err);
    }
  }, []);

  // Reload the frontend (browser refresh)
  const reloadFrontend = useCallback(() => {
    window.location.reload();
  }, []);

  const reloadRuntime = useCallback(async (force = false) => {
    console.log("[ReloadNotifications] Requesting agent runtime reload...");
    try {
      await fetchJSON<{ ok: boolean }>("/server/runtime/restart", {
        method: "POST",
        body: JSON.stringify({ force }),
      });
      setPendingReloads((prev) => ({ ...prev, runtime: false }));
    } catch (error) {
      console.error(
        "[ReloadNotifications] Agent runtime reload failed:",
        error,
      );
    }
  }, []);

  // Reload whichever needs it (backend first if both)
  const reload = useCallback(() => {
    if (pendingReloads.backend) {
      reloadBackend();
    } else if (pendingReloads.runtime) {
      // The keyboard shortcut must never imply permission to interrupt work.
      // The warning banner's explicit "Reload Anyway" action supplies force.
      void reloadRuntime(false);
    } else if (pendingReloads.frontend) {
      reloadFrontend();
    }
  }, [pendingReloads, reloadBackend, reloadFrontend, reloadRuntime]);

  // Dismiss a pending reload notification
  const dismiss = useCallback((target: "backend" | "frontend" | "runtime") => {
    if (target === "runtime") {
      dismissedRuntimeGenerationRef.current = runtimeDirtyGenerationRef.current;
    }
    setPendingReloads((prev) => ({
      ...prev,
      [target]: false,
    }));
  }, []);

  // Dismiss all
  const dismissAll = useCallback(() => {
    dismissedRuntimeGenerationRef.current = runtimeDirtyGenerationRef.current;
    setPendingReloads({ backend: false, frontend: false, runtime: false });
  }, []);

  // Keyboard shortcut: Ctrl+Shift+R
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === "R") {
        e.preventDefault();
        reload();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [reload]);

  // Check if manual reload mode is active at all
  const isManualReloadMode =
    devStatus?.noBackendReload ||
    devStatus?.noFrontendReload ||
    devStatus?.runtimeMode === "external";

  return {
    isManualReloadMode,
    pendingReloads,
    connected,
    reloadBackend,
    reloadFrontend,
    reloadRuntime,
    reload,
    dismiss,
    dismissAll,
    workerActivity,
    unsafeToRestart:
      workerActivity.hasActiveWork && workerActivity.runtimeMode !== "external",
    unsafeToReloadRuntime: workerActivity.hasActiveWork,
  };
}
