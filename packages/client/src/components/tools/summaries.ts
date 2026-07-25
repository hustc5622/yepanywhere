import { getDisplayBashCommandFromInput } from "../../lib/bashCommand";
import { getCodexWebRunOverview } from "../../lib/codexWebRun";
import type { ToolResultData } from "../../types/renderItems";
import { toolRegistry } from "../renderers/tools";

/**
 * Safely call a renderer method, falling back to undefined on error.
 * This handles cases where tool input/result doesn't match expected schema
 * (e.g., Gemini using different field names than Claude SDK).
 */
function safeCall<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/**
 * Get a summary string for a tool call based on its status.
 *
 * Uses the tool registry's getUseSummary and getResultSummary methods when available,
 * falling back to sensible defaults.
 */
export function getToolSummary(
  toolName: string,
  input: unknown,
  result: ToolResultData | undefined,
  status: "pending" | "complete" | "error" | "aborted",
  options?: { provider?: string },
): string {
  const renderer = toolRegistry.get(toolName);
  const provider = options?.provider;
  const opencodeInputSummary =
    provider === "opencode" ? getOpenCodeInputSummary(toolName, input) : "";

  if (status === "pending" || status === "aborted") {
    if (opencodeInputSummary) {
      return opencodeInputSummary;
    }
    // Show input summary while pending or aborted (no result available)
    if (renderer.getUseSummary) {
      const summary = safeCall(() => renderer.getUseSummary?.(input));
      if (summary !== undefined) return summary;
    }
    return getDefaultInputSummary(toolName, input);
  }

  // Show result summary when complete or error
  // For some tools, combine input + result for a complete summary
  let inputSummary: string;
  if (opencodeInputSummary) {
    inputSummary = opencodeInputSummary;
  } else if (renderer.getUseSummary) {
    const summary = safeCall(() => renderer.getUseSummary?.(input));
    inputSummary = summary ?? getDefaultInputSummary(toolName, input);
  } else {
    inputSummary = getDefaultInputSummary(toolName, input);
  }

  let resultSummary: string;
  if (renderer.getResultSummary) {
    const summary = safeCall(() =>
      renderer.getResultSummary?.(
        result?.structured ?? result?.content,
        result?.isError ?? false,
        input,
      ),
    );
    resultSummary =
      summary ?? getDefaultResultSummary(toolName, result, status);
  } else {
    resultSummary = getDefaultResultSummary(toolName, result, status);
  }

  // Combine input and result for tools where the input context is valuable
  if (provider === "opencode" && inputSummary && inputSummary !== "...") {
    if (status === "error" || result?.isError) {
      return `${inputSummary} → failed`;
    }
    if (!resultSummary || resultSummary === "done") {
      return inputSummary;
    }
    return `${inputSummary} → ${resultSummary}`;
  }

  if (toolName === "Glob" || toolName === "Grep") {
    return `${inputSummary} → ${resultSummary}`;
  }

  // For Bash, always show description (input summary) since output is in collapsed preview
  if (toolName === "Bash") {
    return inputSummary;
  }

  // Codex code mode's `exec` input is the useful context; its result is an
  // orchestration envelope and otherwise collapses every row to just "done".
  if (toolName === "CodexExec") {
    if (status === "error" || result?.isError) {
      return `${inputSummary} → failed`;
    }
    return getCodexWebRunOverview(input) && resultSummary
      ? `${inputSummary} → ${resultSummary}`
      : inputSummary;
  }

  if (toolName === "WriteStdin") {
    if (inputSummary && inputSummary !== "waiting for output") {
      return `${inputSummary} → ${resultSummary}`;
    }
    return resultSummary;
  }

  if (
    (toolName.toLowerCase() === "websearch" ||
      toolName.toLowerCase() === "webfetch") &&
    inputSummary &&
    inputSummary !== "..."
  ) {
    return `${inputSummary} → ${resultSummary}`;
  }

  return resultSummary;
}

/**
 * Default input summary when renderer doesn't provide one.
 * Handles both Claude SDK field names and generic fallback for other providers.
 */
function getDefaultInputSummary(toolName: string, input: unknown): string {
  // Guard against null/undefined input
  if (!input || typeof input !== "object") {
    return "...";
  }

  const i = input as Record<string, unknown>;

  // Try Claude SDK field names first, then fall back to generic
  switch (toolName) {
    case "Read":
    case "Write":
    case "Edit":
      if (typeof i.file_path === "string") return getFileName(i.file_path);
      break;
    case "Bash":
      {
        const command = getDisplayBashCommandFromInput(i);
        if (command) return command;
      }
      break;
    case "Glob":
      if (typeof i.pattern === "string") return i.pattern;
      break;
    case "Grep":
      if (typeof i.pattern === "string") return `"${i.pattern}"`;
      break;
    case "Task":
    case "Agent":
      if (typeof i.description === "string") return truncate(i.description, 30);
      break;
    case "WebSearch":
      if (typeof i.query === "string") return truncate(i.query, 30);
      break;
    case "WebFetch":
      if (typeof i.url === "string") return truncate(i.url, 40);
      break;
  }

  // Fallback: try to find first meaningful string property to show
  return getFirstStringValue(i);
}

function getOpenCodeInputSummary(toolName: string, input: unknown): string {
  if (!input || typeof input !== "object") {
    return "";
  }

  const i = input as Record<string, unknown>;
  const lowerToolName = toolName.toLowerCase();
  const stringField = (...fields: string[]) => {
    for (const field of fields) {
      const value = i[field];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
    return "";
  };

  switch (lowerToolName) {
    case "skill":
      return truncate(stringField("name", "opencodeTitle"), 120);
    case "bash":
    case "shell":
      return truncate(
        getDisplayBashCommandFromInput(i) || stringField("command"),
        160,
      );
    case "read":
      return truncate(stringField("file_path", "filePath", "path"), 120);
    case "write":
    case "edit":
      return truncate(stringField("file_path", "filePath", "path"), 120);
    case "glob":
      return truncate(stringField("pattern", "path"), 120);
    case "grep":
      return truncate(stringField("pattern"), 120);
    case "websearch":
    case "web_search":
      return truncate(stringField("query"), 120);
    case "webfetch":
    case "web_fetch":
      return truncate(stringField("url"), 120);
    case "todowrite":
    case "todo":
      if (Array.isArray(i.todos)) {
        return `${i.todos.length} todos`;
      }
      break;
    case "question":
      if (Array.isArray(i.questions)) {
        const count = i.questions.length;
        return `${count} question${count === 1 ? "" : "s"}`;
      }
      break;
  }

  if (typeof i.opencodeTitle === "string" && i.opencodeTitle.trim()) {
    return truncate(i.opencodeTitle.trim(), 160);
  }

  return getFirstStringValue(i);
}

/**
 * Get the first short string value from an object for fallback display.
 * Useful for unknown tool inputs from non-Claude providers.
 */
function getFirstStringValue(obj: Record<string, unknown>): string {
  for (const value of Object.values(obj)) {
    if (typeof value === "string" && value.length > 0 && value.length < 100) {
      return truncate(value, 40);
    }
  }
  return "...";
}

/**
 * Default result summary when renderer doesn't provide one
 */
function getDefaultResultSummary(
  toolName: string,
  result: ToolResultData | undefined,
  status: "pending" | "complete" | "error",
): string {
  if (status === "error") {
    return "failed";
  }

  if (!result) {
    return "done";
  }

  // Try to extract meaningful info from content
  // Guard against non-string content (can happen with some tool results)
  const content = typeof result.content === "string" ? result.content : "";
  const lineCount = content.split("\n").filter(Boolean).length;

  switch (toolName) {
    case "Read":
      return `${lineCount} lines`;
    case "Bash":
      return `${lineCount} lines`;
    case "Glob":
      return `${lineCount} files`;
    case "Grep":
      return `${lineCount} matches`;
    default:
      return "done";
  }
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen - 3)}...`;
}

function getFileName(filePath: string): string {
  return filePath.split("/").pop() || filePath;
}
