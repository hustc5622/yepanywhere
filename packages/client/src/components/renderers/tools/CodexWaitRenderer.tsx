import { getCodexExecResultOverview } from "../../../lib/codexExec";
import type { ToolRenderer } from "./types";

interface CodexWaitInput {
  cell_id?: string | number;
  cellId?: string | number;
  yield_time_ms?: number;
  max_tokens?: number;
  terminate?: boolean;
  poll_count?: number;
  total_wall_time_seconds?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseInput(input: unknown): CodexWaitInput {
  return isRecord(input) ? (input as CodexWaitInput) : {};
}

function getCellId(input: CodexWaitInput): string {
  const value = input.cell_id ?? input.cellId;
  return value === undefined ? "unknown" : String(value);
}

function formatDuration(seconds: number): string {
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
}

function getRequestedDuration(input: CodexWaitInput): string | null {
  if (typeof input.yield_time_ms !== "number") return null;
  return formatDuration(input.yield_time_ms / 1000);
}

function getPollLabel(input: CodexWaitInput): string | null {
  const count = input.poll_count;
  if (typeof count !== "number" || count <= 1) return null;
  return `${count} polls`;
}

function getElapsedLabel(input: CodexWaitInput): string | null {
  const seconds = input.total_wall_time_seconds;
  if (typeof seconds !== "number") return null;
  return formatDuration(seconds);
}

function getEffect(
  result: unknown,
  isError: boolean,
  input: CodexWaitInput,
): { label: string; className: string } {
  const overview = getCodexExecResultOverview(result, isError);
  const cell = getCellId(input);
  if (overview.status === "running") {
    return {
      label: overview.output
        ? `Cell ${cell} is still running and returned new output.`
        : `Cell ${cell} is still running; no new output arrived.`,
      className: "status-running",
    };
  }
  if (overview.status === "terminated") {
    return {
      label: `Cell ${cell} was terminated.`,
      className: "status-terminated",
    };
  }
  if (overview.status === "failed" || isError) {
    return {
      label: `Waiting on Cell ${cell} failed.`,
      className: "status-error",
    };
  }
  if (overview.output) {
    return {
      label: `Cell ${cell} returned ${overview.outputLineCount} output ${overview.outputLineCount === 1 ? "line" : "lines"}.`,
      className: "status-completed",
    };
  }
  return {
    label: `Cell ${cell} finished without output.`,
    className: "status-completed",
  };
}

function WaitRequest({ input }: { input: CodexWaitInput }) {
  const cell = getCellId(input);
  const requestedDuration = getRequestedDuration(input);
  const pollLabel = getPollLabel(input);
  const elapsedLabel = getElapsedLabel(input);
  const action = input.terminate
    ? `Terminate Cell ${cell}`
    : `Wait for Cell ${cell}${requestedDuration ? ` for up to ${requestedDuration}` : ""}`;

  return (
    <div className="codex-wait-request">
      <span className="codex-exec-section-label">Request</span>
      <strong>{action}</strong>
      {(pollLabel || elapsedLabel) && (
        <span className="codex-exec-meta">
          {[pollLabel, elapsedLabel && `${elapsedLabel} elapsed`]
            .filter(Boolean)
            .join(" · ")}
        </span>
      )}
    </div>
  );
}

export const codexWaitRenderer: ToolRenderer = {
  tool: "CodexWait",
  displayName: "wait",

  renderToolUse(input) {
    return <WaitRequest input={parseInput(input)} />;
  },

  renderToolResult(result, isError, _context, rawInput) {
    const input = parseInput(rawInput);
    const overview = getCodexExecResultOverview(result, isError);
    const effect = getEffect(result, isError, input);

    return (
      <div className="codex-wait-details">
        <WaitRequest input={input} />
        <div className={`codex-web-effect ${effect.className}`}>
          <strong>Effect</strong>
          <span>{effect.label}</span>
        </div>
        {overview.output && (
          <pre
            className={`code-block codex-wait-output ${isError ? "code-block-error" : ""}`}
          >
            <code>{overview.output}</code>
          </pre>
        )}
      </div>
    );
  },

  getUseSummary(rawInput) {
    const input = parseInput(rawInput);
    const cell = getCellId(input);
    const duration = getRequestedDuration(input);
    return input.terminate
      ? `terminate Cell ${cell}`
      : `Cell ${cell}${duration ? ` · up to ${duration}` : ""}`;
  },

  getResultSummary(result, isError, rawInput) {
    const input = parseInput(rawInput);
    const overview = getCodexExecResultOverview(result, isError);
    const cell = getCellId(input);
    const pollLabel = getPollLabel(input);
    const elapsedLabel = getElapsedLabel(input);
    const details = [pollLabel, elapsedLabel].filter(Boolean).join(" · ");
    const suffix = details ? ` · ${details}` : "";

    if (overview.status === "running") {
      return `Cell ${cell} still running${suffix}`;
    }
    if (overview.status === "terminated") {
      return `Cell ${cell} terminated${suffix}`;
    }
    if (overview.status === "failed" || isError) {
      return `Cell ${cell} failed${suffix}`;
    }
    if (overview.outputLineCount > 0) {
      return `Cell ${cell} · ${overview.outputLineCount} ${overview.outputLineCount === 1 ? "line" : "lines"}${suffix}`;
    }
    return `Cell ${cell} finished${suffix}`;
  },
};
