import { DEFAULT_PERMISSION_MODE } from "@yep-anywhere/shared";
import { useCallback, useRef, useState } from "react";
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
  /** Update the UI mode and, when a process is active, sync it to the server. */
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
): UseSessionPermissionModeResult {
  // localMode is UI-selected, serverMode is confirmed by server
  const [localMode, setLocalMode] = useState<PermissionMode>(
    DEFAULT_PERMISSION_MODE,
  );
  const [serverMode, setServerMode] = useState<PermissionMode>(
    DEFAULT_PERMISSION_MODE,
  );
  const [modeVersion, setModeVersion] = useState<number>(0);
  const lastKnownModeVersionRef = useRef<number>(0);

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

  // Update local mode (UI selection) and sync to server if process is active
  const setPermissionMode = useCallback(
    async (mode: PermissionMode) => {
      setLocalMode(mode);

      // If there's an active process, immediately sync to server
      if (statusOwner === "self" || statusOwner === "external") {
        try {
          const result = await api.setPermissionMode(sessionId, mode);
          // Update server-confirmed mode
          if (result.modeVersion >= lastKnownModeVersionRef.current) {
            lastKnownModeVersionRef.current = result.modeVersion;
            setServerMode(result.permissionMode);
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
