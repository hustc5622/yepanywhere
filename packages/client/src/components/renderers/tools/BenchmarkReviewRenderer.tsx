const REVIEW_START = "=== BENCHMARK_RUN_REVIEW_RESULT_START ===";
const REVIEW_END = "=== BENCHMARK_RUN_REVIEW_RESULT_END ===";

export interface BenchmarkReviewBlock {
  data: Record<string, unknown>;
  rawJson: string;
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

function formatPercent(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  return `${(value * 100).toFixed(1)}%`;
}

function formatInteger(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  return new Intl.NumberFormat("en-US").format(value);
}

function truncate(text: string | undefined, maxLength: number): string {
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) =>
      typeof item === "string" || typeof item === "number"
        ? String(item)
        : undefined,
    )
    .filter((item): item is string => !!item);
}

export function parseBenchmarkReviewBlock(
  text: string | undefined,
): BenchmarkReviewBlock | null {
  if (!text) return null;

  const startIndex = text.indexOf(REVIEW_START);
  if (startIndex === -1) return null;

  const jsonStart = startIndex + REVIEW_START.length;
  const endIndex = text.indexOf(REVIEW_END, jsonStart);
  if (endIndex === -1) return null;

  const rawJson = text.slice(jsonStart, endIndex).trim();
  if (!rawJson) return null;

  try {
    const data = JSON.parse(rawJson);
    if (!isRecord(data)) return null;
    return { data, rawJson };
  } catch {
    return null;
  }
}

function Metric({
  label,
  value,
}: {
  label: string;
  value: string | undefined;
}) {
  if (!value) return null;
  return (
    <div className="benchmark-review-metric">
      <span className="benchmark-review-metric-label">{label}</span>
      <span className="benchmark-review-metric-value">{value}</span>
    </div>
  );
}

function PatternCard({ pattern }: { pattern: Record<string, unknown> }) {
  const patternId = getString(pattern, "pattern_id");
  const affectedCases = stringList(pattern.affected_cases);
  const sampledCases = stringList(pattern.sampled_cases);

  return (
    <div className="benchmark-review-pattern">
      <div className="benchmark-review-pattern-header">
        {patternId && (
          <span className="benchmark-review-pattern-id">{patternId}</span>
        )}
        <span className="benchmark-review-pattern-title">
          {getString(pattern, "pattern") ?? "Failure pattern"}
        </span>
      </div>
      <div className="benchmark-review-tags">
        <span>{getNumber(pattern, "case_count") ?? "-"} cases</span>
        <span>{getNumber(pattern, "run_count") ?? "-"} attempts</span>
        {getString(pattern, "evidence_strength") && (
          <span>{getString(pattern, "evidence_strength")} evidence</span>
        )}
      </div>
      {getString(pattern, "description") && (
        <p>{truncate(getString(pattern, "description"), 420)}</p>
      )}
      {affectedCases.length > 0 && (
        <div className="benchmark-review-case-tags">
          <span className="benchmark-review-case-tags-label">Affected</span>
          {affectedCases.map((caseKey) => (
            <span key={caseKey}>case {caseKey}</span>
          ))}
        </div>
      )}
      {sampledCases.length > 0 && (
        <div className="benchmark-review-case-tags">
          <span className="benchmark-review-case-tags-label">Sampled</span>
          {sampledCases.map((caseKey) => (
            <span key={caseKey}>case {caseKey}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function CaseRow({ item }: { item: Record<string, unknown> }) {
  const patternIds = stringList(item.pattern_ids);
  const failedRuns = getNumber(item, "failed_runs");
  const runs = getNumber(item, "runs");
  const failureRate =
    failedRuns !== undefined && runs ? `${failedRuns}/${runs}` : undefined;

  return (
    <div className="benchmark-review-case-row">
      <div className="benchmark-review-case-main">
        <span className="benchmark-review-case-key">
          case {getString(item, "case_key") ?? "?"}
        </span>
        {failureRate && (
          <span className="benchmark-review-case-rate">{failureRate}</span>
        )}
        {getString(item, "failure_class") && (
          <span className="benchmark-review-case-class">
            {getString(item, "failure_class")}
          </span>
        )}
      </div>
      {patternIds.length > 0 && (
        <div className="benchmark-review-tags benchmark-review-case-patterns">
          {patternIds.map((patternId) => (
            <span key={patternId}>{patternId}</span>
          ))}
        </div>
      )}
      {getString(item, "note") && (
        <div className="benchmark-review-case-note">
          {truncate(getString(item, "note"), 220)}
        </div>
      )}
    </div>
  );
}

function EvidenceGap({ item }: { item: Record<string, unknown> }) {
  return (
    <li>
      <span className="benchmark-review-gap-case">
        case {getString(item, "case_key") ?? "?"}
      </span>
      {getString(item, "reason") && <span>{getString(item, "reason")}</span>}
    </li>
  );
}

export function BenchmarkReviewPreview({
  block,
}: {
  block: BenchmarkReviewBlock;
}) {
  const run = getRecord(block.data, "run");
  const overview = getRecord(block.data, "failure_overview");
  const patterns = getArray(block.data, "failure_patterns");

  return (
    <div className="benchmark-review-preview">
      <span className="benchmark-review-preview-title">Benchmark review</span>
      <span>{getString(run, "task_id")}</span>
      <span>{getString(run, "benchmark")}</span>
      {formatPercent(getNumber(run, "reward")) && (
        <span>{formatPercent(getNumber(run, "reward"))} reward</span>
      )}
      <span>
        {formatInteger(getNumber(run, "failure_count")) ?? "-"}/
        {formatInteger(getNumber(run, "run_count")) ?? "-"} failed
      </span>
      <span>{patterns.length} patterns</span>
      {getNumber(overview, "failed_case_count") !== undefined && (
        <span>{getNumber(overview, "failed_case_count")} failed cases</span>
      )}
    </div>
  );
}

export function BenchmarkReviewResult({
  block,
}: {
  block: BenchmarkReviewBlock;
}) {
  const run = getRecord(block.data, "run");
  const readScope = getRecord(block.data, "read_scope");
  const profile = getRecord(block.data, "benchmark_profile");
  const overview = getRecord(block.data, "failure_overview");
  const patterns = getArray(block.data, "failure_patterns").filter(isRecord);
  const caseInventory = getRecord(block.data, "case_inventory");
  const includedCases = getArray(caseInventory, "included_cases").filter(
    isRecord,
  );
  const evidenceGaps = getArray(block.data, "evidence_gaps").filter(isRecord);

  return (
    <div className="benchmark-review">
      <div className="benchmark-review-header">
        <div>
          <div className="benchmark-review-kicker">Benchmark review result</div>
          <div className="benchmark-review-title">
            {getString(run, "task_id") ?? "Benchmark run"}
            {getString(run, "benchmark") && (
              <span> / {getString(run, "benchmark")}</span>
            )}
          </div>
        </div>
        {getNumber(readScope, "benchmark_run_id") !== undefined && (
          <span className="benchmark-review-run-id">
            run #{getNumber(readScope, "benchmark_run_id")}
          </span>
        )}
      </div>

      <div className="benchmark-review-metrics">
        <Metric label="Model" value={getString(run, "model_under_test")} />
        <Metric
          label="Reward"
          value={formatPercent(getNumber(run, "reward"))}
        />
        <Metric
          label="Attempts"
          value={formatInteger(getNumber(run, "run_count"))}
        />
        <Metric
          label="Success"
          value={formatInteger(getNumber(run, "success_count"))}
        />
        <Metric
          label="Failures"
          value={formatInteger(getNumber(run, "failure_count"))}
        />
        <Metric
          label="Failed cases"
          value={
            getNumber(overview, "failed_case_count") !== undefined
              ? String(getNumber(overview, "failed_case_count"))
              : undefined
          }
        />
      </div>

      <div className="benchmark-review-flow">
        <div>
          <strong>{formatInteger(getNumber(run, "run_count")) ?? "-"}</strong>
          <span>attempts</span>
        </div>
        <div>
          <strong>
            {formatInteger(getNumber(run, "failure_count")) ?? "-"}
          </strong>
          <span>
            {formatPercent(getNumber(overview, "failure_rate_by_run"))}
          </span>
        </div>
        <div>
          <strong>{getNumber(overview, "failed_case_count") ?? "-"}</strong>
          <span>failed cases</span>
        </div>
        <div>
          <strong>{patterns.length}</strong>
          <span>patterns</span>
        </div>
      </div>

      {getString(profile, "primary_task_form") && (
        <section className="benchmark-review-section">
          <h4>Benchmark profile</h4>
          <p>{getString(profile, "primary_task_form")}</p>
        </section>
      )}

      {patterns.length > 0 && (
        <section className="benchmark-review-section">
          <h4>Failure patterns</h4>
          <div className="benchmark-review-patterns">
            {patterns.map((pattern, index) => (
              <PatternCard
                key={getString(pattern, "pattern_id") ?? index}
                pattern={pattern}
              />
            ))}
          </div>
        </section>
      )}

      {includedCases.length > 0 && (
        <section className="benchmark-review-section">
          <h4>Cases and pattern links</h4>
          <div className="benchmark-review-cases">
            {includedCases.map((item, index) => (
              <CaseRow key={getString(item, "case_key") ?? index} item={item} />
            ))}
          </div>
        </section>
      )}

      {evidenceGaps.length > 0 && (
        <section className="benchmark-review-section">
          <h4>Evidence gaps</h4>
          <ul className="benchmark-review-gaps">
            {evidenceGaps.map((item, index) => (
              <EvidenceGap
                key={`${getString(item, "case_key") ?? "gap"}-${index}`}
                item={item}
              />
            ))}
          </ul>
        </section>
      )}

      <details className="benchmark-review-raw">
        <summary>Raw JSON</summary>
        <pre className="code-block">
          <code>{block.rawJson}</code>
        </pre>
      </details>
    </div>
  );
}
