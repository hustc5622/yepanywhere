/**
 * MiniMax Code tool name / argument adaptation.
 *
 * mcode's built-in tools are mostly lower-case Pi/Claude hybrids (`bash`,
 * `read {path}`, `edit {file_path, old_string, new_string}`, `glob`, `grep`,
 * `web_search`, `web_fetch`, `task {agent_name, description, prompt}`, ...).
 * Map them onto the names Yep's rich tool renderers already understand and
 * add the renderer field aliases, keeping every native field for diagnostics.
 */

import { withCanonicalFilePath } from "@yep-anywhere/shared";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MCODE_TOOL_NAMES: Record<string, string> = {
  bash: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  glob: "Glob",
  grep: "Grep",
  ls: "Glob",
  web_search: "WebSearch",
  web_fetch: "WebFetch",
  task: "Task",
  task_output: "TaskOutput",
  skill: "Skill",
};

export function canonicalizeMcodeToolName(name: string): string {
  return MCODE_TOOL_NAMES[name.toLowerCase()] ?? name;
}

export function normalizeMcodeToolArguments(
  nativeName: string,
  input: unknown,
): Record<string, unknown> {
  let normalized = isRecord(input) ? { ...input } : {};
  switch (nativeName.toLowerCase()) {
    case "read":
    case "write":
    case "edit":
      normalized = withCanonicalFilePath(normalized);
      break;
    case "ls":
      if (typeof normalized.pattern !== "string") normalized.pattern = "*";
      break;
    case "task":
      if (
        typeof normalized.agent_name === "string" &&
        typeof normalized.subagent_type !== "string"
      ) {
        normalized.subagent_type = normalized.agent_name;
      }
      break;
    case "web_fetch":
      if (typeof normalized.prompt !== "string") normalized.prompt = "";
      break;
  }
  return normalized;
}
