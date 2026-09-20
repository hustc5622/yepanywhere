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
  bash: "Bash",
  shell: "Bash",
  shell_command: "Bash",
  exec_command: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  glob: "Glob",
  grep: "Grep",
  todowrite: "TodoWrite",
  todo: "TodoWrite",
  write_stdin: "WriteStdin",
  wait: "CodexWait",
  update_plan: "UpdatePlan",
  apply_patch: "Edit",
  web_search_call: "WebSearch",
  search_query: "WebSearch",
  websearch: "WebSearch",
  webrun: "WebSearch", // codex web.run (namespace "web" + name "run")
  web__run: "WebSearch", // codex code-mode nested web.run
  webfetch: "WebFetch",
  Agent: "Task", // SDK 0.2.76+ renamed Task → Agent
  AgentSwarm: "Task", // Kimi parallel subagent dispatch
  view_image: "ViewImage",
  imageView: "ViewImage",
  image_generation: "ViewImage",
  imageGeneration: "ViewImage",
  readmediafile: "ReadMediaFile",
  skill: "Skill",
};

export function canonicalizeToolName(toolName: string): string {
  return (
    TOOL_NAME_ALIASES[toolName] ??
    TOOL_NAME_ALIASES[toolName.toLowerCase()] ??
    toolName
  );
}
