import { resolveCodexMcpThreadProfile } from "../codex/mcp-profile.js";
import {
  SIDE_BOUNDARY,
  type SideEvent,
  type SideTransport,
} from "./session.js";

export interface SideCodexClient {
  requestIsolated<T>(method: string, params: unknown): Promise<T>;
  isolateThread(
    id: string,
    onNotification: (method: string, params: unknown) => void,
    onClose: () => void,
  ): () => void;
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

export async function createCodexSideConversation(options: {
  client: SideCodexClient;
  parentId: string;
  cwd: string;
  model?: string;
  modelProvider?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  context: "snapshot" | "empty";
  emit(event: SideEvent): void;
}): Promise<SideTransport> {
  const { client, emit } = options;
  const effective = await client.requestIsolated<{ config?: unknown }>(
    "config/read",
    { cwd: options.cwd, includeLayers: false },
  );
  const config = record(effective.config);
  const cleared = resolveCodexMcpThreadProfile("clear", config).threadConfig;
  for (const server of Object.values(cleared.mcp_servers))
    server.enabled_tools = [];
  const hooks = Object.fromEntries(
    [
      "PreToolUse",
      "PermissionRequest",
      "PostToolUse",
      "PreCompact",
      "PostCompact",
      "SessionStart",
      "SessionEnd",
      "UserPromptSubmit",
      "SubagentStart",
      "SubagentStop",
      "Stop",
      "Interrupt",
    ].map((name) => [name, []]),
  );
  const features = Object.fromEntries(
    [
      "shell_tool",
      "unified_exec",
      "apps",
      "plugins",
      "plugin_hooks",
      "multi_agent",
      "multi_agent_v2",
      "multi_agent_v2_dynamic_tools",
      "worktrees",
      "goals",
      "computer_use",
      "browser_use",
      "browser_use_external",
      "in_app_browser",
      "in_app_local_automation",
      "image_generation",
      "skill_mcp_dependency_install",
      "remote_control",
      "realtime_conversation",
    ].map((name) => [name, false]),
  );
  const developer = [
    typeof config.developer_instructions === "string"
      ? config.developer_instructions
      : "",
    SIDE_BOUNDARY,
  ]
    .filter(Boolean)
    .join("\n\n");
  const common = {
    cwd: options.cwd,
    model: options.model,
    modelProvider: options.modelProvider,
    serviceTier: options.serviceTier,
    ephemeral: true,
    approvalPolicy: "never",
    sandbox: "read-only",
    developerInstructions: developer,
    config: {
      ...cleared,
      features,
      agents: { enabled: false },
      hooks,
      web_search: "disabled",
      ...(options.reasoningEffort
        ? { model_reasoning_effort: options.reasoningEffort }
        : {}),
    },
  };
  const result = await client.requestIsolated<{
    thread: { id: string; ephemeral: boolean };
    model?: string;
    reasoningEffort?: string;
    sandbox?: { type?: string };
  }>(
    options.context === "snapshot" ? "thread/fork" : "thread/start",
    options.context === "snapshot"
      ? { ...common, threadId: options.parentId, excludeTurns: true }
      : common,
  );
  const id = result.thread?.id;
  if (!id || id === options.parentId)
    throw new Error("Codex did not create an independent side thread.");
  let turnId: string | undefined;
  let starting: Promise<void> | undefined;
  let disposed = false;
  const completed = new Set<string>();
  const cleanup = client.isolateThread(
    id,
    (method, value) => {
      if (disposed) return;
      const params = record(value);
      const turn = record(params.turn);
      if (typeof params.turnId === "string" && completed.has(params.turnId))
        return;
      if (method === "turn/started" && typeof turn.id === "string")
        turnId = turn.id;
      if (
        method === "item/agentMessage/delta" &&
        typeof params.delta === "string" &&
        typeof params.itemId === "string"
      ) {
        emit({
          type: "text",
          id: params.itemId,
          text: params.delta,
          append: true,
        });
      } else if (method === "item/completed") {
        const item = record(params.item);
        if (
          item.type === "agentMessage" &&
          typeof item.id === "string" &&
          typeof item.text === "string"
        )
          emit({ type: "text", id: item.id, text: item.text });
      } else if (method === "turn/completed") {
        if (typeof turn.id === "string") completed.add(turn.id);
        turnId = undefined;
        emit({
          type: "done",
          ...(turn.status === "failed"
            ? {
                error: String(
                  record(turn.error).message ?? "Side conversation failed",
                ),
              }
            : {}),
        });
      } else if (method === "thread/closed") {
        emit({ type: "closed" });
      } else if (method === "error" && params.willRetry !== true) {
        emit({
          type: "done",
          error: String(
            record(params.error).message ?? "Side conversation failed",
          ),
        });
      }
    },
    () => emit({ type: "closed" }),
  );

  const interrupt = async () => {
    await starting;
    if (turnId)
      await client.requestIsolated("turn/interrupt", { threadId: id, turnId });
  };
  const close = async () => {
    if (disposed) return;
    disposed = true;
    try {
      await interrupt();
    } finally {
      try {
        await client.requestIsolated("thread/unsubscribe", { threadId: id });
      } finally {
        cleanup();
      }
    }
  };
  try {
    if (result.thread.ephemeral !== true || result.sandbox?.type !== "readOnly")
      throw new Error(
        "Codex could not enforce the temporary read-only side thread.",
      );
    await client.requestIsolated("thread/inject_items", {
      threadId: id,
      items: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: SIDE_BOUNDARY }],
        },
      ],
    });
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
  return {
    model: result.model,
    reasoningEffort: result.reasoningEffort,
    async send(text, requestId) {
      if (disposed) throw new Error("Side thread closed");
      starting = (async () => {
        const response = await client.requestIsolated<{
          turn: { id: string; status: string };
        }>("turn/start", {
          threadId: id,
          clientUserMessageId: requestId,
          input: [{ type: "text", text, text_elements: [] }],
        });
        if (
          !completed.has(response.turn.id) &&
          response.turn.status === "inProgress"
        )
          turnId = response.turn.id;
        else if (!completed.has(response.turn.id))
          emit({
            type: "done",
            ...(response.turn.status === "failed"
              ? { error: "Side conversation failed" }
              : {}),
          });
      })();
      try {
        await starting;
      } finally {
        starting = undefined;
      }
    },
    interrupt,
    close,
  };
}
