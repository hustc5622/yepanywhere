import { type ReactNode, useEffect } from "react";
import { ConnectionBar } from "./components/ConnectionBar";
import { FloatingActionButton } from "./components/FloatingActionButton";
import { ReloadBanner } from "./components/ReloadBanner";
import { OnboardingWizard } from "./components/onboarding";
import { AuthProvider } from "./contexts/AuthContext";
import { InboxProvider } from "./contexts/InboxContext";
import { SchemaValidationProvider } from "./contexts/SchemaValidationContext";
import { ToastProvider } from "./contexts/ToastContext";
import { useActivityBusConnection } from "./hooks/useActivityBusConnection";
import { useBuildRefresh } from "./hooks/useBuildRefresh";
import { useNeedsAttentionBadge } from "./hooks/useNeedsAttentionBadge";
import { useSyncNotifyInAppSetting } from "./hooks/useNotifyInApp";
import { useOnboarding } from "./hooks/useOnboarding";
import { useReloadNotifications } from "./hooks/useReloadNotifications";
import { I18nProvider } from "./i18n";
import { initTextSelectionTracking } from "./lib/clipboard";
import { initClientLogCollection } from "./lib/diagnostics";

interface Props {
  children: ReactNode;
}

/**
 * Inner component that uses hooks requiring InboxContext.
 */
function AppContent({ children }: Props) {
  // Manage SSE connection based on auth state (prevents 401s on login page)
  useActivityBusConnection();

  // Auto-refresh already-open production tabs after a server-only deploy.
  useBuildRefresh();

  // Client-side log collection for connection diagnostics
  useEffect(() => initClientLogCollection(), []);

  // Preserve native text selections long enough for copy controls to respect
  // them even when a tap briefly moves focus on mobile WebViews.
  useEffect(() => initTextSelectionTracking(), []);

  // Sync notifyInApp setting to service worker on app startup and SW restarts
  useSyncNotifyInAppSetting();

  // Update tab title with needs-attention badge count (uses InboxContext)
  useNeedsAttentionBadge();

  const {
    isManualReloadMode,
    pendingReloads,
    reloadBackend,
    reloadFrontend,
    reloadRuntime,
    dismiss,
    unsafeToRestart,
    workerActivity,
    unsafeToReloadRuntime,
  } = useReloadNotifications();

  return (
    <>
      <ConnectionBar />
      {isManualReloadMode && pendingReloads.backend && (
        <ReloadBanner
          target="backend"
          onReload={reloadBackend}
          onDismiss={() => dismiss("backend")}
          unsafeToRestart={unsafeToRestart}
          activeWorkers={workerActivity.activeWorkers}
        />
      )}
      {isManualReloadMode && pendingReloads.frontend && (
        <ReloadBanner
          target="frontend"
          onReload={reloadFrontend}
          onDismiss={() => dismiss("frontend")}
        />
      )}
      {isManualReloadMode && pendingReloads.runtime && (
        <ReloadBanner
          target="runtime"
          onReload={() => void reloadRuntime(workerActivity.hasActiveWork)}
          onDismiss={() => dismiss("runtime")}
          unsafeToRestart={unsafeToReloadRuntime}
          activeWorkers={workerActivity.activeWorkers}
        />
      )}
      {children}
      <FloatingActionButton />
    </>
  );
}

/**
 * App wrapper that provides global functionality like reload notifications, toasts,
 * and schema validation.
 */
export function App({ children }: Props) {
  const { showWizard, isLoading, completeOnboarding } = useOnboarding();

  return (
    <I18nProvider>
      <ToastProvider>
        <AuthProvider>
          <InboxProvider>
            <SchemaValidationProvider>
              <AppContent>{children}</AppContent>
              {!isLoading && showWizard && (
                <OnboardingWizard onComplete={completeOnboarding} />
              )}
            </SchemaValidationProvider>
          </InboxProvider>
        </AuthProvider>
      </ToastProvider>
    </I18nProvider>
  );
}
