import { useEffect, useState } from "react";
import {
  MOBILE_SHELL_NODES,
  useMobileShellChannel,
} from "../hooks/useMobileShellChannel";
import { useI18n } from "../i18n";
import {
  type MobileNodeNotification,
  getMobileNodeNotifications,
} from "../lib/nativePushBridge";

const SHORTCUTS = ["home", "mini"].map((alias) =>
  MOBILE_SHELL_NODES.find((node) => node.alias === alias),
);

export function MobileServerSwitcher({ visible }: { visible: boolean }) {
  const { t } = useI18n();
  const { isMobileShell, nodeOrigin, setNode } = useMobileShellChannel();
  const [nodes, setNodes] = useState<MobileNodeNotification[]>([]);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    if (!isMobileShell || !visible) return;
    let disposed = false;
    let pending = false;
    const refresh = async () => {
      if (disposed || pending || document.visibilityState === "hidden") return;
      pending = true;
      try {
        const result = await getMobileNodeNotifications();
        if (!disposed) {
          setNodes(result.nodes);
          setUnavailable(false);
        }
      } catch {
        if (!disposed) setUnavailable(true);
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    const onVisibility = () => void refresh();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [isMobileShell, visible]);

  if (!isMobileShell) return null;

  return (
    <div className="sidebar-server-switcher" aria-label={t("sidebarServers")}>
      {SHORTCUTS.map((node) => {
        if (!node) return null;
        const state = nodes.find((item) => item.alias === node.alias);
        const active = nodeOrigin === node.origin;
        const count = state?.finishedUnreadCount ?? 0;
        const status = unavailable
          ? t("sidebarServerNotificationsUnavailable")
          : !state
            ? t("sidebarServerChecking")
            : state.status === "login-required"
              ? t("sidebarServerLoginRequired")
              : state.status === "offline"
                ? t("sidebarServerOffline")
                : state.limited
                  ? t("sidebarServerFinishedLimited", { count })
                  : t("sidebarServerFinished", { count });
        const name = node.alias === "home" ? "Home" : "Mini";
        return (
          <button
            key={node.alias}
            type="button"
            className={`sidebar-server-button${active ? " is-active" : ""}`}
            aria-pressed={active}
            aria-label={`${name} · ${node.label} · ${status}`}
            title={`${node.label}\n${status}\n${t("sidebarServerNotificationHint")}`}
            onClick={() => {
              if (!active) setNode(node);
            }}
          >
            <span className="sidebar-server-name">
              {name}
              {!unavailable && state?.status === "online" && count > 0 && (
                <span className="sidebar-nav-badge">
                  {count > 99 ? "99+" : `${count}${state.limited ? "+" : ""}`}
                </span>
              )}
            </span>
            <span className="sidebar-server-status">{status}</span>
          </button>
        );
      })}
    </div>
  );
}
