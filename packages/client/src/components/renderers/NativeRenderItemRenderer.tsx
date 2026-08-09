import type {
  GeneratedArtifactManifest,
  NativeRenderItem as SharedNativeRenderItem,
} from "@yep-anywhere/shared";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import { useOptionalI18n } from "../../i18n";
import type { InputRequestInteractionResolution } from "../../lib/codexRenderItems";
import type { Message } from "../../types";
import type {
  InteractionRenderItem,
  NativeRenderItem,
} from "../../types/renderItems";

export type InteractionResolution = InputRequestInteractionResolution;

export interface NativeRenderContext {
  showRawReasoning: boolean;
  onResolveInteraction?: (
    resolution: InteractionResolution,
  ) => void | Promise<void>;
}

interface Props extends Partial<NativeRenderContext> {
  item: NativeRenderItem;
}

type Translator = NonNullable<ReturnType<typeof useOptionalI18n>>["t"];
type NativeType = NativeRenderItem["type"];
type ItemOf<K extends NativeType> = Extract<NativeRenderItem, { type: K }>;
type NativeRenderer<K extends NativeType> = (
  item: ItemOf<K>,
  context: NativeRenderContext,
  t: Translator,
) => React.ReactNode;
type NativeRendererRegistry = {
  [K in NativeType]: NativeRenderer<K>;
};

function duration(ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

function statusLabel(status: string, t: Translator): string {
  switch (status) {
    case "pending":
      return t("nativeRenderStatusPending");
    case "running":
      return t("nativeRenderStatusRunning");
    case "complete":
      return t("nativeRenderStatusComplete");
    case "error":
      return t("nativeRenderStatusError");
    case "declined":
      return t("nativeRenderStatusDeclined");
    case "cancelled":
      return t("nativeRenderStatusCancelled");
    default:
      return t("nativeRenderStatusUnknown");
  }
}

function Status({ status, t }: { status: string; t: Translator }) {
  return (
    <span className={`native-render-status native-render-status-${status}`}>
      {statusLabel(status, t)}
    </span>
  );
}

function Card({
  title,
  status,
  children,
  className = "",
  t,
}: {
  title: string;
  status?: string;
  children?: React.ReactNode;
  className?: string;
  t: Translator;
}) {
  return (
    <section className={`native-render-card timeline-item ${className}`}>
      <header className="native-render-header">
        <strong>{title}</strong>
        {status && <Status status={status} t={t} />}
      </header>
      {children && <div className="native-render-body">{children}</div>}
    </section>
  );
}

function Metadata({ rows }: { rows: Array<[string, string | undefined]> }) {
  const visible = rows.filter((row): row is [string, string] =>
    Boolean(row[1]),
  );
  if (visible.length === 0) return null;
  return (
    <dl className="native-render-metadata">
      {visible.map(([label, value]) => (
        <div key={`${label}:${value}`}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function artifactSize(sizeBytes: number): string {
  if (sizeBytes < 1_024) return `${sizeBytes} B`;
  if (sizeBytes < 1_024 * 1_024) return `${(sizeBytes / 1_024).toFixed(1)} KB`;
  return `${(sizeBytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

function GeneratedArtifactEntry({
  artifact,
  t,
}: {
  artifact: GeneratedArtifactManifest;
  t: Translator;
}) {
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [previewFailed, setPreviewFailed] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadFailed, setDownloadFailed] = useState(false);

  useEffect(() => {
    if (artifact.kind !== "image" || !artifact.previewUrl) return;
    let active = true;
    let objectUrl: string | undefined;
    void api
      .downloadGeneratedArtifact(artifact.previewUrl)
      .then(({ blob }) => {
        if (!active || typeof URL.createObjectURL !== "function") return;
        objectUrl = URL.createObjectURL(blob);
        setPreviewUrl(objectUrl);
      })
      .catch(() => {
        if (active) setPreviewFailed(true);
      });
    return () => {
      active = false;
      if (objectUrl && typeof URL.revokeObjectURL === "function") {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [artifact.kind, artifact.previewUrl]);

  const download = async () => {
    if (downloading) return;
    setDownloading(true);
    setDownloadFailed(false);
    try {
      const { blob } = await api.downloadGeneratedArtifact(
        artifact.downloadUrl,
      );
      const objectUrl = URL.createObjectURL(blob);
      const revokeObjectUrl = URL.revokeObjectURL;
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = artifact.fileName;
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => revokeObjectUrl(objectUrl), 0);
    } catch {
      setDownloadFailed(true);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <li className="native-render-artifact">
      {previewUrl && (
        <img
          className="native-render-artifact-preview"
          src={previewUrl}
          alt={artifact.fileName}
        />
      )}
      <div className="native-render-artifact-info">
        <strong>{artifact.fileName}</strong>
        <span>
          {artifact.mimeType} · {artifactSize(artifact.sizeBytes)}
        </span>
        <span>
          {t("nativeRenderArtifactExpires", {
            time: new Date(artifact.retention.expiresAt).toLocaleString(),
          })}
        </span>
      </div>
      <button
        type="button"
        className="native-render-artifact-download"
        disabled={downloading}
        onClick={() => void download()}
      >
        {downloading
          ? t("nativeRenderArtifactDownloading")
          : t("nativeRenderArtifactDownload")}
      </button>
      {(previewFailed || downloadFailed) && (
        <span className="native-render-error" role="alert">
          {t("nativeRenderArtifactUnavailable")}
        </span>
      )}
    </li>
  );
}

function GeneratedArtifactList({
  artifacts,
  t,
}: {
  artifacts: GeneratedArtifactManifest[] | undefined;
  t: Translator;
}) {
  if (!artifacts?.length) return null;
  return (
    <div className="native-render-artifacts">
      <strong>{t("nativeRenderArtifacts")}</strong>
      <ul>
        {artifacts.map((artifact) => (
          <GeneratedArtifactEntry key={artifact.id} artifact={artifact} t={t} />
        ))}
      </ul>
    </div>
  );
}

function decisionLabel(id: string, label: string | undefined, t: Translator) {
  if (label) return label;
  switch (id) {
    case "accept":
    case "approve":
    case "once":
      return t("nativeRenderDecisionAccept");
    case "acceptForSession":
    case "approve_for_session":
      return t("nativeRenderDecisionAcceptSession");
    case "acceptAlways":
    case "always":
    case "approve_always":
    case "acceptWithExecpolicyAmendment":
    case "applyNetworkPolicyAmendment":
      return t("nativeRenderDecisionAcceptAlways");
    case "approve_accept_edits":
      return t("nativeRenderDecisionAcceptEdits");
    case "approve_strict_auto_review":
      return t("nativeRenderDecisionStrictReview");
    case "decline":
    case "deny":
    case "reject":
      return t("nativeRenderDecisionDecline");
    case "cancel":
      return t("nativeRenderDecisionCancel");
    case "submit":
      return t("nativeRenderDecisionSubmit");
    default:
      return id;
  }
}

function InteractionCard({
  item,
  context,
  t,
}: {
  item: InteractionRenderItem;
  context: NativeRenderContext;
  t: Translator;
}) {
  const { operation } = item;
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [submitting, setSubmitting] = useState(false);
  const [confirmingDecisionId, setConfirmingDecisionId] = useState<
    string | null
  >(null);
  const [submitFailed, setSubmitFailed] = useState(false);
  const isOpen = operation.state === "open";
  const questions = operation.publicPayload.questions ?? [];
  const canAct = isOpen && Boolean(context.onResolveInteraction);
  const allRequiredAnswered = questions.every((question) => {
    if (!question.required) return true;
    const answer = answers[question.id];
    return Array.isArray(answer) ? answer.length > 0 : Boolean(answer?.trim());
  });

  const submit = async (decisionId: string) => {
    if (!canAct || submitting || !context.onResolveInteraction) return;
    setSubmitting(true);
    setSubmitFailed(false);
    try {
      await context.onResolveInteraction({
        operationId: operation.operationId,
        version: operation.version,
        decisionId,
        ...(questions.length > 0 ? { value: { answers } } : {}),
      });
      // Ordinary answers are cheap to re-enter and secret answers must not
      // outlive a successful submission in component memory.
      setAnswers({});
      setConfirmingDecisionId(null);
    } catch {
      setSubmitFailed(true);
    } finally {
      setSubmitting(false);
    }
  };

  const selectDecision = (decision: {
    id: string;
    requiresConfirmation?: boolean;
  }) => {
    if (decision.requiresConfirmation && confirmingDecisionId !== decision.id) {
      setConfirmingDecisionId(decision.id);
      return;
    }
    setConfirmingDecisionId(null);
    void submit(decision.id);
  };

  return (
    <Card
      title={operation.publicPayload.title ?? t("nativeRenderInteraction")}
      status={item.status}
      className="native-render-interaction"
      t={t}
    >
      <p>{operation.publicPayload.prompt}</p>
      {operation.publicPayload.summary && (
        <p className="native-render-secondary">
          {operation.publicPayload.summary}
        </p>
      )}
      <Metadata
        rows={[
          [t("nativeRenderTool"), operation.publicPayload.toolName],
          [t("nativeRenderCwd"), operation.publicPayload.cwd],
        ]}
      />
      {operation.publicPayload.command && (
        <pre className="native-render-code">
          {operation.publicPayload.command}
        </pre>
      )}
      {operation.publicPayload.files && (
        <div className="native-render-interaction-detail">
          <strong>{t("nativeRenderFiles")}</strong>
          <div className="native-render-chip-list">
            {operation.publicPayload.files.map((path) => (
              <code key={path}>{path}</code>
            ))}
          </div>
        </div>
      )}
      {operation.publicPayload.permissions && (
        <div className="native-render-interaction-detail">
          <strong>{t("nativeRenderPermissions")}</strong>
          <div className="native-render-chip-list">
            {operation.publicPayload.permissions.map((permission) => (
              <code key={permission}>{permission}</code>
            ))}
          </div>
        </div>
      )}
      {questions.map((question) => (
        <div className="native-render-question" key={question.id}>
          <span id={`native-question-${question.id}`}>
            {question.title ?? question.prompt}
            {question.required ? " *" : ""}
          </span>
          {question.type === "multi_select" && question.options ? (
            <span className="native-render-options">
              {question.options.map((option) => {
                const selected = Array.isArray(answers[question.id])
                  ? (answers[question.id] as string[])
                  : [];
                return (
                  <label key={option.value}>
                    <input
                      type="checkbox"
                      checked={selected.includes(option.value)}
                      disabled={!canAct || submitting}
                      onChange={() =>
                        setAnswers((current) => ({
                          ...current,
                          [question.id]: selected.includes(option.value)
                            ? selected.filter((value) => value !== option.value)
                            : [...selected, option.value],
                        }))
                      }
                    />
                    <span>{option.label}</span>
                  </label>
                );
              })}
            </span>
          ) : question.type === "single_select" && question.options ? (
            <select
              aria-labelledby={`native-question-${question.id}`}
              value={(answers[question.id] as string | undefined) ?? ""}
              disabled={!canAct || submitting}
              onChange={(event) =>
                setAnswers((current) => ({
                  ...current,
                  [question.id]: event.target.value,
                }))
              }
            >
              <option value="">{t("nativeRenderSelectAnswer")}</option>
              {question.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              aria-labelledby={`native-question-${question.id}`}
              type={question.type === "secret" ? "password" : "text"}
              autoComplete={
                question.type === "secret" ? "new-password" : undefined
              }
              value={(answers[question.id] as string | undefined) ?? ""}
              disabled={!canAct || submitting}
              placeholder={
                question.type === "secret"
                  ? t("nativeRenderSecretAnswer")
                  : t("nativeRenderTypeAnswer")
              }
              onChange={(event) =>
                setAnswers((current) => ({
                  ...current,
                  [question.id]: event.target.value,
                }))
              }
            />
          )}
        </div>
      ))}
      {!isOpen && (
        <p className="native-render-operation-closed">
          {operation.resolution?.summary ?? t("nativeRenderInteractionClosed")}
        </p>
      )}
      {isOpen && operation.allowedDecisions.length === 0 && (
        <p className="native-render-secondary">{t("nativeRenderNoActions")}</p>
      )}
      {submitFailed && (
        <p className="native-render-error" role="alert">
          {t("nativeRenderInteractionFailed")}
        </p>
      )}
      {operation.allowedDecisions.length > 0 && (
        <div className="native-render-actions">
          {operation.allowedDecisions.map((decision) => (
            <button
              type="button"
              key={decision.id}
              className={`native-render-action native-render-action-${decision.tone ?? "neutral"}`}
              disabled={
                !canAct ||
                submitting ||
                (decision.id === "submit" && !allRequiredAnswered)
              }
              onClick={() => selectDecision(decision)}
            >
              {confirmingDecisionId === decision.id
                ? t("nativeRenderConfirmDecision", {
                    decision: decisionLabel(decision.id, decision.label, t),
                  })
                : decisionLabel(decision.id, decision.label, t)}
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}

/**
 * Explicit registry. The mapped type intentionally fails compilation whenever
 * the shared native RenderItem union gains a kind without a renderer policy.
 */
export const nativeRenderers = {
  plan: (item, _context, t) => (
    <Card title={t("nativeRenderPlan")} status={item.status} t={t}>
      {item.steps && item.steps.length > 0 ? (
        <ol className="native-render-plan">
          {item.steps.map((step, index) => (
            <li key={`${index}:${step.text}`} data-status={step.status}>
              {step.text}
            </li>
          ))}
        </ol>
      ) : (
        <p className="native-render-prewrap">{item.text}</p>
      )}
    </Card>
  ),
  reasoning: (item, context, t) => (
    <Card title={t("nativeRenderReasoning")} status={item.status} t={t}>
      {item.summary.length > 0 ? (
        <div className="native-render-reasoning-summary">
          {item.summary.map((part, index) => (
            <p
              className="native-render-prewrap"
              key={`${index}:${part.slice(0, 24)}`}
            >
              {part}
            </p>
          ))}
        </div>
      ) : (
        <p className="native-render-secondary">{t("nativeRenderNoSummary")}</p>
      )}
      {context.showRawReasoning && item.visibility === "raw_allowed" ? (
        <details className="native-render-details">
          <summary>{t("nativeRenderRawReasoning")}</summary>
          <p className="native-render-prewrap">{item.content.join("\n\n")}</p>
        </details>
      ) : item.content.length > 0 || item.redaction?.reason ? (
        <p className="native-render-redacted">
          {t("nativeRenderRawReasoningHidden")}
        </p>
      ) : null}
    </Card>
  ),
  command: (item, _context, t) => (
    <Card title={t("nativeRenderCommand")} status={item.status} t={t}>
      <pre className="native-render-code">{item.command}</pre>
      <Metadata
        rows={[
          [t("nativeRenderCwd"), item.cwd],
          [t("nativeRenderProcess"), item.processId],
          [t("nativeRenderSource"), item.source],
          [t("nativeRenderExitCode"), item.exitCode?.toString()],
          [t("nativeRenderDuration"), duration(item.durationMs)],
        ]}
      />
      {item.output && (
        <details className="native-render-details">
          <summary>{t("nativeRenderOutput")}</summary>
          <pre className="native-render-output">{item.output}</pre>
        </details>
      )}
    </Card>
  ),
  file_change: (item, _context, t) => (
    <Card title={t("nativeRenderFileChange")} status={item.status} t={t}>
      <ul className="native-render-files">
        {item.changes.map((change) => (
          <li key={`${change.kind}:${change.path}`}>
            <span>{change.kind ?? t("nativeRenderChanged")}</span>
            <code>{change.path}</code>
            {change.diff && (
              <details className="native-render-details">
                <summary>{t("nativeRenderDiff")}</summary>
                <pre className="native-render-output">{change.diff}</pre>
              </details>
            )}
          </li>
        ))}
      </ul>
      <GeneratedArtifactList artifacts={item.artifacts} t={t} />
    </Card>
  ),
  mcp_tool: (item, _context, t) => (
    <Card title={t("nativeRenderMcpTool")} status={item.status} t={t}>
      <p className="native-render-tool-name">
        <code>{item.server}</code> / <code>{item.tool}</code>
      </p>
      <Metadata
        rows={[
          [t("nativeRenderApp"), item.appName],
          [t("nativeRenderAction"), item.actionName],
          [t("nativeRenderDuration"), duration(item.durationMs)],
        ]}
      />
      {item.resultSummary && (
        <p className="native-render-prewrap">{item.resultSummary}</p>
      )}
      {item.error && <p className="native-render-error">{item.error}</p>}
    </Card>
  ),
  dynamic_tool: (item, _context, t) => (
    <Card title={t("nativeRenderDynamicTool")} status={item.status} t={t}>
      <p className="native-render-tool-name">
        <code>
          {item.namespace ? `${item.namespace}.` : ""}
          {item.tool}
        </code>
      </p>
      {item.contentItems.map((content, index) => (
        <p className="native-render-prewrap" key={`${content.type}:${index}`}>
          {content.type === "image"
            ? t("nativeRenderImageOutput")
            : content.type === "audio"
              ? t("nativeRenderAudioOutput")
              : (content.text ?? t("nativeRenderUnsupportedContent"))}
        </p>
      ))}
    </Card>
  ),
  web_search: (item, _context, t) => (
    <Card title={t("nativeRenderWebSearch")} status={item.status} t={t}>
      <p className="native-render-prewrap">{item.query}</p>
      <Metadata
        rows={[
          [t("nativeRenderAction"), item.action],
          [t("nativeRenderResults"), item.resultCount?.toString()],
        ]}
      />
    </Card>
  ),
  image: (item, _context, t) => (
    <Card
      title={
        item.mode === "generation"
          ? t("nativeRenderImageGeneration")
          : t("nativeRenderImageView")
      }
      status={item.status}
      t={t}
    >
      {item.prompt && <p className="native-render-prewrap">{item.prompt}</p>}
      <GeneratedArtifactList artifacts={item.artifacts} t={t} />
      {!item.artifacts?.length && (
        <code className="native-render-path">
          {item.path ??
            (item.url?.startsWith("data:")
              ? t("nativeRenderImageOutput")
              : item.url) ??
            t("nativeRenderNoDetails")}
        </code>
      )}
    </Card>
  ),
  hook: (item, _context, t) => (
    <Card title={t("nativeRenderHook")} status={item.status} t={t}>
      {item.fragments.map((fragment, index) => (
        <p
          className="native-render-prewrap"
          key={`${fragment.hookRunId ?? index}:${index}`}
        >
          {fragment.text}
        </p>
      ))}
    </Card>
  ),
  review: (item, _context, t) => (
    <Card
      title={
        item.phase === "entered"
          ? t("nativeRenderReviewEntered")
          : t("nativeRenderReviewExited")
      }
      status={item.status}
      t={t}
    >
      <p className="native-render-prewrap">{item.review}</p>
    </Card>
  ),
  sleep: (item, _context, t) => (
    <Card title={t("nativeRenderSleep")} status={item.status} t={t}>
      <p>
        {t("nativeRenderSleepDuration", {
          duration: duration(item.durationMs) ?? "0ms",
        })}
      </p>
    </Card>
  ),
  subagent: (item, _context, t) => (
    <Card title={t("nativeRenderSubagent")} status={item.status} t={t}>
      <p>{item.activity}</p>
      {item.agentThreadIds.length > 0 && (
        <div className="native-render-chip-list">
          {item.agentThreadIds.map((threadId) => (
            <code key={threadId}>{threadId}</code>
          ))}
        </div>
      )}
      <Metadata
        rows={[
          [t("nativeRenderModel"), item.model],
          [t("nativeRenderEffort"), item.reasoningEffort],
        ]}
      />
    </Card>
  ),
  compaction: (item, _context, t) => (
    <Card title={t("nativeRenderCompaction")} status={item.status} t={t} />
  ),
  interaction: (item, context, t) => (
    <InteractionCard item={item} context={context} t={t} />
  ),
  warning: (item, _context, t) => {
    const retryStatus = item.retryStatus;
    const title = retryStatus
      ? retryStatus.state === "queued"
        ? t("nativeRenderRetryQueued")
        : t("nativeRenderRetrying")
      : (item.title ?? t("nativeRenderWarning"));
    const message = retryStatus
      ? t("nativeRenderRetryMessage", {
          attempt: String(retryStatus.nextAttempt),
          maxAttempts: String(retryStatus.maxAttempts),
          delay: duration(retryStatus.retryInMs) ?? "0ms",
        })
      : item.message;
    return (
      <Card
        title={title}
        status={item.status}
        className="native-render-warning"
        t={t}
      >
        <p className="native-render-prewrap">{message}</p>
        {item.diagnosticId && <code>{item.diagnosticId}</code>}
      </Card>
    );
  },
  unknown: (item, _context, t) => (
    <Card
      title={t("nativeRenderUnknown")}
      status={item.status}
      className="native-render-unknown"
      t={t}
    >
      <Metadata
        rows={[
          [t("nativeRenderType"), item.originalType],
          [t("nativeRenderItemId"), item.providerItemId],
        ]}
      />
      <p className="native-render-secondary">{item.safeSummary}</p>
    </Card>
  ),
} satisfies NativeRendererRegistry;

export function NativeRenderItemRenderer({
  item,
  showRawReasoning = false,
  onResolveInteraction,
}: Props) {
  const i18n = useOptionalI18n();
  const t = useMemo<Translator>(
    () => i18n?.t ?? (((key: string) => key) as Translator),
    [i18n],
  );
  const context = useMemo<NativeRenderContext>(
    () => ({ showRawReasoning, onResolveInteraction }),
    [onResolveInteraction, showRawReasoning],
  );
  const renderer = nativeRenderers[item.type] as NativeRenderer<NativeType>;
  return <>{renderer(item as SharedNativeRenderItem<Message>, context, t)}</>;
}
