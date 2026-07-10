import { useState } from "react";
import {
  type CodexExecImageOutput,
  type CodexExecOperation,
  getCodexExecOverview,
  getCodexExecResultOverview,
  getCodexExecSummary,
  shouldParseCodexExecNestedResults,
} from "../../../lib/codexExec";
import { Modal } from "../../ui/Modal";
import type { ToolRenderer } from "./types";

const MAX_OUTPUT_LINES = 30;
const MAX_OUTPUT_CHARS = 6000;

function pluralize(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function truncateOutput(text: string): {
  text: string;
  truncated: boolean;
} {
  const lines = text.split("\n");
  const lineLimited = lines.slice(0, MAX_OUTPUT_LINES).join("\n");
  const truncatedByLines = lines.length > MAX_OUTPUT_LINES;

  if (lineLimited.length > MAX_OUTPUT_CHARS) {
    return {
      text: lineLimited.slice(0, MAX_OUTPUT_CHARS).trimEnd(),
      truncated: true,
    };
  }

  return { text: lineLimited, truncated: truncatedByLines };
}

function OperationList({
  operations,
  script,
}: {
  operations: CodexExecOperation[];
  script: string;
}) {
  if (operations.length === 0) {
    return (
      <section className="codex-exec-section">
        <div className="codex-exec-section-label">Script</div>
        <pre className="code-block codex-exec-script-primary">
          <code>{script || "(script unavailable)"}</code>
        </pre>
      </section>
    );
  }

  const singleCommand =
    operations.length === 1 && operations[0]?.name === "exec_command";

  return (
    <section className="codex-exec-section">
      <div className="codex-exec-section-label">
        {singleCommand ? "Command" : "Operations"}
      </div>
      <ol className="codex-exec-operation-list">
        {operations.map((operation, index) => (
          <li
            className="codex-exec-operation"
            key={`${operation.name}-${index}`}
          >
            {operations.length > 1 && (
              <span className="codex-exec-operation-index">{index + 1}</span>
            )}
            {operation.command ? (
              <code className="codex-exec-command">{operation.command}</code>
            ) : (
              <>
                <span className="codex-exec-operation-name">tool</span>
                <code className="codex-exec-command">{operation.name}</code>
              </>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

function RawScriptDetails({ script }: { script: string }) {
  if (!script) return null;

  return (
    <details className="codex-exec-raw-details">
      <summary>Raw exec script</summary>
      <pre className="code-block codex-exec-raw-script">
        <code>{script}</code>
      </pre>
    </details>
  );
}

function ExecImages({ images }: { images: CodexExecImageOutput[] }) {
  const [selectedImage, setSelectedImage] = useState<number | null>(null);
  if (images.length === 0) return null;

  return (
    <section className="codex-exec-section">
      <div className="codex-exec-section-label">Images</div>
      <div className="codex-exec-image-list">
        {images.map((image, index) => (
          <button
            type="button"
            className="file-link-button"
            key={image.imageUrl}
            onClick={() => setSelectedImage(index)}
          >
            {`Image output ${index + 1}`}
            <span className="file-line-count-inline">(image)</span>
          </button>
        ))}
      </div>
      {selectedImage !== null && images[selectedImage] && (
        <Modal
          title={`Exec image ${selectedImage + 1}`}
          onClose={() => setSelectedImage(null)}
        >
          <div className="codex-exec-image-modal">
            <img
              src={images[selectedImage].imageUrl}
              alt={`Exec output ${selectedImage + 1}`}
            />
          </div>
        </Modal>
      )}
    </section>
  );
}

function ExecOutput({
  output,
  isError,
  lineCount,
}: {
  output: string;
  isError: boolean;
  lineCount: number;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!output) {
    return <div className="codex-exec-empty">No text output</div>;
  }

  const preview = truncateOutput(output);
  const displayOutput = expanded ? output : preview.text;

  return (
    <section className="codex-exec-section">
      <div className="codex-exec-section-label">Output</div>
      <pre
        className={`code-block codex-exec-output ${isError ? "code-block-error" : ""}`}
      >
        <code>{displayOutput}</code>
      </pre>
      {preview.truncated && (
        <button
          type="button"
          className="expand-button codex-exec-output-toggle"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : `Show all ${lineCount} lines`}
        </button>
      )}
    </section>
  );
}

function getStatusLabel(
  status: ReturnType<typeof getCodexExecResultOverview>["status"],
): {
  label: string;
  className: string;
} {
  switch (status) {
    case "completed":
      return { label: "Completed", className: "badge-success" };
    case "failed":
      return { label: "Failed", className: "badge-error" };
    case "running":
      return { label: "Running", className: "badge-info" };
    case "terminated":
      return { label: "Terminated", className: "badge-warning" };
    default:
      return { label: "Result", className: "badge-muted" };
  }
}

function ExecResultDetails({
  input,
  result,
  isError,
}: {
  input: unknown;
  result: unknown;
  isError: boolean;
}) {
  const exec = getCodexExecOverview(input);
  const resultOverview = getCodexExecResultOverview(result, isError, {
    parseNestedResults: shouldParseCodexExecNestedResults(input),
  });
  const status = getStatusLabel(resultOverview.status);
  const nestedExitCodes = resultOverview.segments
    .map((segment) => segment.exitCode)
    .filter((exitCode): exitCode is number => exitCode !== undefined);
  const hasNestedError = resultOverview.segments.some(
    (segment) => segment.isError,
  );
  const metadata = [
    resultOverview.wallTimeSeconds !== undefined
      ? `${resultOverview.wallTimeSeconds}s`
      : null,
    exec.operationCount > 0
      ? pluralize(exec.operationCount, "operation")
      : null,
    resultOverview.outputLineCount > 0
      ? pluralize(resultOverview.outputLineCount, "line")
      : null,
    resultOverview.images.length > 0
      ? pluralize(resultOverview.images.length, "image")
      : null,
  ].filter((item): item is string => !!item);

  return (
    <div className="codex-exec-details">
      <div className="codex-exec-meta-row">
        <span className={`badge ${status.className}`}>{status.label}</span>
        {nestedExitCodes.length > 0 && (
          <span
            className={`badge ${hasNestedError ? "badge-error" : "badge-muted"}`}
          >
            {nestedExitCodes.length === 1
              ? `Exit ${nestedExitCodes[0]}`
              : `Exit codes ${nestedExitCodes.join(", ")}`}
          </span>
        )}
        {resultOverview.cellId && (
          <span className="badge badge-info">Cell {resultOverview.cellId}</span>
        )}
        {metadata.length > 0 && (
          <span className="codex-exec-meta">{metadata.join(" · ")}</span>
        )}
      </div>

      <OperationList operations={exec.operations} script={exec.script} />

      {(resultOverview.output || resultOverview.images.length === 0) && (
        <ExecOutput
          output={resultOverview.output}
          isError={resultOverview.status === "failed" || hasNestedError}
          lineCount={resultOverview.outputLineCount}
        />
      )}
      <ExecImages images={resultOverview.images} />

      {resultOverview.unknownItemCount > 0 && (
        <div className="codex-exec-unsupported">
          {pluralize(resultOverview.unknownItemCount, "output item")} hidden
        </div>
      )}

      {exec.operations.length > 0 && <RawScriptDetails script={exec.script} />}
    </div>
  );
}

export const codexExecRenderer: ToolRenderer = {
  tool: "CodexExec",
  displayName: "exec",

  renderToolUse(input) {
    const exec = getCodexExecOverview(input);
    return (
      <div className="codex-exec-details">
        <OperationList operations={exec.operations} script={exec.script} />
        {exec.operations.length > 0 && (
          <RawScriptDetails script={exec.script} />
        )}
      </div>
    );
  },

  renderToolResult(result, isError, _context, input) {
    return (
      <ExecResultDetails input={input} result={result} isError={isError} />
    );
  },

  getUseSummary(input) {
    return getCodexExecSummary(input);
  },

  getResultSummary(result, isError, input) {
    const overview = getCodexExecResultOverview(result, isError, {
      parseNestedResults: shouldParseCodexExecNestedResults(input),
    });
    if (overview.status === "failed") return "failed";
    if (overview.wallTimeSeconds !== undefined) {
      return `${overview.wallTimeSeconds}s`;
    }
    return overview.outputLineCount > 0
      ? pluralize(overview.outputLineCount, "line")
      : "done";
  },
};
