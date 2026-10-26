/**
 * Cursor ACP provider.
 *
 * Cursor CLI serves `agent acp` over stdio. Sessions persist under
 * `~/.cursor/acp-sessions/<id>/` once a prompt opens `store.db`. Tool
 * approvals arrive as ACP `session/request_permission`.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
import {
  type ModelInfo,
  type PermissionMode,
  withCanonicalFilePath,
} from "@yep-anywhere/shared";
import { getLogger } from "../../logging/logger.js";
import { CURSOR_ACP_SESSIONS_DIR } from "../../sessions/cursor-reader.js";
import { readCursorSessionDir } from "../../sessions/cursor-store.js";
import { MessageQueue, getUserPromptProjection } from "../messageQueue.js";
import type { SDKMessage, ToolApprovalResult } from "../types.js";
import { ACPClient } from "./acp/client.js";
import { cursorAccountService } from "./cursor-account.js";
import { findCursorAgentPath } from "./cursor-cli.js";
import { cursorStreamError } from "./cursor-errors.js";
import {
  CURSOR_ACP_CLIENT_CAPABILITIES,
  applyCursorModelParameters,
  cursorLaunchModel,
} from "./cursor-model-selection.js";
import { loadCursorModelCatalog } from "./cursor-models.js";
import { claimCursorPrepare } from "./cursor-prepare.js";
import type {
  AgentProvider,
  AgentSession,
  AuthStatus,
  StartSessionOptions,
} from "./types.js";

const execFileAsync = promisify(execFile);
const log = getLogger();

const MODEL_CACHE_MS = 10 * 60 * 1000;
const STRUCTURED_CURSOR_TOOLS = new Set(["TodoWrite", "Task", "ViewImage"]);
let modelCache: { at: number; models: ModelInfo[] } | null = null;
let modelRequest: Promise<ModelInfo[]> | null = null;

export function resetCursorModelCacheForTests(): void {
  modelCache = null;
  modelRequest = null;
}

function toCursorMode(mode: PermissionMode | undefined): "agent" | "plan" {
  return mode === "plan" ? "plan" : "agent";
}

function parseModelList(stdout: string): ModelInfo[] {
  const models: ModelInfo[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^(\S+)\s+-\s+(.+?)\s*$/.exec(line.trim());
    if (!match?.[1] || !match[2]) continue;
    if (match[1] === "Available") continue;
    models.push({ id: match[1], name: match[2].replace(/​​/g, "").trim() });
  }
  return models;
}

function optionMatches(
  option: { kind?: string; optionId?: string },
  ids: readonly string[],
): boolean {
  return ids.includes(option.kind ?? option.optionId ?? "");
}

function selectPermissionOption(
  request: RequestPermissionRequest,
  allow: boolean,
  always = false,
): RequestPermissionResponse {
  const preferred = allow
    ? always
      ? ["allow_always", "allow-always"]
      : ["allow_once", "allow-once"]
    : ["reject_once", "reject-once"];
  const selected = preferred.flatMap((id) =>
    request.options.filter((option) => optionMatches(option, [id])),
  )[0];
  if (selected) {
    return { outcome: { outcome: "selected", optionId: selected.optionId } };
  }
  return { outcome: { outcome: "cancelled" } };
}

function toolNameFromUpdate(update: {
  kind?: string | null;
  title?: string | null;
}): string {
  switch (update.kind) {
    case "execute":
      return "Bash";
    case "read":
      return "Read";
    case "edit":
      return "Edit";
    case "delete":
      return "Delete";
    case "search":
      return "Search";
    case "fetch":
      return "WebFetch";
    default:
      return update.title?.trim() || "CursorTool";
  }
}

function toolResultText(update: {
  content?: unknown;
  rawOutput?: unknown;
}): string {
  const text = collectText(update.content);
  if (text) return text;
  if (Array.isArray(update.content)) {
    const diffs = update.content.flatMap((part) =>
      part && part.type === "diff"
        ? [`${part.path}\n${part.oldText ?? ""}\n${part.newText ?? ""}`]
        : [],
    );
    if (diffs.length) return diffs.join("\n\n");
  }
  if (typeof update.rawOutput === "string") return update.rawOutput;
  const rawText = collectText(update.rawOutput);
  if (rawText) return rawText;
  if (update.rawOutput !== undefined) {
    try {
      return JSON.stringify(update.rawOutput);
    } catch {
      return "";
    }
  }
  return "";
}

function collectText(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value.map((part) => collectText(part)).join("");
  if (typeof value === "object") {
    const record = value as { text?: unknown; content?: unknown };
    if (typeof record.text === "string") return record.text;
    if (record.content !== undefined) return collectText(record.content);
  }
  return "";
}

export class CursorProvider implements AgentProvider {
  readonly name = "cursor" as const;
  readonly displayName = "Cursor";
  readonly supportsPermissionMode = true;
  readonly permissionModes = ["default", "plan", "bypassPermissions"] as const;
  readonly supportsThinkingToggle = false;
  // Reasoning lives in the model id parameters (`reasoning_effort=...`).
  readonly usesReasoningLaunchSettings = false;
  // runSession reads the next prompt only after streamPrompt finishes.
  readonly defersInputDuringTurn = true;
  readonly supportsSlashCommands = false;

  async isInstalled(): Promise<boolean> {
    return (await findCursorAgentPath()) !== null;
  }

  async isAuthenticated(): Promise<boolean> {
    return (await cursorAccountService.getAuthStatus()).authenticated;
  }

  async getAuthStatus(): Promise<AuthStatus> {
    return cursorAccountService.getAuthStatus();
  }

  async getAvailableModels(options?: {
    waitForRefresh?: boolean;
  }): Promise<ModelInfo[]> {
    if (modelCache && Date.now() - modelCache.at < MODEL_CACHE_MS) {
      return modelCache.models;
    }
    const refresh = this.refreshModels();
    if (options?.waitForRefresh === false) {
      void refresh.catch(() => undefined);
      return modelCache?.models ?? [];
    }
    return refresh;
  }

  private refreshModels(): Promise<ModelInfo[]> {
    if (modelRequest) return modelRequest;
    modelRequest = this.loadModels().finally(() => {
      modelRequest = null;
    });
    return modelRequest;
  }

  private async loadModels(): Promise<ModelInfo[]> {
    const path = await findCursorAgentPath();
    if (!path) return [];
    try {
      const models = await loadCursorModelCatalog(path);
      modelCache = { at: Date.now(), models };
      return models;
    } catch {
      // Older CLIs lack the native catalog extension. Keep their usable flat
      // list instead of inventing parameters from display names or suffixes.
    }
    try {
      const { stdout } = await execFileAsync(path, ["--list-models"], {
        encoding: "utf8",
        timeout: 20_000,
      });
      const models = parseModelList(stdout);
      modelCache = { at: Date.now(), models };
      return models;
    } catch (error) {
      log.warn({ err: error }, "Cursor model list failed");
      return modelCache?.models ?? [];
    }
  }

  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    // ACP can switch execution modes, but --force is a process-wide startup
    // flag. Keep native approval enabled and let Yep's explicit session policy
    // approve individual requests, so switching back immediately restores asks.
    const sessionOptions = { ...options };
    const queue = new MessageQueue();
    const abortController = new AbortController();
    if (options.initialMessage) queue.push(options.initialMessage);
    const claimed = await claimCursorPrepare({
      cwd: options.cwd,
      model: options.model,
      permissionMode: options.permissionMode,
      resumeSessionId: options.resumeSessionId,
    });
    const client = claimed?.client ?? new ACPClient();
    let sessionId: string | null = claimed?.sessionId ?? null;
    const iterator = this.runSession(
      client,
      sessionOptions,
      queue,
      abortController.signal,
      (id) => {
        sessionId = id;
      },
      claimed,
    );
    return {
      iterator,
      queue,
      abort: () => {
        abortController.abort();
        queue.close();
        if (sessionId) {
          void client.cancel(sessionId).catch(() => undefined);
        }
        client.close();
      },
      isProcessAlive: () => client.isAlive(),
      get pid() {
        return client.pid;
      },
      interrupt: async () => {
        if (sessionId) await client.cancel(sessionId);
      },
      setPermissionMode: async (mode) => {
        if (!this.permissionModes.some((supported) => supported === mode)) {
          throw new Error(`Unsupported Cursor permission mode: ${mode}`);
        }
        if (!sessionId) {
          throw new Error("Cursor ACP session is not initialized yet");
        }
        await client.setSessionMode(sessionId, toCursorMode(mode));
        sessionOptions.permissionMode = mode;
      },
    };
  }

  private async *runSession(
    client: ACPClient,
    options: StartSessionOptions,
    queue: MessageQueue,
    signal: AbortSignal,
    onSessionId: (sessionId: string) => void,
    handoff?: { sessionId?: string } | null,
  ): AsyncIterableIterator<SDKMessage> {
    const agentPath = await findCursorAgentPath();
    if (!agentPath) {
      yield {
        type: "error",
        error:
          "Cursor CLI not found. Install it from https://cursor.com/docs/cli/overview and run `agent login`.",
      } as SDKMessage;
      return;
    }

    const updateQueue: SessionNotification[] = [];
    const sideMessages: SDKMessage[] = [];
    const toolNames = new Map<string, string>();
    let activeSessionId = handoff?.sessionId ?? "";
    client.setSessionUpdateCallback((update) => {
      updateQueue.push(update);
    });
    client.setPermissionRequestCallback((request) =>
      this.handlePermissionRequest(request, options, signal),
    );
    client.setExtensionRequestCallback((method, params) =>
      this.handleExtensionRequest(
        method,
        params,
        options,
        signal,
        sideMessages,
        toolNames,
        () => activeSessionId,
      ),
    );

    try {
      if (!handoff) {
        const args = ["acp"];
        const launchModel = cursorLaunchModel(options.model);
        if (launchModel) {
          args.unshift("--model", launchModel);
        }
        await client.connect({ command: agentPath, args, cwd: options.cwd });
        await client.initialize(CURSOR_ACP_CLIENT_CAPABILITIES);
        await client.authenticate("cursor_login");
      }

      let sessionId: string;
      if (handoff?.sessionId) {
        sessionId = handoff.sessionId;
      } else if (options.resumeSessionId) {
        await client.loadSession(options.resumeSessionId, options.cwd);
        sessionId = options.resumeSessionId;
        updateQueue.length = 0;
      } else {
        sessionId = await client.newSession(options.cwd);
      }
      activeSessionId = sessionId;
      onSessionId(sessionId);
      const history = options.resumeSessionId
        ? await readCursorSessionDir(join(CURSOR_ACP_SESSIONS_DIR, sessionId))
        : null;
      let turnIndex =
        history?.messages.filter((message) => message.role === "user").length ??
        0;
      await client.setSessionMode(
        sessionId,
        toCursorMode(options.permissionMode),
      );
      await applyCursorModelParameters(client, sessionId, options.model);

      yield {
        type: "system",
        subtype: "init",
        session_id: sessionId,
        cwd: options.cwd,
        model: options.model,
      } as SDKMessage;

      for await (const message of queue.generator()) {
        if (signal.aborted) break;
        turnIndex += 1;
        const { internalPrompt, publicPrompt } =
          getUserPromptProjection(message);
        const userUuid = (message as { uuid?: string }).uuid ?? randomUUID();
        yield {
          type: "user",
          uuid: userUuid,
          session_id: sessionId,
          cursorTurnIndex: turnIndex,
          turnId: `cursor-turn-${turnIndex}`,
          message: { role: "user", content: publicPrompt },
        } as SDKMessage;

        updateQueue.length = 0;
        for await (const output of this.streamPrompt(
          client,
          sessionId,
          internalPrompt,
          updateQueue,
          sideMessages,
          toolNames,
          signal,
        )) {
          yield {
            ...output,
            cursorTurnIndex: turnIndex,
            turnId: `cursor-turn-${turnIndex}`,
            ...(output.type === "result"
              ? { uuid: `cursor-result-${turnIndex}` }
              : {}),
          } as SDKMessage;
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      log.error({ err: error }, "Cursor ACP session failed");
      yield { type: "error", error: message } as SDKMessage;
    } finally {
      queue.close();
      client.close();
    }
  }

  private async *streamPrompt(
    client: ACPClient,
    sessionId: string,
    prompt: string,
    updateQueue: SessionNotification[],
    sideMessages: SDKMessage[],
    toolNames: Map<string, string>,
    signal: AbortSignal,
  ): AsyncIterableIterator<SDKMessage> {
    let promptDone = false;
    const promptPromise = client.prompt(sessionId, prompt);
    void promptPromise.then(
      () => {
        promptDone = true;
      },
      () => {
        promptDone = true;
      },
    );

    let assistantText = "";
    let assistantId: string | null = null;
    let assistantDirty = false;
    let streamFailure: ReturnType<typeof cursorStreamError> = null;
    let thinkingText = "";
    let thinkingId: string | null = null;
    let thinkingDirty = false;

    while (
      !signal.aborted &&
      (!promptDone || updateQueue.length > 0 || sideMessages.length > 0)
    ) {
      while (sideMessages.length > 0) {
        const message = sideMessages.shift();
        if (message) yield message;
      }
      if (promptDone && updateQueue.length === 0 && sideMessages.length === 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
      while (sideMessages.length > 0) {
        const message = sideMessages.shift();
        if (message) yield message;
      }
      while (updateQueue.length > 0) {
        const notification = updateQueue.shift();
        if (!notification || notification.sessionId !== sessionId) continue;
        const update = notification.update;
        if (
          update.sessionUpdate === "agent_thought_chunk" &&
          update.content.type === "text"
        ) {
          if (assistantText && !cursorStreamError(assistantText)) {
            yield assistantMessage(sessionId, assistantId, assistantText);
          }
          assistantText = "";
          assistantId = null;
          assistantDirty = false;
          thinkingText += update.content.text;
          thinkingId ??= randomUUID();
          thinkingDirty = true;
          continue;
        }
        if (
          update.sessionUpdate === "agent_message_chunk" &&
          update.content.type === "text"
        ) {
          if (thinkingText) {
            if (thinkingDirty) {
              yield thinkingMessage(sessionId, thinkingId, thinkingText);
            }
            thinkingText = "";
            thinkingId = null;
            thinkingDirty = false;
          }
          assistantText += update.content.text;
          streamFailure = cursorStreamError(assistantText) ?? streamFailure;
          assistantId ??= randomUUID();
          assistantDirty = true;
          continue;
        }
        if (thinkingText) {
          if (thinkingDirty)
            yield thinkingMessage(sessionId, thinkingId, thinkingText);
          thinkingText = "";
          thinkingId = null;
          thinkingDirty = false;
        }
        if (assistantText && !cursorStreamError(assistantText)) {
          yield assistantMessage(sessionId, assistantId, assistantText);
        }
        assistantText = "";
        assistantId = null;
        assistantDirty = false;
        const converted = convertUpdate(update, sessionId, toolNames);
        if (converted) yield converted;
      }
      if (thinkingDirty && thinkingText) {
        yield thinkingMessage(sessionId, thinkingId, thinkingText);
        thinkingDirty = false;
      }
      if (
        assistantDirty &&
        assistantText &&
        !cursorStreamError(assistantText)
      ) {
        yield assistantMessage(sessionId, assistantId, assistantText, true);
        assistantDirty = false;
      }
    }

    if (thinkingDirty && thinkingText) {
      yield thinkingMessage(sessionId, thinkingId, thinkingText);
    }
    if (assistantText && !cursorStreamError(assistantText)) {
      yield assistantMessage(sessionId, assistantId, assistantText);
    }

    try {
      const result = await promptPromise;
      const failure = streamFailure ?? cursorStreamError(assistantText);
      if (failure) {
        log.warn(
          {
            event: "cursor_prompt_failed",
            sessionId,
            errorCode: failure.code,
            stopReason: result.stopReason,
          },
          "Cursor returned a backend error in its response text",
        );
        yield {
          type: "error",
          session_id: sessionId,
          error: failure.message,
          errorCode: failure.code,
        } as SDKMessage;
      }
      if (result.stopReason === "refusal") {
        yield {
          type: "error",
          session_id: sessionId,
          error: "Cursor refused the request.",
          errorCode: "cursor.acp.refusal",
        } as SDKMessage;
      }
      if (!signal.aborted)
        yield {
          type: "result",
          session_id: sessionId,
          turnStatus:
            result.stopReason === "cancelled"
              ? "interrupted"
              : result.stopReason === "refusal" || failure
                ? "failed"
                : "completed",
          ...(result.stopReason === "refusal" || failure
            ? { is_error: true }
            : {}),
        } as SDKMessage;
    } catch (error) {
      if (signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      yield { type: "error", error: message } as SDKMessage;
      yield {
        type: "result",
        session_id: sessionId,
        turnStatus: "failed",
        is_error: true,
      } as SDKMessage;
    }
  }

  private async handleExtensionRequest(
    method: string,
    params: Record<string, unknown>,
    options: StartSessionOptions,
    signal: AbortSignal,
    sideMessages: SDKMessage[],
    toolNames: Map<string, string>,
    sessionId: () => string,
  ): Promise<Record<string, unknown>> {
    const name = method.replace(/^_/, "");
    const cancelled = { outcome: { outcome: "cancelled" } };
    if (signal.aborted) return cancelled;
    const displayed = cursorExtensionMessages(
      name,
      params,
      sessionId(),
      toolNames,
    );
    if (displayed.length) sideMessages.push(...displayed);
    if (name === "cursor/ask_question") {
      if (!options.onToolApproval || !Array.isArray(params.questions))
        return cancelled;
      const questions = params.questions.flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const question = value as Record<string, unknown>;
        if (
          typeof question.id !== "string" ||
          typeof question.prompt !== "string" ||
          !Array.isArray(question.options)
        )
          return [];
        return [
          {
            id: question.id,
            question: question.prompt,
            header: typeof params.title === "string" ? params.title : "",
            options: question.options.flatMap((value) => {
              if (!value || typeof value !== "object") return [];
              const option = value as Record<string, unknown>;
              return typeof option.id === "string" &&
                typeof option.label === "string"
                ? [{ label: option.label, value: option.id, description: "" }]
                : [];
            }),
            multiSelect: question.allowMultiple === true,
            custom: false,
            required: true,
          },
        ];
      });
      if (!questions.length || questions.some((q) => !q.options.length))
        return cancelled;
      const result = await options.onToolApproval(
        "AskUserQuestion",
        { questions },
        { signal, respectProviderDecision: true },
      );
      if (result.behavior !== "allow") return cancelled;
      const updated = result.updatedInput as
        | { answers?: Record<string, unknown> }
        | undefined;
      const answers = questions.map((question) => {
        const value = updated?.answers?.[question.id];
        const values = Array.isArray(value) ? value : [value];
        const selectedOptionIds = question.options
          .filter((o) => values.includes(o.value))
          .map((o) => o.value);
        return { questionId: question.id, selectedOptionIds };
      });
      if (
        answers.some(
          (answer, i) =>
            !answer.selectedOptionIds.length ||
            (!questions[i]?.multiSelect && answer.selectedOptionIds.length > 1),
        )
      )
        return cancelled;
      return { outcome: { outcome: "answered", answers } };
    }
    if (name === "cursor/create_plan") {
      if (!options.onToolApproval || typeof params.plan !== "string")
        return cancelled;
      const result = await options.onToolApproval(
        "ExitPlanMode",
        {
          plan: params.plan,
          name: params.name,
          overview: params.overview,
        },
        { signal, respectProviderDecision: true },
      );
      return {
        outcome:
          result.behavior === "allow"
            ? { outcome: "accepted" }
            : {
                outcome: "rejected",
                reason: result.message ?? "Plan rejected",
              },
      };
    }
    if (name === "cursor/update_todos")
      return { outcome: { outcome: "accepted", todos: params.todos ?? [] } };
    if (name === "cursor/task")
      return { outcome: { outcome: "completed", agentId: params.agentId } };
    if (name === "cursor/generate_image")
      return { outcome: { outcome: "generated", filePath: params.filePath } };
    throw new Error(`Unsupported Cursor extension: ${method}`);
  }

  private async handlePermissionRequest(
    request: RequestPermissionRequest,
    options: StartSessionOptions,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    if (!options.onToolApproval) {
      return { outcome: { outcome: "cancelled" } };
    }
    const toolCall = request.toolCall;
    const input: Record<string, unknown> = {
      ...(toolCall.rawInput && typeof toolCall.rawInput === "object"
        ? toolCall.rawInput
        : {}),
      kind: toolCall.kind,
      title: toolCall.title,
      rawInput: toolCall.rawInput,
      locations: toolCall.locations,
      approvalKind: "acp_tool_call",
      acpPermissionOptions: request.options.map(({ optionId, name, kind }) => ({
        optionId,
        name,
        kind,
      })),
    };
    // Cursor's native approval request often contains only a formatted title,
    // unlike its tool-call update. Preserve the operation in the approval UI.
    if (
      toolCall.kind === "execute" &&
      typeof input.command !== "string" &&
      toolCall.title
    ) {
      input.command =
        toolCall.title.startsWith("`") && toolCall.title.endsWith("`")
          ? toolCall.title.slice(1, -1).replaceAll("\\`", "`")
          : toolCall.title;
    }
    if (toolCall.kind !== "execute") input.approvalPrompt = toolCall.title;
    const result = await options.onToolApproval(
      toolNameFromUpdate(toolCall),
      input,
      {
        signal,
        requestMethod: "session/request_permission",
        respectProviderDecision: options.permissionMode !== "bypassPermissions",
      },
    );
    return approvalToAcp(result, request);
  }
}

function assistantMessage(
  sessionId: string,
  uuid: string | null,
  text: string,
  streaming = false,
): SDKMessage {
  return {
    type: "assistant",
    uuid: uuid ?? randomUUID(),
    session_id: sessionId,
    _isStreaming: streaming,
    message: { role: "assistant", content: text },
  } as SDKMessage;
}

function thinkingMessage(
  sessionId: string,
  uuid: string | null,
  thinking: string,
): SDKMessage {
  return {
    type: "assistant",
    uuid: uuid ?? randomUUID(),
    session_id: sessionId,
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking }],
    },
  } as SDKMessage;
}

function cursorTodos(value: unknown): Array<{
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
}> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const todo = item as { content?: unknown; status?: unknown };
    if (typeof todo.content !== "string" || !todo.content.trim()) return [];
    const status =
      todo.status === "in_progress" || todo.status === "completed"
        ? todo.status
        : "pending";
    return [{ content: todo.content, status, activeForm: todo.content }];
  });
}

function cursorToolMessage(
  sessionId: string,
  toolCallId: string,
  name: string,
  input: Record<string, unknown>,
  result?: unknown,
): SDKMessage {
  return {
    type: "assistant",
    uuid: `cursor-tool-${toolCallId}`,
    session_id: sessionId,
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", id: toolCallId, name, input },
        ...(result === undefined
          ? []
          : [
              { type: "tool_result", tool_use_id: toolCallId, content: result },
            ]),
      ],
    },
  } as SDKMessage;
}

/**
 * Cursor sends these after the work is done and ignores the response.
 * Map them onto the existing tool cards, keyed by the same toolCallId the
 * generic tool_call update uses, so the two don't both stay on screen.
 */
function cursorExtensionMessages(
  method: string,
  params: Record<string, unknown>,
  sessionId: string,
  toolNames: Map<string, string>,
): SDKMessage[] {
  const toolCallId =
    typeof params.toolCallId === "string" ? params.toolCallId : "";
  if (!toolCallId) return [];
  if (method === "cursor/update_todos") {
    const todos = cursorTodos(params.todos);
    toolNames.set(toolCallId, "TodoWrite");
    return [
      cursorToolMessage(
        sessionId,
        toolCallId,
        "TodoWrite",
        { todos, merge: params.merge === true },
        { oldTodos: [], newTodos: todos },
      ),
    ];
  }
  if (method === "cursor/task") {
    const description =
      typeof params.description === "string" ? params.description : "";
    const prompt = typeof params.prompt === "string" ? params.prompt : "";
    const subagentType =
      typeof params.subagentType === "string" ? params.subagentType : "task";
    const model = typeof params.model === "string" ? params.model : undefined;
    const durationMs =
      typeof params.durationMs === "number" ? params.durationMs : undefined;
    const detail = [
      description,
      prompt,
      model ? `Model: ${model}` : "",
      durationMs !== undefined ? `Duration: ${Math.round(durationMs)}ms` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    toolNames.set(toolCallId, "Task");
    return [
      cursorToolMessage(
        sessionId,
        toolCallId,
        "Task",
        {
          description: description || prompt || "Task",
          prompt,
          subagent_type: subagentType,
          ...(model ? { model } : {}),
        },
        {
          status: "completed",
          prompt,
          totalDurationMs: durationMs ?? 0,
          totalTokens: 0,
          totalToolUseCount: 0,
          content: detail ? [{ type: "text", text: detail }] : [],
        },
      ),
    ];
  }
  if (method === "cursor/generate_image") {
    const filePath = typeof params.filePath === "string" ? params.filePath : "";
    const description =
      typeof params.description === "string" ? params.description : "";
    toolNames.set(toolCallId, "ViewImage");
    return [
      cursorToolMessage(
        sessionId,
        toolCallId,
        "ViewImage",
        {
          ...(filePath ? { path: filePath } : {}),
          ...(description ? { title: description } : {}),
        },
        filePath || description,
      ),
    ];
  }
  return [];
}

function convertUpdate(
  update: SessionUpdate,
  sessionId: string,
  toolNames: Map<string, string>,
): SDKMessage | null {
  const toolCallId =
    "toolCallId" in update && typeof update.toolCallId === "string"
      ? update.toolCallId
      : undefined;
  if (
    toolCallId &&
    STRUCTURED_CURSOR_TOOLS.has(toolNames.get(toolCallId) ?? "")
  ) {
    // A notification already published this call as TodoWrite, Task, or
    // ViewImage. A later generic tool_call would replace that card.
    return null;
  }
  if (
    update.sessionUpdate === "tool_call" ||
    (update.sessionUpdate === "tool_call_update" &&
      update.rawInput !== undefined &&
      update.status !== "completed" &&
      update.status !== "failed")
  ) {
    const rawInput =
      update.rawInput && typeof update.rawInput === "object"
        ? update.rawInput
        : {};
    const name =
      update.sessionUpdate === "tool_call"
        ? toolNameFromUpdate(update)
        : (toolNames.get(update.toolCallId) ?? toolNameFromUpdate(update));
    toolNames.set(update.toolCallId, name);
    const input = withCanonicalFilePath(
      { ...rawInput } as Record<string, unknown>,
      update.locations,
    );
    return {
      type: "assistant",
      uuid: `cursor-tool-${update.toolCallId}`,
      session_id: sessionId,
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: update.toolCallId,
            name,
            input,
          },
        ],
      },
    } as SDKMessage;
  }
  if (
    update.sessionUpdate === "tool_call_update" &&
    (update.status === "completed" || update.status === "failed")
  ) {
    const raw = update.rawOutput as
      | { exitCode?: unknown; isError?: unknown }
      | undefined;
    const failed =
      update.status === "failed" ||
      raw?.isError === true ||
      (typeof raw?.exitCode === "number" && raw.exitCode !== 0);
    return {
      type: "user",
      uuid: randomUUID(),
      session_id: sessionId,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: update.toolCallId,
            content: toolResultText(update),
            ...(failed ? { is_error: true } : {}),
          },
        ],
      },
    } as SDKMessage;
  }
  return null;
}

function approvalToAcp(
  result: ToolApprovalResult,
  request: RequestPermissionRequest,
): RequestPermissionResponse {
  return selectPermissionOption(
    request,
    result.behavior === "allow",
    result.approvalScope === "always",
  );
}

export const cursorProvider = new CursorProvider();
