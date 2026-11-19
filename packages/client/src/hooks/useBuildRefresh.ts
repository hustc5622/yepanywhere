import { useEffect } from "react";
import { activityBus } from "../lib/activityBus";
import {
  checkForNewBuild,
  markDocumentRevived,
  shouldAutoRefreshBuild,
} from "../lib/buildRefresh";

/**
 * Reloads an already-open production tab after a server-only deploy serves a
 * different client build. New navigations already get fresh index.html; this
 * covers tabs still executing an old SPA bundle, including documents that the
 * browser revived from history or the back/forward cache.
 */
export function useBuildRefresh(): void {
  useEffect(() => {
    if (!shouldAutoRefreshBuild()) return;

    const check = () => {
      void checkForNewBuild();
    };
    check();

    const unsubscribeReconnect = activityBus.on("reconnect", check);
    const unsubscribeRefresh = activityBus.on("refresh", check);

    const onVisibilityChange = () => {
      if (!document.hidden) check();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      markDocumentRevived();
      check();
    };

    window.addEventListener("focus", check);
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      unsubscribeReconnect();
      unsubscribeRefresh();
      window.removeEventListener("focus", check);
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);
}
