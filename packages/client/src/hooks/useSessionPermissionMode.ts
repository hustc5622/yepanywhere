import { DEFAULT_PERMISSION_MODE } from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { PermissionMode, SessionStatus } from "../types";

export interface UseSessionPermissionModeResult {
  /** UI-selected mode (sent with the next message). */
  permissionMode: PermissionMode;
  /** Server-confirmed mode. */
  serverMode: PermissionMode;
  /** Monotonic version of the confirmed mode. */
  modeVersion: number;
  /** Apply a server-confirmed mode + version (ignored if the version is stale). */
  applyServerModeUpdate: (mode: PermissionMode, version: number) => void;
  /** Update the UI mode and sync or persist it on the server. */
  setPermissionMode: (mode: PermissionMode) => Promise<void>;
}

/**
 * Owns permission-mode state for a session.
 *
 * `localMode` is the UI selection sent with the next message; `serverMode` is
 * the value the bridge has confirmed. Server updates are applied monotonically
 * by `modeVersion` so out-of-order stream/REST events can't regress the mode.
 * Extracted from useSession to isolate this concern.
 */
export function useSessionPermissionMode(
  sessionId: string,
  statusOwner: SessionStatus["owner"],
  initialMode: PermissionMode = DEFAULT_PERMISSION_MODE,
  initialModeVersion = 0,
): UseSessionPermissionModeResult {
  // localMode is UI-selected, serverMode is confirmed by server
  const [localMode, setLocalMode] = useState<PermissionMode>(initialMode);
  const [serverMode, setServerMode] = useState<PermissionMode>(initialMode);
  const [modeVersion, setModeVersion] = useState<number>(initialModeVersion);
  const lastKnownModeVersionRef = useRef<number>(initialModeVersion);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a route-level session change must reset the mode even when both sessions share the same initial values
  useEffect(() => {
    lastKnownModeVersionRef.current = initialModeVersion;
    setLocalMode(initialMode);
    setServerMode(initialMode);
    setModeVersion(initialModeVersion);
  }, [initialMode, initialModeVersion, sessionId]);

  // Apply server mode update only if version is >= our last known version.
  // This syncs both local and server mode to the confirmed value.
  const applyServerModeUpdate = useCallback(
    (mode: PermissionMode, version: number) => {
      if (version >= lastKnownModeVersionRef.current) {
        lastKnownModeVersionRef.current = version;
        setServerMode(mode);
        setLocalMode(mode); // Sync local to server-confirmed mode
        setModeVersion(version);
      }
    },
    [],
  );

  // Update local mode (UI selection) and sync or persist it on the server.
  const setPermissionMode = useCallback(
    async (mode: PermissionMode) => {
      setLocalMode(mode);

      // Active Yep processes apply the mode immediately. Idle sessions still
      // call the endpoint so the selection is durable across server restarts.
      if (statusOwner === "self" || statusOwner === "none") {
        try {
          const result = await api.setPermissionMode(sessionId, mode);
          // Update server-confirmed mode
          if (
            statusOwner === "none" ||
            result.modeVersion >= lastKnownModeVersionRef.current
          ) {
            lastKnownModeVersionRef.current = result.modeVersion;
            setServerMode(result.permissionMode);
            setLocalMode(result.permissionMode);
            setModeVersion(result.modeVersion);
          }
        } catch (err) {
          // If API fails (e.g., no active process), mode will be sent on next message
          console.warn("Failed to sync permission mode:", err);
        }
      }
    },
    [sessionId, statusOwner],
  );

  return {
    permissionMode: localMode,
    serverMode,
    modeVersion,
    applyServerModeUpdate,
    setPermissionMode,
  };
}
