import { Component, type ErrorInfo, type ReactNode } from "react";
import { useI18n } from "../i18n";
import { apiPath } from "../lib/apiPath";

const CLIENT_BUILD_ID = typeof __BUILD_ID__ === "undefined" ? "" : __BUILD_ID__;
const CLIENT_BUILD_PROFILE =
  typeof __BUILD_PROFILE__ === "undefined" ? "dev" : __BUILD_PROFILE__;

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  serverVersion: string | null;
  serverBuildId: string | null;
  versionLoading: boolean;
}

export function isConfirmedBuildMismatch(
  clientBuildId: string,
  serverBuildId: string | null,
  buildProfile: string,
): boolean {
  return (
    buildProfile !== "dev" &&
    clientBuildId.length > 0 &&
    !!serverBuildId &&
    serverBuildId !== clientBuildId
  );
}

/**
 * Error boundary that catches rendering errors and displays a helpful fallback UI.
 * Shows version information to help diagnose client/server version mismatches.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      serverVersion: null,
      serverBuildId: null,
      versionLoading: false,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ errorInfo });

    // Fetch server version to help diagnose version mismatches
    this.fetchServerVersion();

    // Log error for debugging
    console.error("ErrorBoundary caught an error:", error, errorInfo);
  }

  async fetchServerVersion() {
    this.setState({ versionLoading: true });
    try {
      const res = await fetch(apiPath("/version"));
      if (res.ok) {
        const data = await res.json();
        this.setState({
          serverVersion: typeof data.current === "string" ? data.current : null,
          serverBuildId:
            typeof data.build?.buildId === "string" ? data.build.buildId : null,
        });
      }
    } catch {
      // Ignore - version fetch failed (might be why we're in an error state)
    } finally {
      this.setState({ versionLoading: false });
    }
  }

  handleReload = () => {
    window.location.reload();
  };

  hasConfirmedBuildMismatch(): boolean {
    return isConfirmedBuildMismatch(
      CLIENT_BUILD_ID,
      this.state.serverBuildId,
      CLIENT_BUILD_PROFILE,
    );
  }

  render() {
    if (this.state.hasError) {
      return (
        <ErrorBoundaryFallback
          error={this.state.error}
          serverVersion={this.state.serverVersion}
          serverBuildId={this.state.serverBuildId}
          versionLoading={this.state.versionLoading}
          buildMismatch={this.hasConfirmedBuildMismatch()}
          onReload={this.handleReload}
        />
      );
    }

    return this.props.children;
  }
}

function ErrorBoundaryFallback({
  error,
  serverVersion,
  serverBuildId,
  versionLoading,
  buildMismatch,
  onReload,
}: {
  error: Error | null;
  serverVersion: string | null;
  serverBuildId: string | null;
  versionLoading: boolean;
  buildMismatch: boolean;
  onReload: () => void;
}) {
  const { t } = useI18n();
  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>{t("errorBoundaryTitle")}</h1>

        {buildMismatch && (
          <div style={styles.versionWarning}>
            <strong>{t("errorBoundaryBuildMismatchTitle")}</strong>
            <p style={styles.versionHint}>
              {t("errorBoundaryBuildMismatchHint")}
            </p>
          </div>
        )}

        <div style={styles.errorBox}>
          <code style={styles.errorText}>
            {error?.message || t("errorBoundaryUnknownError")}
          </code>
        </div>

        <div style={styles.versionInfo}>
          <div style={styles.versionRow}>
            <span style={styles.versionLabel}>
              {t("errorBoundaryServerVersion")}
            </span>
            <span style={styles.versionValue}>
              {versionLoading
                ? t("errorBoundaryLoading")
                : serverVersion || t("errorBoundaryUnknown")}
            </span>
          </div>
          <div style={styles.versionRow}>
            <span style={styles.versionLabel}>
              {t("errorBoundaryClientBuild")}
            </span>
            <span style={styles.versionValue}>{CLIENT_BUILD_ID || "dev"}</span>
          </div>
          <div style={styles.versionRow}>
            <span style={styles.versionLabel}>
              {t("errorBoundaryServerBuild")}
            </span>
            <span style={styles.versionValue}>
              {serverBuildId || t("errorBoundaryUnknown")}
            </span>
          </div>
          {buildMismatch && (
            <p style={styles.updateHint}>
              {t("errorBoundaryBuildMismatchAction")}
            </p>
          )}
        </div>

        <div style={styles.actions}>
          <button type="button" onClick={onReload} style={styles.reloadButton}>
            {t("errorBoundaryReload")}
          </button>
          <a
            href="https://github.com/hustc5622/yepanywhere/issues"
            target="_blank"
            rel="noopener noreferrer"
            style={styles.issueLink}
          >
            {t("errorBoundaryReportIssue")}
          </a>
        </div>
      </div>
    </div>
  );
}

// Inline styles to ensure they work even if CSS fails to load
const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "100vh",
    padding: "20px",
    backgroundColor: "#1a1a2e",
    color: "#e4e4e7",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  card: {
    maxWidth: "500px",
    width: "100%",
    padding: "32px",
    backgroundColor: "#16162a",
    borderRadius: "12px",
    border: "1px solid #3f3f46",
  },
  title: {
    margin: "0 0 20px 0",
    fontSize: "24px",
    fontWeight: 600,
    color: "#f4f4f5",
  },
  versionWarning: {
    padding: "16px",
    marginBottom: "20px",
    backgroundColor: "#422006",
    border: "1px solid #92400e",
    borderRadius: "8px",
    color: "#fcd34d",
  },
  versionHint: {
    margin: "8px 0 0 0",
    fontSize: "14px",
    color: "#fde68a",
  },
  errorBox: {
    padding: "12px 16px",
    marginBottom: "20px",
    backgroundColor: "#27272a",
    borderRadius: "6px",
    overflow: "auto",
  },
  errorText: {
    fontSize: "13px",
    color: "#fca5a5",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  versionInfo: {
    marginBottom: "24px",
    padding: "12px 16px",
    backgroundColor: "#27272a",
    borderRadius: "6px",
  },
  versionRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  versionLabel: {
    fontSize: "14px",
    color: "#a1a1aa",
  },
  versionValue: {
    fontSize: "14px",
    fontFamily: "monospace",
    color: "#e4e4e7",
  },
  updateHint: {
    margin: "12px 0 0 0",
    fontSize: "13px",
    color: "#a1a1aa",
  },
  actions: {
    display: "flex",
    gap: "12px",
    flexWrap: "wrap",
  },
  reloadButton: {
    flex: 1,
    minWidth: "120px",
    padding: "12px 24px",
    fontSize: "15px",
    fontWeight: 500,
    color: "#fff",
    backgroundColor: "#6366f1",
    border: "none",
    borderRadius: "8px",
    cursor: "pointer",
  },
  issueLink: {
    flex: 1,
    minWidth: "120px",
    padding: "12px 24px",
    fontSize: "15px",
    fontWeight: 500,
    color: "#a1a1aa",
    backgroundColor: "transparent",
    border: "1px solid #3f3f46",
    borderRadius: "8px",
    textAlign: "center",
    textDecoration: "none",
  },
};
