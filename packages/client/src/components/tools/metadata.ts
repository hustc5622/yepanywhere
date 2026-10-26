import {
  SHARED_RENDERER_TOOL_ALIASES,
  lookupToolAlias,
} from "@yep-anywhere/shared";

/** Pure tool identity and summary contracts; no renderer imports. */
export interface ToolSummaryMethods {
  getUseSummary?: (input: unknown) => string;
  getResultSummary?: (
    result: unknown,
    isError: boolean,
    input?: unknown,
  ) => string;
}

const TOOL_NAME_ALIASES: Record<string, string> = {
  ...SHARED_RENDERER_TOOL_ALIASES,
  bash: "Bash",
  shell: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  glob: "Glob",
  grep: "Grep",
  todowrite: "TodoWrite",
  todo: "TodoWrite",
  wait: "CodexWait",
  websearch: "WebSearch",
  webrun: "WebSearch", // codex web.run (namespace "web" + name "run")
  web__run: "WebSearch", // codex code-mode nested web.run
  webfetch: "WebFetch",
  Agent: "Task", // SDK 0.2.76+ renamed Task → Agent
  AgentSwarm: "Task", // parallel subagent dispatch
  view_image: "ViewImage",
  imageView: "ViewImage",
  image_generation: "ViewImage",
  imageGeneration: "ViewImage",
  skill: "Skill",
};

export function canonicalizeToolName(toolName: string): string {
  return lookupToolAlias(TOOL_NAME_ALIASES, toolName);
}
