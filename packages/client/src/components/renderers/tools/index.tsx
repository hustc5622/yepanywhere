import type { ReactNode } from "react";
import type { RenderContext } from "../types";
import { mcpToolRenderer, parseMcpToolName } from "./McpToolRenderer";
import type { ToolRenderer } from "./types";

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
  webfetch: "WebFetch",
  Agent: "Task", // SDK 0.2.76+ renamed Task → Agent
  view_image: "ViewImage",
  imageView: "ViewImage",
  image_generation: "ViewImage",
  imageGeneration: "ViewImage",
  skill: "Skill",
};

function canonicalizeToolName(toolName: string): string {
  return (
    TOOL_NAME_ALIASES[toolName] ??
    TOOL_NAME_ALIASES[toolName.toLowerCase()] ??
    toolName
  );
}

/**
 * Registry for tool-specific renderers
 */
class ToolRendererRegistry {
  private tools = new Map<string, ToolRenderer>();
  private fallback: ToolRenderer;

  constructor(fallback: ToolRenderer) {
    this.fallback = fallback;
  }

  register(renderer: ToolRenderer): void {
    this.tools.set(renderer.tool, renderer);
  }

  get(toolName: string): ToolRenderer {
    const canonicalToolName = canonicalizeToolName(toolName);
    const registered = this.tools.get(canonicalToolName);
    if (registered) {
      return registered;
    }
    // MCP tools (server:tool / mcp__server__tool) get a structured renderer
    // instead of the raw-JSON fallback.
    if (parseMcpToolName(canonicalToolName)) {
      return mcpToolRenderer;
    }
    return this.fallback;
  }

  renderToolUse(
    toolName: string,
    input: unknown,
    context: RenderContext,
  ): ReactNode {
    return this.get(toolName).renderToolUse(input, context);
  }

  renderToolResult(
    toolName: string,
    result: unknown,
    isError: boolean,
    context: RenderContext,
    input?: unknown,
  ): ReactNode {
    return this.get(toolName).renderToolResult(result, isError, context, input);
  }

  hasInteractiveSummary(toolName: string): boolean {
    const renderer = this.get(toolName);
    return typeof renderer.renderInteractiveSummary === "function";
  }

  hasCollapsedPreview(toolName: string): boolean {
    const renderer = this.get(toolName);
    return typeof renderer.renderCollapsedPreview === "function";
  }

  renderCollapsedPreview(
    toolName: string,
    input: unknown,
    result: unknown,
    isError: boolean,
    context: RenderContext,
  ): ReactNode {
    const renderer = this.get(toolName);
    if (renderer.renderCollapsedPreview) {
      return renderer.renderCollapsedPreview(input, result, isError, context);
    }
    return null;
  }

  renderInteractiveSummary(
    toolName: string,
    input: unknown,
    result: unknown,
    isError: boolean,
    context: RenderContext,
  ): ReactNode {
    const renderer = this.get(toolName);
    if (renderer.renderInteractiveSummary) {
      return renderer.renderInteractiveSummary(input, result, isError, context);
    }
    return null;
  }

  hasInlineRenderer(toolName: string): boolean {
    const renderer = this.get(toolName);
    return typeof renderer.renderInline === "function";
  }

  renderInline(
    toolName: string,
    input: unknown,
    result: unknown,
    isError: boolean,
    status: "pending" | "complete" | "error" | "aborted",
    context: RenderContext,
  ): ReactNode {
    const renderer = this.get(toolName);
    if (renderer.renderInline) {
      return renderer.renderInline(input, result, isError, status, context);
    }
    return null;
  }

  getDisplayName(toolName: string, input?: unknown): string {
    const renderer = this.get(toolName);
    if (renderer === mcpToolRenderer) {
      const identity = parseMcpToolName(canonicalizeToolName(toolName));
      if (identity) {
        return `${identity.server} · ${identity.tool}`;
      }
    }
    if (renderer.getDisplayName) {
      return renderer.getDisplayName(input);
    }
    return renderer.displayName || toolName;
  }
}

/**
 * Fallback tool renderer - shows raw JSON
 */
const fallbackToolRenderer: ToolRenderer = {
  tool: "__fallback__",
  renderToolUse(input, _context) {
    return (
      <pre className="tool-fallback">
        <code>{JSON.stringify(input, null, 2)}</code>
      </pre>
    );
  },
  renderToolResult(result, isError, _context) {
    return (
      <pre className={`tool-fallback ${isError ? "tool-fallback-error" : ""}`}>
        <code>{JSON.stringify(result, null, 2)}</code>
      </pre>
    );
  },
};

// Create and export the tool registry
export const toolRegistry = new ToolRendererRegistry(fallbackToolRenderer);

// Import and register tool renderers
import { askUserQuestionRenderer } from "./AskUserQuestionRenderer";
import { bashOutputRenderer } from "./BashOutputRenderer";
import { bashRenderer } from "./BashRenderer";
import { codexCollaborationRenderers } from "./CodexCollaborationRenderer";
import { codexExecRenderer } from "./CodexExecRenderer";
import { codexWaitRenderer } from "./CodexWaitRenderer";
import { editRenderer } from "./EditRenderer";
import { exitPlanModeRenderer } from "./ExitPlanModeRenderer";
import { globRenderer } from "./GlobRenderer";
import { grepRenderer } from "./GrepRenderer";
import { killShellRenderer } from "./KillShellRenderer";
import { openCodeTaskRenderer } from "./OpenCodeTaskRenderer";
import { readRenderer } from "./ReadRenderer";
import { skillRenderer } from "./SkillRenderer";
import { taskOutputRenderer } from "./TaskOutputRenderer";
import { taskRenderer } from "./TaskRenderer";
import { todoWriteRenderer } from "./TodoWriteRenderer";
import { updatePlanRenderer } from "./UpdatePlanRenderer";
import { viewImageRenderer } from "./ViewImageRenderer";
import { webFetchRenderer } from "./WebFetchRenderer";
import { webSearchRenderer } from "./WebSearchRenderer";
import { writeRenderer } from "./WriteRenderer";
import { writeStdinRenderer } from "./WriteStdinRenderer";

// Tier 1 & 2: Core tools
toolRegistry.register(bashRenderer);
toolRegistry.register(codexExecRenderer);
toolRegistry.register(codexWaitRenderer);
toolRegistry.register(readRenderer);
toolRegistry.register(editRenderer);
toolRegistry.register(writeRenderer);
toolRegistry.register(globRenderer);
toolRegistry.register(grepRenderer);
toolRegistry.register(todoWriteRenderer);
toolRegistry.register(skillRenderer);

// Tier 3: Less common tools
toolRegistry.register(taskRenderer);
// OpenCode's lowercase `task` tool spawns a standalone subagent session; render
// it as a clickable card linking to that session (distinct from Claude's Task).
toolRegistry.register(openCodeTaskRenderer);
toolRegistry.register(webSearchRenderer);
toolRegistry.register(webFetchRenderer);
toolRegistry.register(askUserQuestionRenderer);
toolRegistry.register(exitPlanModeRenderer);
toolRegistry.register(updatePlanRenderer);
toolRegistry.register(writeStdinRenderer);

// Codex-specific tools
toolRegistry.register(viewImageRenderer);
for (const renderer of codexCollaborationRenderers) {
  toolRegistry.register(renderer);
}

// Tier 4: Background/async tools
toolRegistry.register(bashOutputRenderer);
toolRegistry.register(taskOutputRenderer);
toolRegistry.register(killShellRenderer);
