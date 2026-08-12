import type {
  ContextUsage,
  ProviderName,
  SessionSandboxPolicy,
} from "@yep-anywhere/shared";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useActivityBusState } from "../hooks/useActivityBusState";
import type { ProcessState } from "../hooks/useSession";
import { useI18n } from "../i18n";
import type { SessionStatus } from "../types";
import { Modal } from "./ui/Modal";

interface ProcessInfo {
  id: string;
  sessionId: string;
  projectId: string;
  projectPath: string;
  projectName: string;
  sessionTitle: string | null;
  state: string;
  startedAt: string;
  queueDepth: number;
  idleSince?: string;
  holdSince?: string;
  terminationReason?: string;
  terminatedAt?: string;
  provider: string;
  thinking?: { type: string };
  effort?: string;
  model?: string;
  executor?: string;
}

interface ProcessInfoModalProps {
  sessionId: string;
  provider: ProviderName | undefined;
  model?: string;
  status: SessionStatus;
  processState: ProcessState;
  contextUsage?: ContextUsage;
  originator?: string;
  cliVersion?: string;
  sessionSource?: string;
  approvalPolicy?: string;
  sandboxPolicy?: SessionSandboxPolicy;
  createdAt?: string;
  /** Whether the session-specific SSE stream is connected */
  sessionStreamConnected: boolean;
  /** Timestamp of last SSE activity for this session */
  lastSessionEventAt?: string | null;
  onClose: () => void;
}

function formatThinkingConfig(
  thinking?: { type: string },
  effort?: string,
  t?: (key: string) => string,
): string {
  if (!thinking || thinking.type === "disabled") {
    return t ? t("processInfoThinkingDisabled") : "Disabled";
  }
  const mode =
    thinking.type === "adaptive"
      ? t
        ? t("processInfoThinkingAdaptive")
        : "Adaptive"
      : t
        ? t("processInfoThinkingEnabled")
        : "Enabled";
  return effort ? `${mode} (${effort})` : mode;
}

function formatDuration(startedAt: string): string {
  const start = new Date(startedAt);
  const now = new Date();
  const diffMs = now.getTime() - start.getTime();

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function formatTime(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleString();
}

function formatTimeAgo(
  timestamp: number | null,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  if (!timestamp) return t("processInfoNever");
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 5) return t("processInfoJustNow");
  if (seconds < 60) return t("processInfoSecondsAgo", { seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("processInfoMinutesAgo", { minutes });
  const hours = Math.floor(minutes / 60);
  return t("processInfoHoursAgo", { hours, minutes: minutes % 60 });
}

function formatSandboxPolicy(
  policy: SessionSandboxPolicy | undefined,
  t: (key: string) => string,
): string | null {
  if (!policy) return null;

  const details: string[] = [];
  if (policy.networkAccess !== undefined) {
    details.push(
      policy.networkAccess
        ? t("processInfoNetworkOn")
        : t("processInfoNetworkOff"),
    );
  }
  if (policy.excludeTmpdirEnvVar !== undefined) {
    details.push(
      policy.excludeTmpdirEnvVar
        ? t("processInfoTmpdirExcluded")
        : t("processInfoTmpdirIncluded"),
    );
  }
  if (policy.excludeSlashTmp !== undefined) {
    details.push(
      policy.excludeSlashTmp
        ? t("processInfoTmpExcluded")
        : t("processInfoTmpIncluded"),
    );
  }

  if (details.length === 0) return policy.type;
  return `${policy.type} (${details.join(", ")})`;
}

function InfoRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string | number | undefined | null;
  mono?: boolean;
}) {
  if (value === undefined || value === null) return null;
  return (
    <div className="process-info-row">
      <span className="process-info-label">{label}</span>
      <span className={`process-info-value ${mono ? "mono" : ""}`}>
        {value}
      </span>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="process-info-section">
      <h3 className="process-info-section-title">{title}</h3>
      {children}
    </div>
  );
}

export function ProcessInfoModal({
  sessionId,
  provider,
  model,
  status,
  processState,
  contextUsage,
  originator,
  cliVersion,
  sessionSource,
  approvalPolicy,
  sandboxPolicy,
  createdAt,
  sessionStreamConnected,
  lastSessionEventAt,
  onClose,
}: ProcessInfoModalProps) {
  const { t } = useI18n();
  const tr = (key: string, vars?: Record<string, string | number>): string =>
    t(key as never, vars);
  const [processInfo, setProcessInfo] = useState<ProcessInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { connected: streamConnected, connectionState } = useActivityBusState();

  // Fetch process info when modal opens (if session is owned)
  useEffect(() => {
    if (status.owner !== "self") return;

    setLoading(true);
    setError(null);

    api
      .getProcessInfo(sessionId)
      .then((res) => {
        setProcessInfo(res.process);
      })
      .catch((err) => {
        setError(err.message || t("processInfoError"));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [sessionId, status.owner, t]);

  // Format kebab-case to Title Case (e.g., "in-turn" -> "In Turn")
  const formatKebab = (s: string | undefined) => {
    if (!s || typeof s !== "string") return "";
    return s
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  };

  const getProviderDisplay = (p: string | undefined) => {
    if (!p) return "Unknown";
    switch (p) {
      case "claude":
        return "Claude (Anthropic)";
      case "codex":
        return "Codex (OpenAI)";
      case "codex-oss":
        return "Codex OSS (Local)";
      case "gemini":
        return "Gemini (Google)";
      case "opencode":
        return "OpenCode";
      default:
        return p;
    }
  };

  return (
    <Modal title={t("processInfoTitle")} onClose={onClose}>
      <div className="process-info-content">
        {/* Session Info - always available */}
        <Section title={t("processInfoSectionSession")}>
          <InfoRow
            label={t("processInfoLabelSessionId")}
            value={sessionId}
            mono
          />
          {createdAt && (
            <InfoRow
              label={t("processInfoLabelCreated")}
              value={formatTime(createdAt)}
            />
          )}
          <InfoRow
            label={t("processInfoLabelProvider")}
            value={getProviderDisplay(provider)}
          />
          <InfoRow
            label={t("processInfoLabelModel")}
            value={model || t("processInfoDefaultModel")}
            mono
          />
          <InfoRow
            label={t("processInfoLabelOwnership")}
            value={formatKebab(status.owner)}
          />
          <InfoRow
            label={t("processInfoLabelActivity")}
            value={formatKebab(processState)}
          />
          <InfoRow label={t("processInfoLabelOriginator")} value={originator} />
          <InfoRow
            label={t("processInfoLabelCliVersion")}
            value={cliVersion}
            mono
          />
          <InfoRow
            label={t("processInfoLabelSessionSource")}
            value={
              typeof sessionSource === "string" ? sessionSource : undefined
            }
          />
          <InfoRow
            label={t("processInfoLabelApprovalPolicy")}
            value={approvalPolicy}
            mono
          />
          <InfoRow
            label={t("processInfoLabelSandboxPolicy")}
            value={formatSandboxPolicy(sandboxPolicy, tr)}
            mono
          />
        </Section>

        {/* Connection Info */}
        <Section title={t("processInfoSectionConnection")}>
          <InfoRow
            label={t("processInfoLabelActivityStream")}
            value={
              streamConnected
                ? t("processInfoConnected")
                : t("processInfoDisconnected")
            }
          />
          <InfoRow
            label={t("processInfoLabelConnectionState")}
            value={connectionState}
          />
          <InfoRow
            label={
              status.owner === "external"
                ? t("processInfoLabelSessionWatch")
                : t("processInfoLabelSessionStream")
            }
            value={
              status.owner === "none"
                ? t("processInfoNotSubscribed")
                : sessionStreamConnected
                  ? t("processInfoConnected")
                  : t("processInfoDisconnected")
            }
          />
          {status.owner === "self" && lastSessionEventAt && (
            <InfoRow
              label={t("processInfoLabelLastSessionEvent")}
              value={formatTimeAgo(new Date(lastSessionEventAt).getTime(), tr)}
            />
          )}
          {status.owner === "external" && (
            <InfoRow
              label={t("processInfoLabelSubscriptionMode")}
              value={t("processInfoFocusedWatch")}
            />
          )}
        </Section>

        {/* Context Usage - if available */}
        {contextUsage && (
          <Section title={t("processInfoSectionTokenUsage")}>
            <InfoRow
              label={t("processInfoLabelInputTokens")}
              value={contextUsage.inputTokens.toLocaleString()}
            />
            {contextUsage.outputTokens !== undefined && (
              <InfoRow
                label={t("processInfoLabelOutputTokens")}
                value={contextUsage.outputTokens.toLocaleString()}
              />
            )}
            <InfoRow
              label={t("processInfoLabelContextUsed")}
              value={`${contextUsage.percentage.toFixed(1)}%`}
            />
            {contextUsage.cacheReadTokens !== undefined && (
              <InfoRow
                label={t("processInfoLabelCacheRead")}
                value={contextUsage.cacheReadTokens.toLocaleString()}
              />
            )}
            {contextUsage.cacheCreationTokens !== undefined && (
              <InfoRow
                label={t("processInfoLabelCacheCreated")}
                value={contextUsage.cacheCreationTokens.toLocaleString()}
              />
            )}
          </Section>
        )}

        {/* Process Info - always show, with state-dependent content */}
        <Section title={t("processInfoSectionProcess")}>
          {status.owner === "self" ? (
            <>
              {loading && (
                <div className="process-info-loading">
                  {t("newSessionLoading")}
                </div>
              )}
              {error && <div className="process-info-error">{error}</div>}
              {processInfo && (
                <>
                  <InfoRow
                    label={t("processInfoLabelProcessId")}
                    value={processInfo.id}
                    mono
                  />
                  <InfoRow
                    label={t("processInfoLabelStarted")}
                    value={formatTime(processInfo.startedAt)}
                  />
                  <InfoRow
                    label={t("processInfoLabelUptime")}
                    value={formatDuration(processInfo.startedAt)}
                  />
                  <InfoRow
                    label={t("processInfoLabelQueueDepth")}
                    value={processInfo.queueDepth}
                  />
                  <InfoRow
                    label={t("processInfoLabelExtendedThinking")}
                    value={formatThinkingConfig(
                      processInfo.thinking,
                      processInfo.effort,
                      tr,
                    )}
                  />
                  {processInfo.idleSince && (
                    <InfoRow
                      label={t("processInfoLabelIdleSince")}
                      value={formatTime(processInfo.idleSince)}
                    />
                  )}
                  {processInfo.holdSince && (
                    <InfoRow
                      label={t("processInfoLabelHoldSince")}
                      value={formatTime(processInfo.holdSince)}
                    />
                  )}
                </>
              )}
              {!loading && !processInfo && !error && (
                <div className="process-info-loading">
                  {t("processInfoNoProcessData")}
                </div>
              )}
            </>
          ) : status.owner === "external" ? (
            <div className="process-info-muted">
              {t("processInfoExternalProcess")}
            </div>
          ) : (
            <div className="process-info-muted">
              {t("processInfoNoActiveProcess")}
            </div>
          )}
        </Section>

        {/* Project Info - from process if available */}
        {processInfo && (
          <Section title={t("processInfoSectionProject")}>
            <InfoRow
              label={t("processInfoLabelProjectName")}
              value={processInfo.projectName}
            />
            <InfoRow
              label={t("processInfoLabelProjectPath")}
              value={processInfo.projectPath}
              mono
            />
            <InfoRow
              label={t("processInfoLabelRemoteHost")}
              value={processInfo.executor}
              mono
            />
          </Section>
        )}
      </div>
    </Modal>
  );
}
