import { useCallback, useEffect, useRef } from "react";
import { activityBus } from "../lib/activityBus";
import { checkForBuildRecovery } from "../lib/buildRecovery";

const CHECK_DEBOUNCE_MS = 2_000;

/**
 * Reloads an already-open production tab after a server-only deploy serves a
 * different client build. New navigations already get fresh index.html; this
 * covers tabs that are still executing the old SPA bundle.
 */
export function useBuildRefresh(): void {
  const inFlightRef = useRef(false);
  const lastCheckAtRef = useRef(0);

  const checkForNewBuild = useCallback(async () => {
    const now = Date.now();
    if (inFlightRef.current || now - lastCheckAtRef.current < CHECK_DEBOUNCE_MS)
      return;

    inFlightRef.current = true;
    lastCheckAtRef.current = now;

    try {
      await checkForBuildRecovery("routine");
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    void checkForNewBuild();

    const unsubscribeReconnect = activityBus.on("reconnect", () => {
      void checkForNewBuild();
    });
    const unsubscribeRefresh = activityBus.on("refresh", () => {
      void checkForNewBuild();
    });

    const onFocus = () => {
      void checkForNewBuild();
    };
    const onVisibilityChange = () => {
      if (!document.hidden) void checkForNewBuild();
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      unsubscribeReconnect();
      unsubscribeRefresh();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [checkForNewBuild]);
}
