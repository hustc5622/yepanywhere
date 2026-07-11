import { type ReactNode, useState } from "react";

const EVAL_START = "=== BENCHMARK_EVAL_RESULT_START ===";
const EVAL_END = "=== BENCHMARK_EVAL_RESULT_END ===";

export interface BenchmarkEvalBlock {
  data: Record<string, unknown>;
  rawJson: string;
  matchedBlockCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getRecord(
  value: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const nested = value?.[key];
  return isRecord(nested) ? nested : undefined;
}

function getArray(
  value: Record<string, unknown> | undefined,
  key: string,
): unknown[] {
  const nested = value?.[key];
  return Array.isArray(nested) ? nested : [];
}

function getString(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const nested = value?.[key];
  if (typeof nested === "string") return nested;
  if (typeof nested === "number" || typeof nested === "boolean") {
    return String(nested);
  }
  return undefined;
}

function getNumber(
  value: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const nested = value?.[key];
  return typeof nested === "number" && Number.isFinite(nested)
    ? nested
    : undefined;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function formatNumber(value: number | undefined): string | undefined {
  return value === undefined
    ? undefined
    : new Intl.NumberFormat("zh-CN").format(value);
}

/**
 * Parses marker-wrapped benchmark evaluation JSON from an assistant text block.
 * A model can emit an example schema before the final result, so the latest
 * complete, valid block is the authoritative one.
 */
export function parseBenchmarkEvalResultBlock(
  text: string | undefined,
): BenchmarkEvalBlock | null {
  if (!text) return null;

  const matches: Array<Omit<BenchmarkEvalBlock, "matchedBlockCount">> = [];
  let searchFrom = 0;

  while (searchFrom < text.length) {
    const startIndex = text.indexOf(EVAL_START, searchFrom);
    if (startIndex === -1) break;

    const jsonStart = startIndex + EVAL_START.length;
    const endIndex = text.indexOf(EVAL_END, jsonStart);
    if (endIndex === -1) break;

    const rawJson = text.slice(jsonStart, endIndex).trim();
    try {
      const data = JSON.parse(rawJson);
      if (isRecord(data)) {
        matches.push({ data, rawJson });
      }
    } catch {
      // Keep looking: an interrupted or example block must not hide a later result.
    }

    searchFrom = endIndex + EVAL_END.length;
  }

  const latest = matches.at(-1);
  return latest ? { ...latest, matchedBlockCount: matches.length } : null;
}

function Metric({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="benchmark-eval-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function TagList({
  items,
  className,
}: { items: string[]; className?: string }) {
  if (items.length === 0) return null;
  return (
    <div className={`benchmark-eval-tags${className ? ` ${className}` : ""}`}>
      {items.map((item) => (
        <span key={item}>{item}</span>
      ))}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="benchmark-eval-section">
      <h4>{title}</h4>
      {children}
    </section>
  );
}

function CapabilityCard({ item }: { item: Record<string, unknown> }) {
  const representativeCases = getArray(item, "representative_cases").filter(
    isRecord,
  );

  return (
    <article className="benchmark-eval-capability">
      <header>
        <span className="benchmark-eval-capability-name">
          {getString(item, "capability") ?? "未命名能力"}
        </span>
        {getString(item, "weight") && (
          <span className="benchmark-eval-weight">
            {getString(item, "weight")}
          </span>
        )}
      </header>
      {getString(item, "evidence") && <p>{getString(item, "evidence")}</p>}
      {representativeCases.length > 0 && (
        <div className="benchmark-eval-case-list">
          {representativeCases.map((caseItem, index) => {
            const caseId = getString(caseItem, "case_id") ?? "?";
            const benchmarkId = getString(caseItem, "benchmark_id");
            const reason = getString(caseItem, "reason");
            return (
              <div key={`${caseId}-${benchmarkId ?? index}`}>
                <span>case {caseId}</span>
                {benchmarkId && <code>{benchmarkId}</code>}
                {reason && <p>{reason}</p>}
              </div>
            );
          })}
        </div>
      )}
      {getString(item, "limitations") && (
        <details className="benchmark-eval-details">
          <summary>判断边界与不确定性</summary>
          <p>{getString(item, "limitations")}</p>
        </details>
      )}
    </article>
  );
}

function ScoreCard({
  name,
  score,
}: { name: string; score: Record<string, unknown> }) {
  const value = getNumber(score, "score");
  const boundedValue =
    value === undefined ? undefined : Math.max(0, Math.min(5, value));

  return (
    <div className="benchmark-eval-score">
      <div>
        <span>{name}</span>
        {boundedValue !== undefined && (
          <strong>
            {boundedValue}
            <small>/5</small>
          </strong>
        )}
      </div>
      {boundedValue !== undefined && (
        <div
          className="benchmark-eval-score-bar"
          aria-label={`${name}：${boundedValue}/5`}
        >
          <span style={{ width: `${(boundedValue / 5) * 100}%` }} />
        </div>
      )}
      {getString(score, "reason") && <p>{getString(score, "reason")}</p>}
    </div>
  );
}

export function BenchmarkEvalResult({ block }: { block: BenchmarkEvalBlock }) {
  const [isSummaryExpanded, setIsSummaryExpanded] = useState(false);
  const profile = getRecord(block.data, "benchmark_profile");
  const readScope = getRecord(block.data, "sample_read_scope");
  const dataQuality = getRecord(block.data, "data_quality_findings");
  const scorecard = getRecord(block.data, "scorecard");
  const capabilities = getArray(block.data, "capability_profile").filter(
    isRecord,
  );
  const capabilityGaps = getArray(block.data, "capability_gaps").filter(
    isRecord,
  );
  const priorityActions = getArray(block.data, "priority_actions").filter(
    isRecord,
  );
  const notableCases = getArray(block.data, "notable_cases").filter(isRecord);
  const scoreEntries = Object.entries(scorecard ?? {}).filter(
    (entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]),
  );
  const qualityMetrics = [
    ["控制字符", getNumber(dataQuality, "control_character_case_count")],
    ["物料引用", getNumber(dataQuality, "material_reference_case_count")],
    ["答案字段", getNumber(dataQuality, "answer_like_field_nonempty_count")],
    ["标题截断", getNumber(dataQuality, "title_truncation_case_count")],
    [
      "待增强题面",
      getNumber(dataQuality, "empty_improved_problem_statement_case_count"),
    ],
  ] as const;

  return (
    <div className="benchmark-eval-result">
      <header className="benchmark-eval-header">
        <div>
          <span className="benchmark-eval-kicker">Benchmark evaluation</span>
          <h3>
            {getString(profile, "benchmark_type") ?? "Benchmark 评估结果"}
          </h3>
        </div>
        <div className="benchmark-eval-statuses">
          {getString(profile, "taxonomy_status") && (
            <span>{getString(profile, "taxonomy_status")}</span>
          )}
          {getString(profile, "classification_confidence") && (
            <span>
              {getString(profile, "classification_confidence")} confidence
            </span>
          )}
        </div>
      </header>

      <div className="benchmark-eval-metrics">
        <Metric
          label="样本 case"
          value={formatNumber(getNumber(block.data, "case_count"))}
        />
        <Metric
          label="已读 case"
          value={formatNumber(
            getNumber(readScope, "estimated_read_case_count"),
          )}
        />
        <Metric
          label="机器审计"
          value={
            getString(readScope, "machine_audit_used") === "true"
              ? "已使用"
              : undefined
          }
        />
        <Metric label="能力项" value={String(capabilities.length)} />
        <Metric
          label="风险项"
          value={String(stringList(block.data.risks).length)}
        />
      </div>

      {getString(block.data, "summary") && (
        <div className="benchmark-eval-summary-wrap">
          <p
            className={`benchmark-eval-summary${
              isSummaryExpanded ? " benchmark-eval-summary-expanded" : ""
            }`}
          >
            {getString(block.data, "summary")}
          </p>
          <button
            type="button"
            className="benchmark-eval-summary-toggle"
            aria-expanded={isSummaryExpanded}
            onClick={() => setIsSummaryExpanded((expanded) => !expanded)}
          >
            {isSummaryExpanded ? "收起摘要" : "展开摘要"}
          </button>
        </div>
      )}

      <Section title="任务与分类">
        <dl className="benchmark-eval-facts">
          {getString(profile, "primary_task_form") && (
            <div>
              <dt>主要任务</dt>
              <dd>{getString(profile, "primary_task_form")}</dd>
            </div>
          )}
          {getString(profile, "case_format") && (
            <div>
              <dt>题面格式</dt>
              <dd>{getString(profile, "case_format")}</dd>
            </div>
          )}
          {getString(profile, "answer_oracle") && (
            <div>
              <dt>验收信号</dt>
              <dd>{getString(profile, "answer_oracle")}</dd>
            </div>
          )}
          {getString(profile, "taxonomy_notes") && (
            <div>
              <dt>分类维度</dt>
              <dd>{getString(profile, "taxonomy_notes")}</dd>
            </div>
          )}
        </dl>
        <TagList items={stringList(profile?.domain_scope)} />
      </Section>

      {capabilities.length > 0 && (
        <Section title="能力画像">
          <div className="benchmark-eval-capabilities">
            {capabilities.map((item, index) => (
              <CapabilityCard
                key={`${getString(item, "capability") ?? "capability"}-${index}`}
                item={item}
              />
            ))}
          </div>
        </Section>
      )}

      {(getString(readScope, "unread_scope_note") || dataQuality) && (
        <Section title="读取范围与数据质量">
          {getString(readScope, "unread_scope_note") && (
            <p className="benchmark-eval-callout">
              {getString(readScope, "unread_scope_note")}
            </p>
          )}
          {dataQuality && (
            <>
              <div className="benchmark-eval-quality-metrics">
                {qualityMetrics.map(([label, value]) => (
                  <Metric
                    key={label}
                    label={label}
                    value={formatNumber(value)}
                  />
                ))}
              </div>
              {getString(dataQuality, "notes") && (
                <p>{getString(dataQuality, "notes")}</p>
              )}
            </>
          )}
        </Section>
      )}

      {scorecard && (
        <Section title="评估评分">
          <div className="benchmark-eval-scores">
            {scoreEntries.map(([name, value]) => (
              <ScoreCard
                key={name}
                name={name.replaceAll("_", " ")}
                score={value}
              />
            ))}
          </div>
        </Section>
      )}

      {(stringList(block.data.strengths).length > 0 ||
        stringList(block.data.risks).length > 0 ||
        stringList(block.data.recommendations).length > 0) && (
        <Section title="结论与建议">
          <div className="benchmark-eval-columns">
            <div>
              <h5>优势</h5>
              <ul>
                {stringList(block.data.strengths).map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
            <div>
              <h5>风险</h5>
              <ul>
                {stringList(block.data.risks).map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
            <div>
              <h5>建议</h5>
              <ul>
                {stringList(block.data.recommendations).map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          </div>
        </Section>
      )}

      {(capabilityGaps.length > 0 ||
        priorityActions.length > 0 ||
        notableCases.length > 0) && (
        <Section title="后续行动">
          {priorityActions.length > 0 && (
            <div className="benchmark-eval-actions">
              {priorityActions.map((item, index) => (
                <div
                  key={`${getString(item, "priority") ?? "action"}-${index}`}
                >
                  <span>{getString(item, "priority") ?? "待办"}</span>
                  <strong>{getString(item, "action")}</strong>
                  {getString(item, "reason") && (
                    <p>{getString(item, "reason")}</p>
                  )}
                </div>
              ))}
            </div>
          )}
          {capabilityGaps.length > 0 && (
            <div className="benchmark-eval-gaps">
              <h5>能力缺口</h5>
              {capabilityGaps.map((item, index) => (
                <p key={`${getString(item, "capability") ?? "gap"}-${index}`}>
                  <strong>{getString(item, "capability")}</strong>
                  {getString(item, "reason") &&
                    `：${getString(item, "reason")}`}
                </p>
              ))}
            </div>
          )}
          {notableCases.length > 0 && (
            <div className="benchmark-eval-notable-cases">
              <h5>代表 case</h5>
              {notableCases.map((item, index) => (
                <p key={`${getString(item, "case_id") ?? "case"}-${index}`}>
                  <span>case {getString(item, "case_id") ?? "?"}</span>
                  {getString(item, "benchmark_id") && (
                    <code>{getString(item, "benchmark_id")}</code>
                  )}
                  {getString(item, "note") && `：${getString(item, "note")}`}
                </p>
              ))}
            </div>
          )}
        </Section>
      )}

      {getString(block.data, "summary_md") && (
        <details className="benchmark-eval-details">
          <summary>查看完整 Markdown 报告</summary>
          <pre>{getString(block.data, "summary_md")}</pre>
        </details>
      )}
      <details className="benchmark-eval-details">
        <summary>查看原始 JSON</summary>
        <pre>{block.rawJson}</pre>
      </details>
    </div>
  );
}
