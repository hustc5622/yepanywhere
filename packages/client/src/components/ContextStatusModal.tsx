import type {
  ContextCumulativeUsage,
  ContextStatusResponse,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import { useI18n } from "../i18n";
import { formatTokenCount as formatTokens } from "../lib/tokens";
import { Modal } from "./ui/Modal";

interface ContextStatusModalProps {
  projectId: string;
  sessionId: string;
  onClose: () => void;
}

export function ContextStatusModal({
  projectId,
  sessionId,
  onClose,
}: ContextStatusModalProps) {
  const { t } = useI18n();
  const [data, setData] = useState<ContextStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.getContextStatus(projectId, sessionId);
      setData(result);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectId, sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Modal
      title={
        <span className="context-status-title">
          {t("contextBreakdownTitle")}
          <button
            type="button"
            className="context-status-refresh"
            onClick={load}
            disabled={loading}
            title={t("contextRefreshTooltip")}
            aria-label={t("contextRefreshTooltip")}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M23 4v6h-6" />
              <path d="M1 20v-6h6" />
              <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
            </svg>
          </button>
        </span>
      }
      onClose={onClose}
      backLabel={t("contextStatusBackToConversation")}
    >
      {loading && !data && (
        <p className="context-status-loading">{t("sidebarLoadingSessions")}</p>
      )}
      {error && <p className="context-status-error">{error}</p>}
      {data && <ContextStatusContent data={data} />}
    </Modal>
  );
}

function ContextStatusContent({ data }: { data: ContextStatusResponse }) {
  const { t } = useI18n();

  if (data.source === "jsonl") {
    const used = data.contextUsage?.inputTokens ?? 0;
    const cw = data.contextWindow;
    const pct = cw > 0 ? Math.round((used / cw) * 100) : 0;
    return (
      <div className="context-status-body">
        <SourceBadge source="jsonl" />
        <HeroMeter
          percentage={pct}
          used={used}
          total={cw}
          model={data.model}
          modelLabel={t("processInfoLabelModel")}
        />
        <CumulativeUsageSection usage={data.cumulativeUsage} />
        {!data.contextWindowFromCache && (
          <p className="context-status-hint">
            {t("contextBreakdownEstimateHint")}
          </p>
        )}
      </div>
    );
  }

  // SDK breakdown
  // Defensive: the server can return a partial / unexpected shape (e.g. when
  // the SDK hasn't initialized yet, or a provider doesn't implement context
  // tracking). Bail to a friendly message instead of letting [...undefined]
  // crash the whole React tree (which used to unmount the modal → page
  // turned black with no error visible to the user).
  if (!Array.isArray(data.categories)) {
    return (
      <div className="context-status-body">
        <p className="context-status-error">
          {`Unexpected response shape (source: ${
            (data as { source?: string }).source ?? "missing"
          }, no categories). The agent process may still be starting — try again in a moment.`}
        </p>
      </div>
    );
  }

  const sortedCategories = [...data.categories].sort(
    (a, b) => b.tokens - a.tokens,
  );

  return (
    <div className="context-status-body">
      <SourceBadge source="sdk" />
      <HeroMeter
        percentage={data.percentage}
        used={data.totalTokens}
        total={data.maxTokens}
        model={data.model}
        modelLabel={t("processInfoLabelModel")}
        rawMax={
          data.rawMaxTokens !== data.maxTokens ? data.rawMaxTokens : undefined
        }
        rawMaxLabel={t("contextBreakdownRawMaxLabel")}
      />

      <CumulativeUsageSection usage={data.cumulativeUsage} />

      {sortedCategories.length > 0 && (
        <Section heading={t("contextCategoryHeading")}>
          <TokenRowList
            rows={sortedCategories.map((c) => ({
              key: c.name,
              label: c.name,
              tokens: c.tokens,
              color: c.color || undefined,
            }))}
            maxTokens={data.maxTokens}
            showBar
          />
        </Section>
      )}

      {data.mcpTools.length > 0 && (
        <Section heading={t("contextMcpHeading")}>
          <TokenRowList
            rows={[...data.mcpTools]
              .sort((a, b) => b.tokens - a.tokens)
              .map((tool) => ({
                key: `${tool.serverName}:${tool.name}`,
                label: `${tool.serverName} / ${tool.name}`,
                tokens: tool.tokens,
              }))}
            maxTokens={data.maxTokens}
          />
        </Section>
      )}

      {data.skills && data.skills.includedSkills > 0 && (
        <Section
          heading={`${t("contextSkillsHeading")} (${data.skills.includedSkills}/${data.skills.totalSkills})`}
        >
          <TokenRowList
            rows={[...data.skills.skillFrontmatter]
              .sort((a, b) => b.tokens - a.tokens)
              .map((s) => ({
                key: s.name,
                label: s.name,
                tokens: s.tokens,
              }))}
            maxTokens={data.maxTokens}
          />
        </Section>
      )}

      {data.memoryFiles.length > 0 && (
        <Section heading={t("contextMemoryHeading")}>
          <TokenRowList
            rows={[...data.memoryFiles]
              .sort((a, b) => b.tokens - a.tokens)
              .map((f) => ({
                key: f.path,
                label: f.path,
                tokens: f.tokens,
              }))}
            maxTokens={data.maxTokens}
          />
        </Section>
      )}

      {data.slashCommands && data.slashCommands.includedCommands > 0 && (
        <Section heading={t("contextSlashCommandsHeading")}>
          <TokenRowList
            rows={[
              {
                key: "all-slash",
                label: `${data.slashCommands.includedCommands} / ${data.slashCommands.totalCommands}`,
                tokens: data.slashCommands.tokens,
              },
            ]}
            maxTokens={data.maxTokens}
          />
        </Section>
      )}
    </div>
  );
}

interface HeroMeterProps {
  percentage: number;
  used: number;
  total: number;
  model?: string;
  modelLabel: string;
  rawMax?: number;
  rawMaxLabel?: string;
}

/**
 * Providers disagree on percentage precision: Claude/Codex round server-side,
 * while Pi forwards the raw float from `get_session_stats` (e.g. 50.2158).
 * Render at most one decimal so the hero number stays readable, and drop a
 * trailing `.0` so already-rounded providers look unchanged.
 */
function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
}

function HeroMeter({
  percentage,
  used,
  total,
  model,
  modelLabel,
  rawMax,
  rawMaxLabel,
}: HeroMeterProps) {
  const clamped = Math.max(0, Math.min(100, percentage));
  const severity = clamped >= 90 ? "danger" : clamped >= 75 ? "warn" : "normal";
  return (
    <div className="context-status-hero">
      <div className="context-status-hero-numbers">
        <span className={`context-status-percent-big severity-${severity}`}>
          {formatPercent(clamped)}%
        </span>
        <span className="context-status-fraction">
          {formatTokens(used)} / {formatTokens(total)}
        </span>
      </div>
      <div className="context-status-hero-bar" aria-hidden="true">
        <div
          className={`context-status-hero-bar-fill severity-${severity}`}
          style={{ width: `${clamped}%` }}
        />
      </div>
      {(model || rawMax !== undefined) && (
        <div className="context-status-hero-meta">
          {model && (
            <span className="context-status-hero-meta-item">
              <span className="context-status-meta-label">{modelLabel}</span>
              <span className="context-status-meta-value">{model}</span>
            </span>
          )}
          {rawMax !== undefined && rawMaxLabel && (
            <span className="context-status-hero-meta-item">
              <span className="context-status-meta-label">{rawMaxLabel}</span>
              <span className="context-status-meta-value">
                {formatTokens(rawMax)}
              </span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

interface TokenRow {
  key: string;
  label: string;
  tokens: number;
  color?: string;
}

function TokenRowList({
  rows,
  maxTokens,
  showBar = false,
}: {
  rows: TokenRow[];
  maxTokens: number;
  showBar?: boolean;
}) {
  return (
    <ul className="context-status-list">
      {rows.map((row) => {
        const pct =
          maxTokens > 0 ? Math.round((row.tokens / maxTokens) * 100) : 0;
        const highlight = pct >= 10;
        return (
          <li
            key={row.key}
            className={`context-status-row${
              showBar ? " context-status-row--with-bar" : ""
            }${highlight ? " context-status-row--highlight" : ""}`}
          >
            <span className="context-status-row-label">{row.label}</span>
            {showBar && (
              <span className="context-status-row-bar">
                <span
                  className="context-status-row-bar-fill"
                  style={{
                    width: `${Math.min(100, pct)}%`,
                    backgroundColor: row.color || undefined,
                  }}
                />
              </span>
            )}
            <span className="context-status-row-tokens">
              <span className="context-status-row-tokens-value">
                {formatTokens(row.tokens)}
              </span>
              <span className="context-status-row-tokens-pct">{pct}%</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Section({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <section className="context-status-section">
      <h4 className="context-status-section-heading">{heading}</h4>
      {children}
    </section>
  );
}

/**
 * Mirrors Claude Code's `/status` output: a flat list of cumulative input,
 * output, cache-read, and cache-creation tokens for the whole session.
 *
 * Returns null when the server didn't ship the field — older server builds
 * or providers (Codex/Gemini) that don't expose per-turn usage simply hide
 * the block instead of showing zeros.
 */
function CumulativeUsageSection({
  usage,
}: {
  usage?: ContextCumulativeUsage;
}) {
  const { t } = useI18n();
  if (!usage) return null;

  const rows = [
    {
      key: "input",
      label: t("contextCumulativeInput"),
      tokens: usage.inputTokens,
    },
    {
      key: "output",
      label: t("contextCumulativeOutput"),
      tokens: usage.outputTokens,
    },
    {
      key: "cache-read",
      label: t("contextCumulativeCacheRead"),
      tokens: usage.cacheReadTokens,
    },
    {
      key: "cache-creation",
      label: t("contextCumulativeCacheCreation"),
      tokens: usage.cacheCreationTokens,
    },
  ];

  return (
    <Section
      heading={`${t("contextCumulativeHeading")} (${t(
        "contextCumulativeTurns",
        {
          count: usage.turnCount,
        },
      )})`}
    >
      <ul className="context-status-list">
        {rows.map((row) => (
          <li key={row.key} className="context-status-row">
            <span className="context-status-row-label">{row.label}</span>
            <span className="context-status-row-tokens">
              <span
                className="context-status-row-tokens-value"
                title={`${row.tokens.toLocaleString()} tokens`}
              >
                {formatTokens(row.tokens)}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function SourceBadge({ source }: { source: "sdk" | "jsonl" }) {
  const { t } = useI18n();
  return (
    <span className={`context-status-source-badge source-${source}`}>
      {source === "sdk"
        ? t("contextBreakdownSourceSDK")
        : t("contextBreakdownSourceEstimate")}
    </span>
  );
}
