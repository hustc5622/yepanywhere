import { useState } from "react";
import {
  type CodexExecImageOutput,
  type CodexExecOperation,
  getCodexExecOverview,
  getCodexExecResultOverview,
  getCodexExecSummary,
  shouldParseCodexExecNestedResults,
} from "../../../lib/codexExec";
import {
  type CodexWebOperation,
  getCodexWebResultOverview,
  getCodexWebRunOverview,
} from "../../../lib/codexWebRun";
import { Modal } from "../../ui/Modal";
import type { ToolRenderer } from "./types";

const MAX_OUTPUT_LINES = 30;
const MAX_OUTPUT_CHARS = 6000;

function pluralize(count: number, singular: string): string {
  const noun =
    count === 1
      ? singular
      : singular.endsWith("y")
        ? `${singular.slice(0, -1)}ies`
        : `${singular}s`;
  return `${count} ${noun}`;
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

function formatCharacterCount(count: number): string {
  if (count < 1000) return `${count} chars`;
  return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}K chars`;
}

function WebOperationList({ operations }: { operations: CodexWebOperation[] }) {
  return (
    <section className="codex-web-section">
      <div className="codex-exec-section-label">Request</div>
      <div className="codex-web-request-list">
        {operations.map((operation) => (
          <div className="codex-web-request" key={operation.kind}>
            <span className="codex-web-request-kind">{operation.label}</span>
            <ol>
              {operation.items.map((item, index) => (
                <li key={`${operation.kind}-${index}`}>{item}</li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </section>
  );
}

function RawWebResponse({ output }: { output: string }) {
  if (!output) return null;
  return (
    <details className="codex-exec-raw-details codex-web-raw-details">
      <summary>Raw web response</summary>
      <pre className="code-block codex-exec-raw-script">
        <code>{output}</code>
      </pre>
    </details>
  );
}

function WebResultDetails({
  input,
  result,
  isError,
}: {
  input: unknown;
  result: unknown;
  isError: boolean;
}) {
  const request = getCodexWebRunOverview(input);
  const response = getCodexWebResultOverview(result, isError);
  const { exec } = response;
  const status = getStatusLabel(exec.status);
  const meta = [
    exec.wallTimeSeconds !== undefined ? `${exec.wallTimeSeconds}s` : null,
    request?.queryCount ? pluralize(request.queryCount, "query") : null,
    response.sources.length > 0
      ? pluralize(response.sources.length, "source")
      : null,
    response.outputChars > 0
      ? formatCharacterCount(response.outputChars)
      : null,
  ].filter((item): item is string => !!item);

  return (
    <div className="codex-exec-details codex-web-details">
      <div className="codex-exec-meta-row">
        <span className={`badge ${status.className}`}>{status.label}</span>
        {exec.cellId && (
          <span className="badge badge-info">Cell {exec.cellId}</span>
        )}
        {request?.responseLength && (
          <span className="badge badge-muted">
            {request.responseLength} response
          </span>
        )}
        {meta.length > 0 && (
          <span className="codex-exec-meta">{meta.join(" · ")}</span>
        )}
      </div>

      {request && <WebOperationList operations={request.operations} />}

      {exec.status === "running" ? (
        <div className="codex-web-effect status-running">
          <strong>Effect</strong>
          <span>
            {`The request is still running${exec.cellId ? ` in Cell ${exec.cellId}` : ""}; no results have arrived yet.`}
          </span>
        </div>
      ) : exec.status === "terminated" && !response.output ? (
        <div className="codex-web-effect status-terminated">
          <strong>Effect</strong>
          <span>The web request was terminated before returning results.</span>
        </div>
      ) : response.sources.length > 0 ? (
        <section className="codex-web-section">
          <div className="codex-exec-section-label">Sources returned</div>
          <ol className="codex-web-source-list">
            {response.sources.slice(0, 8).map((source) => (
              <li key={source.url}>
                <a href={source.url} target="_blank" rel="noreferrer">
                  <span>{source.title}</span>
                  <small>{source.url}</small>
                </a>
              </li>
            ))}
          </ol>
          {response.sources.length > 8 && (
            <div className="codex-exec-unsupported">
              {response.sources.length - 8} more sources in the raw response
            </div>
          )}
        </section>
      ) : response.output ? (
        <ExecOutput
          output={response.output}
          isError={exec.status === "failed"}
          lineCount={response.outputLineCount}
        />
      ) : (
        <div className="codex-web-effect">
          <strong>Effect</strong>
          <span>No result content was returned.</span>
        </div>
      )}

      <RawWebResponse output={response.output} />
      {request && (
        <RawScriptDetails script={getCodexExecOverview(input).script} />
      )}
    </div>
  );
}

function getWebResultSummary(result: unknown, isError: boolean): string {
  const response = getCodexWebResultOverview(result, isError);
  const { exec } = response;
  if (exec.status === "running") {
    return exec.cellId ? `waiting in Cell ${exec.cellId}` : "still running";
  }
  if (exec.status === "terminated") return "terminated without results";
  if (exec.status === "failed") return "failed";

  const details = [
    response.sources.length > 0
      ? pluralize(response.sources.length, "source")
      : response.outputLineCount > 0
        ? pluralize(response.outputLineCount, "line")
        : "no content",
    response.outputChars > 0
      ? formatCharacterCount(response.outputChars)
      : null,
    exec.wallTimeSeconds !== undefined ? `${exec.wallTimeSeconds}s` : null,
  ].filter((item): item is string => !!item);
  return details.join(" · ");
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

  getDisplayName(input) {
    return getCodexWebRunOverview(input) ? "web" : "exec";
  },

  renderToolUse(input) {
    const web = getCodexWebRunOverview(input);
    if (web) {
      return (
        <div className="codex-exec-details codex-web-details">
          <WebOperationList operations={web.operations} />
          <RawScriptDetails script={getCodexExecOverview(input).script} />
        </div>
      );
    }
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
    if (getCodexWebRunOverview(input)) {
      return (
        <WebResultDetails input={input} result={result} isError={isError} />
      );
    }
    return (
      <ExecResultDetails input={input} result={result} isError={isError} />
    );
  },

  getUseSummary(input) {
    const web = getCodexWebRunOverview(input);
    if (web) return web.summary;
    return getCodexExecSummary(input);
  },

  getResultSummary(result, isError, input) {
    if (getCodexWebRunOverview(input)) {
      return getWebResultSummary(result, isError);
    }
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
