import { Fragment, StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";

// Toggle to disable StrictMode for easier debugging (avoids double renders)
const STRICT_MODE = false;
const Wrapper = STRICT_MODE ? StrictMode : Fragment;
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useParams,
} from "react-router-dom";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { initializeFontSize } from "./hooks/useFontSize";
import { initializeTabSize } from "./hooks/useTabSize";
import { initializeTheme } from "./hooks/useTheme";
import { I18nProvider } from "./i18n";
import { NavigationLayout } from "./layouts";
import { armSplashSafety } from "./lib/splash";
import "./styles/index.css";

const ActivityPage = lazy(() =>
  import("./pages/ActivityPage").then((module) => ({
    default: module.ActivityPage,
  })),
);
const AgentsPage = lazy(() =>
  import("./pages/AgentsPage").then((module) => ({
    default: module.AgentsPage,
  })),
);
const ArchivePage = lazy(() =>
  import("./pages/ArchivePage").then((module) => ({
    default: module.ArchivePage,
  })),
);
const FilePage = lazy(() =>
  import("./pages/FilePage").then((module) => ({ default: module.FilePage })),
);
const GlobalSessionsPage = lazy(() =>
  import("./pages/GlobalSessionsPage").then((module) => ({
    default: module.GlobalSessionsPage,
  })),
);
const InboxPage = lazy(() =>
  import("./pages/InboxPage").then((module) => ({
    default: module.InboxPage,
  })),
);
const LoginPage = lazy(() =>
  import("./pages/LoginPage").then((module) => ({
    default: module.LoginPage,
  })),
);
const NewSessionPage = lazy(() =>
  import("./pages/NewSessionPage").then((module) => ({
    default: module.NewSessionPage,
  })),
);
const ProjectsPage = lazy(() =>
  import("./pages/ProjectsPage").then((module) => ({
    default: module.ProjectsPage,
  })),
);
const ReportsPage = lazy(() =>
  import("./pages/ReportsPage").then((module) => ({
    default: module.ReportsPage,
  })),
);
const SearchPage = lazy(() =>
  import("./pages/SearchPage").then((module) => ({
    default: module.SearchPage,
  })),
);
const SessionPage = lazy(() =>
  import("./pages/SessionPage").then((module) => ({
    default: module.SessionPage,
  })),
);
const SessionLocatorPage = lazy(() =>
  import("./pages/SessionLocatorPage").then((module) => ({
    default: module.SessionLocatorPage,
  })),
);
const TerminalPage = lazy(() =>
  import("./pages/TerminalPage").then((module) => ({
    default: module.TerminalPage,
  })),
);
const SettingsLayout = lazy(() =>
  import("./pages/settings").then((module) => ({
    default: module.SettingsLayout,
  })),
);

function RedirectWithSearch({ to }: { to: string }) {
  const location = useLocation();
  return <Navigate to={{ pathname: to, search: location.search }} replace />;
}

function LegacyDeviceRedirect() {
  const location = useLocation();
  const { deviceId } = useParams<{ deviceId?: string }>();
  const searchParams = new URLSearchParams(location.search);

  if (deviceId) {
    searchParams.set("deviceId", deviceId);
  }

  const search = searchParams.toString();
  return (
    <Navigate
      to={{
        pathname: "/settings/emulator",
        search: search ? `?${search}` : "",
      }}
      replace
    />
  );
}

// Apply saved preferences before React renders to avoid flash
initializeTheme();
initializeFontSize();
initializeTabSize();

// SSE activity stream connection is managed by useActivityBusConnection hook
// in App.tsx, which connects only when authenticated (or auth is disabled)

// Get base URL for router (Vite sets this based on --base flag)
// Remove trailing slash for BrowserRouter basename
const basename = import.meta.env.BASE_URL.replace(/\/$/, "") || undefined;

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

createRoot(rootElement).render(
  <Wrapper>
    <I18nProvider>
      <ErrorBoundary>
        <BrowserRouter basename={basename}>
          <App>
            <Suspense fallback={null}>
              <Routes>
                <Route path="/" element={<Navigate to="/projects" replace />} />
                {/* Login page (no layout wrapper) */}
                <Route path="/login" element={<LoginPage />} />
                {/* IMPORTANT: Keep routes in sync with remote-main.tsx — adding a route here? Add it there too! */}
                <Route element={<NavigationLayout />}>
                  <Route path="/projects" element={<ProjectsPage />} />
                  <Route path="/sessions" element={<GlobalSessionsPage />} />
                  <Route path="/archive" element={<ArchivePage />} />
                  <Route path="/search" element={<SearchPage />} />
                  <Route path="/reports" element={<ReportsPage />} />
                  <Route path="/agents" element={<AgentsPage />} />
                  <Route path="/inbox" element={<InboxPage />} />
                  <Route path="/settings" element={<SettingsLayout />} />
                  <Route
                    path="/settings/:category"
                    element={<SettingsLayout />}
                  />
                  {/* Project-scoped pages */}
                  <Route
                    path="/projects/:projectId"
                    element={<Navigate to="/sessions" replace />}
                  />
                  <Route
                    path="/git-status"
                    element={
                      <RedirectWithSearch to="/settings/source-control" />
                    }
                  />
                  <Route path="/devices" element={<LegacyDeviceRedirect />} />
                  <Route
                    path="/devices/:deviceId"
                    element={<LegacyDeviceRedirect />}
                  />
                  <Route path="/terminal" element={<TerminalPage />} />
                  <Route
                    path="/terminal/:terminalId"
                    element={<TerminalPage />}
                  />
                  <Route path="/new-session" element={<NewSessionPage />} />
                  <Route
                    path="/projects/:projectId/sessions/:sessionId"
                    element={<SessionPage />}
                  />
                  {/* Bare session id: resolve its project, then redirect. */}
                  <Route
                    path="/sessions/:sessionId"
                    element={<SessionLocatorPage />}
                  />
                </Route>
                {/* File page has its own layout (no sidebar) */}
                <Route
                  path="/projects/:projectId/file"
                  element={<FilePage />}
                />
                {/* Activity page has its own layout */}
                <Route path="/activity" element={<ActivityPage />} />
              </Routes>
            </Suspense>
          </App>
        </BrowserRouter>
      </ErrorBoundary>
    </I18nProvider>
  </Wrapper>,
);

// Arm the splash safety timeout (max 6s). The splash is dismissed by
// whichever first-paint screen calls useHideSplashOnReady(); this is just
// the fallback in case nothing ever signals ready.
armSplashSafety();
