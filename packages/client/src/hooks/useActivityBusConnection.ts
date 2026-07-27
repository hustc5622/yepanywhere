import { useEffect } from "react";
import { useAuth } from "../contexts/AuthContext";
import { activityBus } from "../lib/activityBus";
import { isMobileShellDocument } from "../lib/nativePushBridge";

/**
 * Manages the activityBus connection based on authentication state.
 *
 * When auth is enabled but user is not authenticated, we don't connect
 * to avoid 401 errors that can trigger the browser's basic auth prompt.
 *
 * The Android shell intentionally unsubscribes while hidden. Native FCM and
 * the bounded session watcher cover background notifications without keeping
 * the full React event pipeline active.
 */
export function useActivityBusConnection(): void {
  const { isAuthenticated, authEnabled, isLoading } = useAuth();

  useEffect(() => {
    if (isLoading) return;
    const shouldConnect = !authEnabled || isAuthenticated;
    const suspendWhileHidden =
      typeof document !== "undefined" && isMobileShellDocument();
    let suspended = false;

    const syncConnection = () => {
      if (!shouldConnect) {
        activityBus.disconnect();
        return;
      }
      if (suspendWhileHidden && document.hidden) {
        suspended = true;
        activityBus.disconnect();
        return;
      }

      activityBus.connect();
      if (suspended) {
        suspended = false;
        activityBus.refreshConsumers();
      }
    };

    syncConnection();
    if (suspendWhileHidden) {
      document.addEventListener("visibilitychange", syncConnection);
    }

    return () => {
      if (suspendWhileHidden) {
        document.removeEventListener("visibilitychange", syncConnection);
      }
      activityBus.disconnect();
    };
  }, [isAuthenticated, authEnabled, isLoading]);
}
