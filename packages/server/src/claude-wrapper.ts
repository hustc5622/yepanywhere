import * as path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { type Interface, createInterface } from "node:readline/promises";
import type {
  UserQuestionAnswer,
  UserQuestionAnswers,
} from "@yep-anywhere/shared";

type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "auto";

type InputResponse = "approve" | "approve_accept_edits" | "deny";

interface ClaudeWrapperOptions {
  serverUrl: string;
  desktopToken?: string;
  cwd: string;
  prompt?: string;
  resumeSessionId?: string;
  mode?: PermissionMode;
  model?: string;
  pollIntervalMs: number;
}

interface ApiError extends Error {
  status?: number;
  body?: unknown;
}

interface StartSessionResponse {
  sessionId?: string;
  processId?: string;
  queued?: boolean;
  queueId?: string;
  position?: number;
}

interface QueueMessageResponse {
  queued: boolean;
  restarted?: boolean;
  processId?: string;
}

interface ProcessInfoResponse {
  process: { id: string; state: string } | null;
}

interface SessionDetailResponse {
  messages: SessionMessage[];
  ownership?: {
    owner: "self" | "external" | "none";
    state?: string;
  };
  pendingInputRequest?: InputRequest | null;
}

interface SessionMessage {
  id?: string;
  uuid?: string;
  type?: string;
  role?: string;
  content?: string | ContentBlock[];
  message?: {
    role?: string;
    content?: string | ContentBlock[];
  };
  timestamp?: string;
}

interface ContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
}

interface InputRequest {
  id: string;
  sessionId: string;
  type: "tool-approval" | "question" | "choice";
  prompt: string;
  options?: string[];
  toolName?: string;
  toolInput?: unknown;
  timestamp: string;
  source?: string;
}

interface AskUserQuestionInput {
  questions?: Question[];
}

interface Question {
  id?: string;
  question?: string;
  header?: string;
  options?: Array<{ label?: string; description?: string } | string>;
  multiSelect?: boolean;
  custom?: boolean;
}

interface ParsedArgs {
  options: ClaudeWrapperOptions;
}

const DEFAULT_SERVER_URL = "http://127.0.0.1:3400";
const DEFAULT_POLL_INTERVAL_MS = 1000;

export function parseClaudeWrapperArgs(args: string[]): ParsedArgs {
  let serverUrl =
    process.env.YEP_SERVER_URL ??
    process.env.YEP_ANYWHERE_SERVER_URL ??
    DEFAULT_SERVER_URL;
  let desktopToken =
    process.env.YEP_DESKTOP_AUTH_TOKEN ?? process.env.DESKTOP_AUTH_TOKEN;
  let cwd = process.cwd();
  let resumeSessionId: string | undefined;
  let mode: PermissionMode | undefined;
  let model: string | undefined;
  let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  const promptParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--help" || arg === "-h") {
      showClaudeWrapperHelp();
      process.exit(0);
    }
    if (arg === "--server") {
      serverUrl = readOptionValue(args, ++i, "--server");
      continue;
    }
    if (arg === "--token") {
      desktopToken = readOptionValue(args, ++i, "--token");
      continue;
    }
    if (arg === "--cwd") {
      cwd = path.resolve(readOptionValue(args, ++i, "--cwd"));
      continue;
    }
    if (arg === "--resume" || arg === "-r") {
      resumeSessionId = readOptionValue(args, ++i, arg);
      continue;
    }
    if (arg === "--mode") {
      const value = readOptionValue(args, ++i, "--mode");
      if (!isPermissionMode(value)) {
        throw new Error(`Invalid --mode value: ${value}`);
      }
      mode = value;
      continue;
    }
    if (arg === "--model") {
      model = readOptionValue(args, ++i, "--model");
      continue;
    }
    if (arg === "--poll") {
      const value = Number.parseInt(readOptionValue(args, ++i, "--poll"), 10);
      if (!Number.isFinite(value) || value < 250) {
        throw new Error("--poll must be at least 250 milliseconds");
      }
      pollIntervalMs = value;
      continue;
    }
    if (arg === "--") {
      promptParts.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown claude option: ${arg}`);
    }
    promptParts.push(arg);
  }

  return {
    options: {
      serverUrl: normalizeServerUrl(serverUrl),
      desktopToken,
      cwd,
      prompt: promptParts.length > 0 ? promptParts.join(" ") : undefined,
      resumeSessionId,
      mode,
      model,
      pollIntervalMs,
    },
  };
}

export function showClaudeWrapperHelp(): void {
  console.log(`
yepanywhere claude - Start or attach to a Yep-managed Claude provider session

USAGE:
  yepanywhere claude [OPTIONS] [prompt]

OPTIONS:
  --server <url>       Yep server URL (default: ${DEFAULT_SERVER_URL})
                       Can include a base path, e.g. http://host:8022/yep
  --token <token>      Desktop auth token for X-Desktop-Token
                       Env: YEP_DESKTOP_AUTH_TOKEN or DESKTOP_AUTH_TOKEN
  --cwd <path>         Project directory (default: current directory)
  --resume, -r <id>    Resume an existing Claude session
  --mode <mode>        Permission mode: default, acceptEdits,
                       bypassPermissions, plan, auto
  --model <model>      Claude model or alias
  --poll <ms>          Poll interval in milliseconds (default: 1000)
  --help, -h           Show this help

EXAMPLES:
  yepanywhere claude "fix the failing tests"
  yepanywhere claude --server http://127.0.0.1:8022/yep
  yepanywhere claude --resume <session-id>
`);
}

export async function runClaudeWrapper(args: string[]): Promise<void> {
  const { options } = parseClaudeWrapperArgs(args);
  const client = new YepApiClient(options.serverUrl, options.desktopToken);
  const rl = createInterface({ input, output });
  const seenMessageIds = new Set<string>();
  let sessionId = options.resumeSessionId;
  let projectId = encodeProjectId(options.cwd);
  let lastPendingInputId: string | null = null;

  try {
    console.log(`Yep server: ${options.serverUrl}`);
    console.log(`Project: ${options.cwd}`);

    let initialPrompt = options.prompt;
    if (!sessionId && !initialPrompt) {
      initialPrompt = await askRequiredLine(rl, "You: ");
    }

    if (initialPrompt) {
      const started = sessionId
        ? await client.resumeSession(projectId, sessionId, initialPrompt, {
            mode: options.mode,
            model: options.model,
          })
        : await client.startSession(projectId, initialPrompt, {
            mode: options.mode,
            model: options.model,
          });
      if (started.queued) {
        const position =
          typeof started.position === "number"
            ? ` at position ${started.position}`
            : "";
        if (!sessionId) {
          throw new Error(
            `Claude session request was queued${position}. The terminal wrapper cannot attach to newly queued sessions yet.`,
          );
        }
        console.log(`Resume queued${position}. Waiting for the process...`);
      }
      sessionId = sessionId ?? started.sessionId;
      console.log(`Session: ${sessionId}`);
    } else {
      console.log(`Session: ${sessionId}`);
    }

    if (!sessionId) {
      throw new Error("No session id available");
    }

    process.on("SIGINT", () => {
      console.log(
        "\nDetached. The Yep-managed Claude process is still running.",
      );
      rl.close();
      process.exit(0);
    });

    while (true) {
      let detail: SessionDetailResponse;
      try {
        detail = await client.getSession(projectId, sessionId);
      } catch (error) {
        if (isApiError(error) && error.status === 404) {
          const recoveredProjectId = encodeProjectId(options.cwd);
          if (recoveredProjectId !== projectId) {
            projectId = recoveredProjectId;
            detail = await client.getSession(projectId, sessionId);
          } else {
            throw error;
          }
        } else {
          throw error;
        }
      }

      renderNewMessages(detail.messages, seenMessageIds);

      const pending = detail.pendingInputRequest ?? null;
      if (pending && pending.id !== lastPendingInputId) {
        lastPendingInputId = pending.id;
        await answerPendingInput(client, rl, sessionId, pending);
        await delay(250);
        continue;
      }
      if (!pending) {
        lastPendingInputId = null;
      }

      const processInfo = await client.getProcessInfo(sessionId);
      const canPrompt =
        detail.ownership?.owner === "none" ||
        (detail.ownership?.owner === "self" &&
          processInfo.process?.state === "idle");
      if (canPrompt) {
        const next = await askOptionalLine(rl, "You: ");
        if (next === null) {
          await delay(options.pollIntervalMs);
          continue;
        }
        const trimmed = next.trim();
        if (!trimmed) continue;
        if (trimmed === "/exit" || trimmed === "/quit") {
          console.log(
            "Detached. The Yep-managed Claude process is still running.",
          );
          return;
        }
        await sendMessageToSession(client, projectId, sessionId, trimmed, {
          mode: options.mode,
          model: options.model,
        });
        continue;
      }

      await delay(options.pollIntervalMs);
    }
  } finally {
    rl.close();
  }
}

interface ClaudeSessionClient {
  kind: "direct" | "bridge";
  url: string;
  startSession(
    projectId: string,
    message: string,
    options: { mode?: PermissionMode; model?: string },
  ): Promise<StartSessionResponse>;
  resumeSession(
    projectId: string,
    sessionId: string,
    message: string,
    options: { mode?: PermissionMode; model?: string },
  ): Promise<StartSessionResponse>;
  getSession(
    projectId: string,
    sessionId: string,
  ): Promise<SessionDetailResponse>;
  getProcessInfo(sessionId: string): Promise<ProcessInfoResponse>;
  queueMessage(
    sessionId: string,
    message: string,
    options: { mode?: PermissionMode; model?: string },
  ): Promise<QueueMessageResponse>;
  respondToInput(
    sessionId: string,
    requestId: string,
    response: InputResponse,
    answers?: UserQuestionAnswers,
    feedback?: string,
  ): Promise<{ accepted: boolean }>;
}

class YepApiClient implements ClaudeSessionClient {
  readonly kind = "direct" as const;
  readonly url: string;

  constructor(
    private readonly serverUrl: string,
    private readonly desktopToken: string | undefined,
  ) {
    this.url = serverUrl;
  }

  startSession(
    projectId: string,
    message: string,
    options: { mode?: PermissionMode; model?: string },
  ): Promise<StartSessionResponse> {
    return this.request(`/api/projects/${projectId}/sessions`, {
      method: "POST",
      body: {
        message,
        mode: options.mode,
        model: options.model,
        provider: "claude",
      },
    });
  }

  async resumeSession(
    projectId: string,
    sessionId: string,
    message: string,
    options: { mode?: PermissionMode; model?: string },
  ): Promise<StartSessionResponse> {
    const response = await this.request<
      StartSessionResponse & {
        permissionMode?: PermissionMode;
        modeVersion?: number;
      }
    >(`/api/projects/${projectId}/sessions/${sessionId}/resume`, {
      method: "POST",
      body: {
        message,
        mode: options.mode,
        model: options.model,
        provider: "claude",
      },
    });
    return { ...response, sessionId };
  }

  getSession(
    projectId: string,
    sessionId: string,
  ): Promise<SessionDetailResponse> {
    return this.request(`/api/projects/${projectId}/sessions/${sessionId}`);
  }

  getProcessInfo(sessionId: string): Promise<ProcessInfoResponse> {
    return this.request(`/api/sessions/${sessionId}/process`);
  }

  queueMessage(
    sessionId: string,
    message: string,
    options: { mode?: PermissionMode; model?: string },
  ): Promise<QueueMessageResponse> {
    return this.request(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      body: {
        message,
        mode: options.mode,
        model: options.model,
        provider: "claude",
      },
    });
  }

  respondToInput(
    sessionId: string,
    requestId: string,
    response: InputResponse,
    answers?: UserQuestionAnswers,
    feedback?: string,
  ): Promise<{ accepted: boolean }> {
    return this.request(`/api/sessions/${sessionId}/input`, {
      method: "POST",
      body: { requestId, response, answers, feedback },
    });
  }

  private async request<T>(
    pathname: string,
    init?: { method?: string; body?: unknown },
  ): Promise<T> {
    const response = await fetch(`${this.serverUrl}${pathname}`, {
      method: init?.method ?? "GET",
      headers: {
        "content-type": "application/json",
        "x-yep-anywhere": "true",
        ...(this.desktopToken ? { "x-desktop-token": this.desktopToken } : {}),
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });

    if (!response.ok) {
      const body = await readResponseBody(response);
      const error = new Error(
        formatApiError(response.status, body),
      ) as ApiError;
      error.status = response.status;
      error.body = body;
      throw error;
    }

    return (await response.json()) as T;
  }
}

async function sendMessageToSession(
  client: ClaudeSessionClient,
  projectId: string,
  sessionId: string,
  message: string,
  options: { mode?: PermissionMode; model?: string },
): Promise<void> {
  const processInfo = await client.getProcessInfo(sessionId);
  if (processInfo.process) {
    await client.queueMessage(sessionId, message, options);
    return;
  }
  await client.resumeSession(projectId, sessionId, message, options);
}

async function answerPendingInput(
  client: ClaudeSessionClient,
  rl: Interface,
  sessionId: string,
  request: InputRequest,
): Promise<void> {
  console.log("");
  if (request.source === "persisted") {
    console.log("Claude is waiting in an external terminal. Answer there.");
    return;
  }

  if (request.toolName === "AskUserQuestion" || request.type === "question") {
    const answers = await askQuestionAnswers(rl, request);
    await client.respondToInput(sessionId, request.id, "approve", answers);
    console.log("Answered.");
    return;
  }

  console.log(`Approval requested: ${request.toolName ?? request.type}`);
  console.log(request.prompt);
  const command = extractCommand(request.toolInput);
  if (command) console.log(`Command: ${command}`);

  while (true) {
    const choice = await askRequiredLine(
      rl,
      "Approve? [y]es/[e]dit-mode/[n]o/[f]eedback: ",
    );
    const normalized = choice.trim().toLowerCase();
    if (
      normalized === "y" ||
      normalized === "yes" ||
      normalized === "approve"
    ) {
      await client.respondToInput(sessionId, request.id, "approve");
      console.log("Approved.");
      return;
    }
    if (
      normalized === "e" ||
      normalized === "edit" ||
      normalized === "edits" ||
      normalized === "edit-mode" ||
      normalized === "accept-edits" ||
      normalized === "acceptedits"
    ) {
      await client.respondToInput(
        sessionId,
        request.id,
        "approve_accept_edits",
      );
      console.log("Approved and switched to acceptEdits.");
      return;
    }
    if (normalized === "f" || normalized === "feedback") {
      const feedback = await askRequiredLine(rl, "Feedback: ");
      await client.respondToInput(
        sessionId,
        request.id,
        "deny",
        undefined,
        feedback,
      );
      console.log("Denied with feedback.");
      return;
    }
    if (normalized === "n" || normalized === "no" || normalized === "deny") {
      await client.respondToInput(sessionId, request.id, "deny");
      console.log("Denied.");
      return;
    }
    console.log("Please enter y, e, n, or f.");
  }
}

async function askQuestionAnswers(
  rl: Interface,
  request: InputRequest,
): Promise<UserQuestionAnswers> {
  const input = asRecord(request.toolInput) as AskUserQuestionInput | null;
  const questions = input?.questions ?? [];
  if (questions.length === 0) {
    const answer = await askRequiredLine(rl, `${request.prompt}: `);
    return { [request.prompt]: answer };
  }

  const answers: UserQuestionAnswers = {};
  for (const question of questions) {
    const prompt = question.question ?? question.header ?? "Question";
    console.log(prompt);
    const options = normalizeQuestionOptions(question.options);
    options.forEach((option, index) => {
      const description = option.description ? ` - ${option.description}` : "";
      console.log(`  ${index + 1}. ${option.label}${description}`);
    });
    const suffix = question.multiSelect
      ? "Choice(s), comma-separated numbers or text: "
      : "Choice number or text: ";
    const answer = await askRequiredLine(rl, suffix);
    answers[question.id ?? prompt] = parseQuestionAnswer(
      answer,
      options,
      !!question.multiSelect,
    );
  }
  return answers;
}

export function parseQuestionAnswer(
  raw: string,
  options: Array<{ label: string; description?: string }>,
  multiSelect: boolean,
): UserQuestionAnswer {
  const trimmed = raw.trim();
  if (!trimmed) return multiSelect ? [] : "";

  const resolvePart = (part: string): string => {
    const normalized = part.trim();
    if (!/^\d+$/.test(normalized)) return normalized;
    const option = options[Number.parseInt(normalized, 10) - 1];
    return option?.label ?? normalized;
  };

  if (multiSelect) {
    return trimmed.split(",").map(resolvePart).filter(Boolean);
  }

  return resolvePart(trimmed);
}

function normalizeQuestionOptions(
  options: Question["options"],
): Array<{ label: string; description?: string }> {
  if (!Array.isArray(options)) return [];
  return options
    .map((option) => {
      if (typeof option === "string") return { label: option };
      if (typeof option?.label === "string") {
        return {
          label: option.label,
          description:
            typeof option.description === "string"
              ? option.description
              : undefined,
        };
      }
      return null;
    })
    .filter(
      (option): option is { label: string; description?: string } => !!option,
    );
}

function renderNewMessages(
  messages: SessionMessage[],
  seenMessageIds: Set<string>,
): void {
  for (const message of messages) {
    const id = getMessageId(message);
    if (!id || seenMessageIds.has(id)) continue;
    seenMessageIds.add(id);

    const rendered = renderMessage(message);
    if (rendered) {
      console.log(rendered);
    }
  }
}

function renderMessage(message: SessionMessage): string | null {
  const role = message.message?.role ?? message.role ?? message.type;
  const content = message.message?.content ?? message.content;
  const text = extractText(content);
  if (role === "user") {
    return text ? `\nYou: ${text}` : null;
  }
  if (role === "assistant") {
    return text ? `\nClaude: ${text}` : renderToolUseSummary(content);
  }
  if (message.type === "system" && text) {
    return `\n[system] ${text}`;
  }
  return null;
}

function extractText(content: string | ContentBlock[] | undefined): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text?.trim())
    .filter((part): part is string => !!part)
    .join("\n");
}

function renderToolUseSummary(
  content: string | ContentBlock[] | undefined,
): string | null {
  if (!Array.isArray(content)) return null;
  const toolUses = content.filter((block) => block.type === "tool_use");
  if (toolUses.length === 0) return null;
  return toolUses
    .map((block) => `\n[tool] ${block.name ?? "Tool"} requested`)
    .join("");
}

function getMessageId(message: SessionMessage): string | null {
  return message.uuid ?? message.id ?? message.timestamp ?? null;
}

function extractCommand(inputValue: unknown): string | null {
  const inputRecord = asRecord(inputValue);
  const command = inputRecord?.command;
  return typeof command === "string" ? command : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

async function askRequiredLine(rl: Interface, prompt: string): Promise<string> {
  while (true) {
    const value = await rl.question(prompt);
    if (value.trim().length > 0) return value;
  }
}

async function askOptionalLine(
  rl: Interface,
  prompt: string,
): Promise<string | null> {
  if (!input.isTTY) return null;
  return rl.question(prompt);
}

function readOptionValue(
  args: string[],
  index: number,
  option: string,
): string {
  const value = args[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function isPermissionMode(value: string): value is PermissionMode {
  return (
    value === "default" ||
    value === "acceptEdits" ||
    value === "bypassPermissions" ||
    value === "plan" ||
    value === "auto"
  );
}

function normalizeServerUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function encodeProjectId(absolutePath: string): string {
  return Buffer.from(path.resolve(absolutePath)).toString("base64url");
}

function isApiError(error: unknown): error is ApiError {
  return error instanceof Error && "status" in error;
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function formatApiError(status: number, body: unknown): string {
  const record = asRecord(body);
  const message = record?.error;
  return typeof message === "string"
    ? `Yep API error ${status}: ${message}`
    : `Yep API error ${status}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
