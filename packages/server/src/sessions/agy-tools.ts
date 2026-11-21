/**
 * Antigravity CLI (`agy`) tool name / argument adaptation.
 *
 * agy's native tools use snake_case names with PascalCase arguments
 * (`run_command {CommandLine}`, `read_file {Path}`, `write_file {Path,
 * Content}`, `replace_file_content {TargetFile, TargetContent,
 * ReplacementContent}`, ...). Map them onto the names Yep's rich tool
 * renderers already understand and add the renderer field aliases, keeping
 * every native field for diagnostics.
 *
 * Observed names come from references/antigravity/probe traces; the rest
 * follow the community adapters in references/antigravity/community.
 */

import { withCanonicalFilePath } from "@yep-anywhere/shared";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const AGY_TOOL_NAMES: Record<string, string> = {
  run_command: "Bash",
  read_file: "Read",
  view_file: "Read",
  read_resource: "Read",
  write_file: "Write",
  write_to_file: "Write",
  replace_file_content: "Edit",
  multi_replace_file_content: "Edit",
  sed_file: "Edit",
  list_dir: "Glob",
  find_by_name: "Glob",
  grep_search: "Grep",
  search_web: "WebSearch",
  read_url_content: "WebFetch",
  invoke_subagent: "Task",
  ask_question: "AskUserQuestion",
};

function firstString(
  input: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/** `call_mcp_tool {ServerName, ToolName}` renders as Yep's `mcp__server__tool`. */
function mcpToolName(input: unknown): string | null {
  if (!isRecord(input)) return null;
  const server = firstString(input, ["ServerName", "serverName"]);
  const tool = firstString(input, ["ToolName", "toolName"]);
  return server && tool ? `mcp__${server}__${tool}` : null;
}

export function canonicalizeAgyToolName(name: string, input?: unknown): string {
  if (name === "call_mcp_tool") return mcpToolName(input) ?? name;
  return AGY_TOOL_NAMES[name] ?? name;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** AskUserQuestion input from `ask_question {questions:[{question, options, is_multi_select}]}`. */
function adaptQuestions(input: Record<string, unknown>): unknown[] {
  const raw = Array.isArray(input.questions) ? input.questions : [];
  return raw.filter(isRecord).map((question, index) => ({
    id: `q${index + 1}`,
    question: typeof question.question === "string" ? question.question : "",
    header: "",
    options: (Array.isArray(question.options) ? question.options : [])
      .filter((option): option is string => typeof option === "string")
      .map((label) => ({ label, description: "" })),
    multiSelect: question.is_multi_select === true,
  }));
}

export function normalizeAgyToolArguments(
  nativeName: string,
  input: unknown,
): Record<string, unknown> {
  const native = isRecord(input) ? { ...input } : {};
  switch (nativeName) {
    case "run_command": {
      const command = firstString(native, ["CommandLine", "command"]);
      const description = firstString(native, ["toolSummary"]);
      return {
        ...native,
        ...(command ? { command } : {}),
        ...(description ? { description } : {}),
      };
    }
    case "read_file":
    case "view_file":
    case "read_resource": {
      const filePath = firstString(native, ["AbsolutePath", "Path", "path"]);
      const start = native.StartLine;
      const end = native.EndLine;
      return withCanonicalFilePath({
        ...native,
        ...(filePath ? { file_path: filePath } : {}),
        ...(typeof start === "number" ? { offset: start } : {}),
        ...(typeof start === "number" && typeof end === "number"
          ? { limit: Math.max(0, end - start + 1) }
          : {}),
      });
    }
    case "write_file":
    case "write_to_file": {
      const filePath = firstString(native, [
        "TargetFile",
        "AbsolutePath",
        "Path",
        "path",
      ]);
      const content = firstString(native, ["CodeContent", "Content"]) ?? "";
      return withCanonicalFilePath({
        ...native,
        ...(filePath ? { file_path: filePath } : {}),
        content,
      });
    }
    case "replace_file_content":
    case "sed_file": {
      const filePath = firstString(native, [
        "TargetFile",
        "AbsolutePath",
        "Path",
      ]);
      return withCanonicalFilePath({
        ...native,
        ...(filePath ? { file_path: filePath } : {}),
        old_string: firstString(native, ["TargetContent"]) ?? "",
        new_string: firstString(native, ["ReplacementContent"]) ?? "",
      });
    }
    case "multi_replace_file_content": {
      const filePath = firstString(native, [
        "TargetFile",
        "AbsolutePath",
        "Path",
      ]);
      const chunks = parseMaybeJson(native.ReplacementChunks);
      const pairs = (Array.isArray(chunks) ? chunks : []).filter(isRecord);
      return withCanonicalFilePath({
        ...native,
        ...(filePath ? { file_path: filePath } : {}),
        old_string: pairs
          .map((chunk) =>
            typeof chunk.TargetContent === "string" ? chunk.TargetContent : "",
          )
          .join("\n…\n"),
        new_string: pairs
          .map((chunk) =>
            typeof chunk.ReplacementContent === "string"
              ? chunk.ReplacementContent
              : "",
          )
          .join("\n…\n"),
      });
    }
    case "list_dir":
    case "find_by_name": {
      const path = firstString(native, ["DirectoryPath", "SearchDirectory"]);
      return {
        ...native,
        pattern: firstString(native, ["Pattern"]) ?? "*",
        ...(path ? { path } : {}),
      };
    }
    case "grep_search": {
      const path = firstString(native, ["SearchPath", "SearchDirectory"]);
      return {
        ...native,
        pattern: firstString(native, ["Query", "Pattern"]) ?? "",
        ...(path ? { path } : {}),
      };
    }
    case "search_web":
      return {
        ...native,
        query: firstString(native, ["query", "Query"]) ?? "",
      };
    case "read_url_content":
      return {
        ...native,
        url: firstString(native, ["Url", "URL", "url"]) ?? "",
        prompt: "",
      };
    case "invoke_subagent": {
      const prompt = firstString(native, ["Prompt", "Task", "Input"]) ?? "";
      return {
        ...native,
        description:
          firstString(native, ["Description", "Role", "TypeName"]) ?? "",
        prompt,
        subagent_type: firstString(native, ["TypeName", "Role"]) ?? "agent",
      };
    }
    case "ask_question":
      return { ...native, questions: adaptQuestions(native) };
    case "call_mcp_tool": {
      const args = parseMaybeJson(native.Arguments);
      return isRecord(args) ? args : native;
    }
    default:
      return native;
  }
}

/**
 * Best-effort native tool name for an ACP tool call whose vendor `name` field
 * was not observed (the ACP SDK's schema parsing drops it). Uses agy's
 * PascalCase argument shapes, then the `kind`/`title` projection.
 */
export function inferAgyNativeToolName(update: {
  kind?: unknown;
  title?: unknown;
  rawInput?: unknown;
}): string {
  const input = isRecord(update.rawInput) ? update.rawInput : {};
  const has = (key: string) => input[key] !== undefined;
  if (has("CommandLine")) return "run_command";
  if (Array.isArray(input.questions)) return "ask_question";
  if (has("ServerName") && has("ToolName")) return "call_mcp_tool";
  if (has("ReplacementChunks")) return "multi_replace_file_content";
  if (has("TargetContent") || has("ReplacementContent")) {
    return "replace_file_content";
  }
  if (
    (has("Content") || has("CodeContent")) &&
    (has("Path") || has("TargetFile"))
  ) {
    return has("TargetFile") ? "write_to_file" : "write_file";
  }
  if (has("Url") || has("URL")) return "read_url_content";
  if (has("DirectoryPath")) return "list_dir";
  if (has("SearchDirectory") && has("Pattern")) return "find_by_name";
  if (has("Query") || has("SearchPath")) return "grep_search";
  if (typeof input.query === "string") return "search_web";
  if (update.kind === "read" && (has("Path") || has("AbsolutePath"))) {
    return has("AbsolutePath") ? "view_file" : "read_file";
  }
  const title = typeof update.title === "string" ? update.title.trim() : "";
  const run = /^Run ([a-z_]+)$/.exec(title);
  if (run?.[1]) return run[1];
  return title || "tool";
}

/**
 * agy prefixes tool results with bookkeeping lines (`Created At: …`,
 * `Completed At: …`, sometimes repeated) and wraps failures as
 * `Encountered error in step execution: …`. Keep only the payload.
 */
export function cleanAgyToolOutput(text: string): string {
  return text
    .replace(/^(?:(?:Created|Completed) At: [^\n]*\n?)+/u, "")
    .replace(/^Encountered error in step execution: /u, "")
    .trimEnd();
}
