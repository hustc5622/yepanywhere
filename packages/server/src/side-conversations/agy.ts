/**
 * Antigravity (`agy`) side conversations.
 *
 * agy has no ACP fork or ephemeral session, so a side conversation runs in
 * an `agy acp` process of its own: with the main context, its embedded
 * language server forks the parent conversation at the newest finished turn
 * (`ForkConversation`) and the copy is resumed; without it, a new session
 * starts. Both carry the side boundary through agy's
 * `_meta.antigravity.systemPrompt.append`. The parent process is never
 * touched, so a running main turn keeps going.
 *
 * Read-only is enforced on agy's approval path, like agy's own `/btw`:
 * `read_file` runs without approval, a shell command is approved only when
 * it is a plain read-only command, and every other request is declined.
 * Settings that let agy skip approvals refuse the side conversation.
 *
 * The temporary conversation is hidden from Yep's lists through the
 * registry, and deleted through the language server when the side ends.
 * See docs/project/antigravity.md.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ContentBlock,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import type { SideConversationBlock } from "@yep-anywhere/shared";
import { getLogger } from "../logging/logger.js";
import { ACPClient } from "../sdk/providers/acp/client.js";
import {
  AGY_AUTH_REQUIRED_MESSAGE,
  agyNativeToolName,
  agyToolRawInput,
  agyToolResultText,
  applyAgyModel,
  isAgyAuthRequiredError,
  recordAgyToolNames,
  selectAgyConfigValues,
} from "../sdk/providers/agy-acp-tools.js";
import {
  type AgyLanguageServer,
  callAgyLanguageServer,
  waitForAgyLanguageServerPort,
} from "../sdk/providers/agy-fork.js";
import {
  AGY_MODEL_CONFIG_ID,
  AGY_THOUGHT_CONFIG_ID,
} from "../sdk/providers/agy-models.js";
import { resolveAgyDataDir } from "../sessions/agy-store.js";
import {
  canonicalizeAgyToolName,
  normalizeAgyToolArguments,
} from "../sessions/agy-tools.js";
import {
  type AgySideSessionRegistry,
  getAgySideSessionRegistry,
} from "./agy-registry.js";
import type { SideImage } from "./attachments.js";
import {
  SIDE_BOUNDARY,
  type SideEvent,
  type SideTransport,
} from "./session.js";

const CREATE_TIMEOUT_MS = 60_000;
const LS_TIMEOUT_MS = 15_000;
const CLOSE_STEP_TIMEOUT_MS = 3_000;
/** agy can resolve a prompt shortly before its last chunks arrive. */
const SETTLE_QUIET_MS = 400;
const SETTLE_MAX_MS = 2_000;
const MAX_FORK_ATTEMPTS = 3;
const MAX_REFERENCE_CHARS = 6_000;

/** agy tools that only read local files. */
export const AGY_SIDE_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "view_file",
  "read_resource",
  "list_dir",
  "find_by_name",
  "grep_search",
]);

/**
 * Tools that change files, run work, reach other agents or schedule
 * prompts. They must never complete without Yep's approval; a completion
 * means a permission rule bypassed it.
 */
const AGY_SIDE_MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "run_command",
  "write_file",
  "write_to_file",
  "edit_file",
  "replace_file_content",
  "multi_replace_file_content",
  "sed_file",
  "call_mcp_tool",
]);

/**
 * Tools agy runs without an approval in its default preset, which reach
 * beyond this conversation (subagents, other conversations, timers,
 * workflows). The side turn is stopped as soon as one starts.
 */
const AGY_SIDE_FORBIDDEN_TOOLS: ReadonlySet<string> = new Set([
  "invoke_subagent",
  "define_subagent",
  "manage_subagents",
  "send_message",
  "schedule",
  "manage_task",
  "run_workflow",
  "swarm_manage",
  "swarm_post_message",
  "swarm_read_board",
  "swarm_wait",
]);

export const AGY_SIDE_TOOL_POLICY =
  "Tools in this side conversation: you may read files with read_file and run plain read-only shell commands (rg, grep, find without actions, ls, cat, head, tail, wc, sed -n line ranges, git status/log/show/diff/blame). Every other tool call (editing or writing files, other commands, web search or fetch, MCP tools, subagents, messages, schedules, tasks or workflows) is declined and ends your reply, so answer from what you can read.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Read-only shell commands

type ShellToken = { op: false; value: string } | { op: true; value: string };

/**
 * Split a command line like POSIX sh would, or null for anything beyond
 * plain words, quotes and `|`, `||`, `&&`, `;`: expansions, substitutions,
 * redirections (except discarding output), subshells, background jobs.
 */
export function tokenizeAgyShellCommand(line: string): ShellToken[] | null {
  const tokens: ShellToken[] = [];
  let word = "";
  let inWord = false;
  const flush = () => {
    if (inWord) tokens.push({ op: false, value: word });
    word = "";
    inWord = false;
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) return null;
      word += line.slice(i + 1, end);
      inWord = true;
      i = end;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      for (; j < line.length && line[j] !== '"'; j++) {
        const d = line[j] as string;
        if (d === "$" || d === "`") return null;
        if (d === "\\") {
          const next = line[j + 1];
          if (next === undefined) return null;
          word += next;
          j++;
          continue;
        }
        word += d;
      }
      if (j >= line.length) return null;
      inWord = true;
      i = j;
      continue;
    }
    if (c === "\\") {
      const next = line[i + 1];
      if (next === undefined || next === "\n") return null;
      word += next;
      inWord = true;
      i++;
      continue;
    }
    if (c === " " || c === "\t") {
      flush();
      continue;
    }
    if (c === ">") {
      // Discarding output is harmless: `2>/dev/null`, `>/dev/null`, `2>&1`.
      const fd = inWord && (word === "2" || word === "1") ? word : null;
      if (inWord && !fd) return null;
      const rest = line.slice(i + 1);
      const target = rest.startsWith("/dev/null")
        ? "/dev/null"
        : rest.startsWith("&1") && fd === "2"
          ? "&1"
          : null;
      if (!target) return null;
      word = "";
      inWord = false;
      i += target.length;
      const after = line[i + 1];
      if (after !== undefined && after !== " " && after !== "\t") return null;
      continue;
    }
    if (c === "|" || c === "&" || c === ";") {
      flush();
      const pair = line.slice(i, i + 2);
      if (pair === "||" || pair === "&&") {
        tokens.push({ op: true, value: pair });
        i++;
      } else if (c === "&") {
        return null;
      } else {
        tokens.push({ op: true, value: c });
      }
      continue;
    }
    if ("<`$(){}\n\r!#".includes(c)) return null;
    word += c;
    inWord = true;
  }
  flush();
  return tokens;
}

const PLAIN_READ_COMMANDS = new Set([
  "cat",
  "cd",
  "cmp",
  "comm",
  "cut",
  "diff",
  "dirname",
  "basename",
  "du",
  "echo",
  "egrep",
  "fgrep",
  "grep",
  "head",
  "jq",
  "ls",
  "md5",
  "md5sum",
  "nl",
  "printf",
  "pwd",
  "readlink",
  "realpath",
  "sha1sum",
  "sha256sum",
  "shasum",
  "strings",
  "tr",
  "true",
  "wc",
  "which",
]);

const GIT_READ_SUBCOMMANDS = new Set([
  "blame",
  "cat-file",
  "describe",
  "diff",
  "grep",
  "log",
  "ls-files",
  "ls-tree",
  "rev-parse",
  "shortlog",
  "show",
  "show-ref",
  "status",
]);

/** Options that write files or run programs, per command. */
function hasOption(args: readonly string[], names: readonly string[]): boolean {
  return args.some((arg) =>
    names.some((name) =>
      name.startsWith("--")
        ? arg === name || arg.startsWith(`${name}=`)
        : arg === name ||
          (/^-[a-zA-Z]+$/.test(arg) &&
            !arg.startsWith("--") &&
            arg.includes(name.slice(1))),
    ),
  );
}

function isReadOnlyGit(args: readonly string[]): boolean {
  let index = 0;
  // Only harmless global options before the subcommand.
  while (index < args.length && args[index]?.startsWith("-")) {
    const arg = args[index];
    if (arg === "--no-pager") index++;
    else if (arg === "-C" && args[index + 1]) index += 2;
    else return false;
  }
  const sub = args[index];
  const rest = args.slice(index + 1);
  if (
    rest.some(
      (arg) =>
        arg === "-o" ||
        arg === "-O" ||
        arg.startsWith("--output") ||
        arg.startsWith("--open-files-in-pager") ||
        arg === "--ext-diff",
    )
  )
    return false;
  if (sub && GIT_READ_SUBCOMMANDS.has(sub)) return true;
  const only = (allowed: readonly string[]) =>
    rest.every((arg) => allowed.includes(arg));
  if (sub === "branch")
    return only([
      "-a",
      "-r",
      "-v",
      "-vv",
      "--all",
      "--remotes",
      "--list",
      "--show-current",
      "--verbose",
    ]);
  if (sub === "remote") return only(["-v", "--verbose"]);
  if (sub === "tag") return only(["-l", "--list"]);
  if (sub === "stash") return rest[0] === "list";
  return false;
}

function positionalCount(args: readonly string[]): number {
  return args.filter((arg) => !arg.startsWith("-")).length;
}

function isReadOnlySegment(words: readonly string[]): boolean {
  const [program, ...args] = words;
  if (!program || program.includes("/") || program.includes("=")) return false;
  if (PLAIN_READ_COMMANDS.has(program)) return true;
  switch (program) {
    case "tail":
      return !hasOption(args, ["-f", "-F", "--follow"]);
    case "sort":
      return !hasOption(args, ["-o", "--output", "--compress-program"]);
    case "uniq":
      // The second operand is an output file.
      return positionalCount(args) <= 1;
    case "tree":
      return !hasOption(args, ["-o"]);
    case "rg":
      return !hasOption(args, ["--pre", "--pre-glob", "--hostname-bin"]);
    case "fd":
      return !hasOption(args, ["-x", "-X", "--exec", "--exec-batch"]);
    case "find":
      return !args.some((arg) =>
        [
          "-exec",
          "-execdir",
          "-ok",
          "-okdir",
          "-delete",
          "-fprint",
          "-fprint0",
          "-fprintf",
          "-fls",
        ].includes(arg),
      );
    case "sed": {
      // Only `sed -n '<lines>p' file…`: printing line ranges.
      const options = args.filter((arg) => arg.startsWith("-"));
      const operands = args.filter((arg) => !arg.startsWith("-"));
      const range = String.raw`(?:\d+|\$)(?:,(?:\d+|\$))?p`;
      return (
        options.includes("-n") &&
        options.every((arg) => ["-n", "-E", "-r"].includes(arg)) &&
        new RegExp(`^${range}(?:;${range})*$`).test(operands[0] ?? "")
      );
    }
    case "git":
      return isReadOnlyGit(args);
    default:
      return false;
  }
}

/** A plain pipeline or list of read-only commands, nothing else. */
export function isAgySideReadOnlyCommand(commandLine: unknown): boolean {
  if (typeof commandLine !== "string" || !commandLine.trim()) return false;
  const tokens = tokenizeAgyShellCommand(commandLine.trim());
  if (!tokens || tokens.length === 0) return false;
  let segment: string[] = [];
  const segments: string[][] = [];
  for (const token of tokens) {
    if (token.op) {
      if (segment.length === 0) return false;
      segments.push(segment);
      segment = [];
    } else segment.push(token.value);
  }
  if (segment.length === 0) return false;
  segments.push(segment);
  return segments.every(isReadOnlySegment);
}

/** Whether a side conversation may run `nativeName` with `rawInput`. */
export function allowAgySideTool(
  nativeName: string,
  rawInput: unknown,
): boolean {
  if (AGY_SIDE_READ_ONLY_TOOLS.has(nativeName)) return true;
  if (nativeName === "run_command") {
    return isRecord(rawInput) && isAgySideReadOnlyCommand(rawInput.CommandLine);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Settings that bypass approvals

/**
 * Why agy's own settings would let a side conversation write without
 * asking, or null. Approval is where read-only is enforced.
 */
export function agySideSettingsConflict(settings: unknown): string | null {
  if (!isRecord(settings)) return null;
  const preset = settings.toolPermission;
  if (preset === "always-proceed" || preset === "proceed-in-sandbox") {
    return `Antigravity's toolPermission is "${preset}", so agy runs commands without asking and a side conversation could not stay read-only. Use "request-review" or "strict" in ~/.gemini/antigravity-cli/settings.json, or ask in the main conversation.`;
  }
  const permissions = isRecord(settings.permissions)
    ? settings.permissions
    : undefined;
  const allow = Array.isArray(permissions?.allow) ? permissions.allow : [];
  for (const rule of allow) {
    if (typeof rule !== "string") continue;
    const action = /^\s*([A-Za-z_]+)\s*\(/.exec(rule)?.[1] ?? rule.trim();
    if (!AGY_SIDE_READ_ONLY_TOOLS.has(action)) {
      return `Antigravity's allow rule "${rule}" lets agy run that tool without asking, so a side conversation could not stay read-only. Remove the rule in ~/.gemini/antigravity-cli/settings.json, or ask in the main conversation.`;
    }
  }
  return null;
}

async function readAgySettings(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fork point

export interface AgySideForkPlan {
  /** Fork points to try, newest first. */
  forkAt: number[];
  /** Prompts of the running turn, which the fork does not carry. */
  pendingRequests: string[];
}

function stepKind(step: unknown): string {
  return isRecord(step) && typeof step.type === "string"
    ? step.type.replace(/^CORTEX_STEP_TYPE_/u, "")
    : "";
}

function stepUserText(step: unknown): string {
  if (!isRecord(step) || !isRecord(step.userInput)) return "";
  const input = step.userInput;
  if (typeof input.userResponse === "string") return input.userResponse;
  return Array.isArray(input.items)
    ? input.items
        .flatMap((item) =>
          isRecord(item) && typeof item.text === "string" ? [item.text] : [],
        )
        .join("\n")
    : "";
}

/**
 * Where agy accepts a fork (`GetCascadeTrajectorySteps` order): the end of a
 * turn, i.e. the conversation's tail once agy handed control back, or a step
 * right before a user message. A running turn is not carried; its prompts
 * are returned so the side can still name them.
 */
export function planAgySideFork(steps: readonly unknown[]): AgySideForkPlan {
  const forkAt: number[] = [];
  let tail = steps.length - 1;
  while (tail >= 0 && stepKind(steps[tail]) === "SYSTEM_MESSAGE") tail--;
  const last = steps[tail];
  const lastKind = stepKind(last);
  const done =
    !isRecord(last) ||
    last.status === undefined ||
    last.status === "CORTEX_STEP_STATUS_DONE";
  const toolCalls =
    isRecord(last) &&
    isRecord(last.plannerResponse) &&
    Array.isArray(last.plannerResponse.toolCalls)
      ? last.plannerResponse.toolCalls.length
      : 0;
  const settled =
    tail >= 0 &&
    done &&
    ((lastKind === "PLANNER_RESPONSE" && toolCalls === 0) ||
      lastKind === "ERROR_MESSAGE" ||
      lastKind === "CHECKPOINT");
  if (settled) forkAt.push(steps.length - 1);
  for (
    let index = steps.length - 2;
    index >= 0 && forkAt.length < MAX_FORK_ATTEMPTS;
    index--
  ) {
    if (
      stepKind(steps[index + 1]) === "USER_INPUT" &&
      stepKind(steps[index]) !== "USER_INPUT"
    )
      forkAt.push(index);
  }
  const from = (forkAt[0] ?? -1) + 1;
  const pendingRequests = settled
    ? []
    : steps
        .slice(from)
        .filter((step) => stepKind(step) === "USER_INPUT")
        .map(stepUserText)
        .filter(Boolean);
  return { forkAt, pendingRequests };
}

function referenceText(pending: readonly string[]): string {
  if (pending.length === 0) return "";
  let text = pending.join("\n\n---\n\n");
  if (text.length > MAX_REFERENCE_CHARS)
    text = `${text.slice(0, MAX_REFERENCE_CHARS)}\n…`;
  return `The main task is still working on the request below; its progress is not part of this context. Treat it as reference only:\n\n${text}`;
}

// ---------------------------------------------------------------------------
// Transport

export interface CreateAgySideConversationOptions {
  agyPath: string;
  cwd: string;
  /** Spawn environment (PATH, proxy routing); the CSRF token is added. */
  env: Record<string, string>;
  parentSessionId: string;
  model?: string;
  reasoningEffort?: string;
  context: "snapshot" | "empty";
  emit(event: SideEvent): void;
  /** Test seams. */
  registry?: AgySideSessionRegistry;
  settingsPath?: string;
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

function errorMessage(error: unknown): string {
  if (isAgyAuthRequiredError(error)) return AGY_AUTH_REQUIRED_MESSAGE;
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === "string")
    return error.message;
  return String(error);
}

function permissionOutcome(
  request: RequestPermissionRequest,
  allow: boolean,
): RequestPermissionResponse {
  const option = allow
    ? (request.options.find((entry) => entry.kind === "allow_once") ??
      request.options.find((entry) => entry.kind === "allow_always"))
    : request.options.find(
        (entry) =>
          entry.kind === "reject_once" || entry.kind === "reject_always",
      );
  return option
    ? { outcome: { outcome: "selected", optionId: option.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

function toolLabel(nativeName: string, rawInput: unknown): string {
  if (
    nativeName === "run_command" &&
    isRecord(rawInput) &&
    typeof rawInput.CommandLine === "string"
  ) {
    const command = rawInput.CommandLine.trim();
    return `run_command \`${command.length > 80 ? `${command.slice(0, 80)}…` : command}\``;
  }
  return nativeName;
}

interface AgySideMessage {
  id: string;
  blocks: SideConversationBlock[];
}

interface AgySideTurn {
  declined: Set<string>;
  lastUpdateAt: number;
  violation?: string;
}

export async function createAgySideConversation(
  options: CreateAgySideConversationOptions,
): Promise<SideTransport> {
  const log = getLogger();
  const registry = options.registry ?? getAgySideSessionRegistry();
  const { emit } = options;

  const conflict = agySideSettingsConflict(
    await readAgySettings(
      options.settingsPath ?? join(resolveAgyDataDir(), "settings.json"),
    ),
  );
  if (conflict) throw new Error(conflict);

  const token = randomBytes(24).toString("hex");
  const dir = await mkdtemp(join(tmpdir(), "yep-agy-side-"));
  const logPath = join(dir, "acp.log");
  const client = new ACPClient();
  const names = new Map<string, string>();
  const approved = new Set<string>();
  const tools = new Map<
    string,
    { native: string; messageId: string; inputKey: string; raw: unknown }
  >();
  const messages = new Map<string, AgySideMessage>();
  let current: AgySideMessage | null = null;
  let sideId: string | undefined;
  let server: AgyLanguageServer | undefined;
  let turn: AgySideTurn | null = null;
  let closing: Promise<void> | undefined;
  let firstPrompt = true;
  let preface = "";
  const usage = { inputTokens: 0, outputTokens: 0 };

  const startMessage = (): AgySideMessage => {
    const message: AgySideMessage = { id: randomUUID(), blocks: [] };
    messages.set(message.id, message);
    current = message;
    return message;
  };
  const prose = (kind: "text" | "thinking", text: string) => {
    if (!text) return;
    let message = current;
    if (!message || message.blocks.some((block) => block.type === "tool_use"))
      message = startMessage();
    const last = message.blocks.at(-1);
    if (kind === "text" && last?.type === "text") last.text += text;
    else if (kind === "thinking" && last?.type === "thinking")
      last.thinking += text;
    else
      message.blocks.push(
        kind === "text"
          ? { type: "text", text }
          : { type: "thinking", thinking: text },
      );
    emit({ type: kind, id: message.id, text, append: true });
  };

  const stopTurn = () => {
    if (sideId) void client.cancel(sideId).catch(() => undefined);
  };

  const onTool = (update: Record<string, unknown>) => {
    const toolCallId =
      typeof update.toolCallId === "string" ? update.toolCallId : undefined;
    if (!toolCallId || !turn) return;
    const raw = agyToolRawInput(update);
    let entry = tools.get(toolCallId);
    const isNew = !entry;
    if (!entry) {
      const native = agyNativeToolName(update, names);
      const message = current ?? startMessage();
      entry = { native, messageId: message.id, inputKey: "", raw };
      tools.set(toolCallId, entry);
      if (AGY_SIDE_FORBIDDEN_TOOLS.has(native)) {
        turn.declined.add(toolLabel(native, raw));
        stopTurn();
      }
    }
    const inputKey = raw === undefined ? "" : JSON.stringify(raw);
    if (isNew || (raw !== undefined && inputKey !== entry.inputKey)) {
      entry.inputKey = inputKey;
      if (raw !== undefined) entry.raw = raw;
      const message = messages.get(entry.messageId);
      if (message) {
        const block: SideConversationBlock = {
          type: "tool_use",
          id: toolCallId,
          name: canonicalizeAgyToolName(entry.native, raw),
          input: normalizeAgyToolArguments(entry.native, raw),
        };
        const index = message.blocks.findIndex(
          (candidate) =>
            candidate.type === "tool_use" && candidate.id === toolCallId,
        );
        if (index >= 0) message.blocks[index] = block;
        else message.blocks.push(block);
        emit({
          type: "blocks",
          id: message.id,
          blocks: structuredClone(message.blocks),
        });
      }
    }
    const status = update.status;
    if (status === "completed" || status === "failed") {
      const failed = status === "failed";
      const text = agyToolResultText(update);
      emit({
        type: "tool_result",
        toolUseId: toolCallId,
        content:
          text ||
          (failed ? "Declined: this side conversation is read-only." : ""),
        ...(failed ? { isError: true } : {}),
      });
      // A read-only command agy ran on its own is fine; anything else that
      // changes state completed without Yep's approval.
      if (
        !failed &&
        AGY_SIDE_MUTATING_TOOLS.has(entry.native) &&
        !approved.has(toolCallId) &&
        !allowAgySideTool(entry.native, entry.raw)
      ) {
        turn.violation ??= toolLabel(entry.native, entry.raw);
        stopTurn();
      }
    }
  };

  client.setRawMessageObserver((frame) => recordAgyToolNames(frame, names));
  client.setSessionUpdateCallback((notification: SessionNotification) => {
    if (!sideId || notification.sessionId !== sideId || !turn) return;
    turn.lastUpdateAt = Date.now();
    const update = notification.update;
    if (
      update.sessionUpdate === "agent_message_chunk" &&
      update.content.type === "text"
    )
      prose("text", update.content.text);
    else if (
      update.sessionUpdate === "agent_thought_chunk" &&
      update.content.type === "text"
    )
      prose("thinking", update.content.text);
    else if (
      update.sessionUpdate === "tool_call" ||
      update.sessionUpdate === "tool_call_update"
    )
      onTool(update as unknown as Record<string, unknown>);
  });
  client.setPermissionRequestCallback(async (request) => {
    const native = agyNativeToolName(request.toolCall, names);
    const raw = agyToolRawInput(request.toolCall);
    const allow =
      Boolean(turn) &&
      request.sessionId === sideId &&
      allowAgySideTool(native, raw);
    if (allow) approved.add(request.toolCall.toolCallId);
    else turn?.declined.add(toolLabel(native, raw));
    return permissionOutcome(request, allow);
  });
  // No form elicitation is advertised; decline if agy asks anyway.
  client.setElicitationRequestCallback(async () => ({ action: "decline" }));
  client.setExtensionRequestCallback(async () => ({}));
  client.setExitCallback((code, signal) => {
    if (closing) return;
    emit({
      type: "closed",
      error: `The Antigravity side process exited (${signal ?? `code ${code}`}).`,
    });
  });

  const deleteConversation = async (id: string) => {
    if (!server) {
      registry.release(id);
      return;
    }
    try {
      await callAgyLanguageServer(
        server,
        "DeleteCascadeTrajectory",
        { cascadeId: id },
        AbortSignal.timeout(LS_TIMEOUT_MS),
      );
      await registry.markDeleted(id);
      log.info(
        { event: "agy_side_conversation_deleted", sideSessionId: id },
        "Deleted Antigravity side conversation",
      );
    } catch (error) {
      registry.release(id);
      log.warn(
        { err: error, sideSessionId: id },
        "Could not delete Antigravity side conversation; it is retried later",
      );
    }
  };

  /** Delete side conversations an earlier Yep process left behind. */
  const collectOrphans = async () => {
    if (!server) return;
    for (const id of await registry.staleIds()) {
      if (id === sideId) continue;
      await deleteConversation(id);
    }
  };

  const close = (): Promise<void> => {
    closing ??= (async () => {
      // A create still racing close() must not leave its process behind.
      const id = sideId;
      try {
        if (id && turn)
          await withTimeout(
            client.cancel(id),
            CLOSE_STEP_TIMEOUT_MS,
            "cancel timed out",
          ).catch(() => undefined);
        if (id)
          await withTimeout(
            client.closeSession(id),
            CLOSE_STEP_TIMEOUT_MS,
            "close timed out",
          ).catch(() => undefined);
        if (id) await deleteConversation(id);
      } finally {
        turn = null;
        client.close();
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    })();
    return closing;
  };

  const systemAppend = (reference: string) =>
    [SIDE_BOUNDARY, AGY_SIDE_TOOL_POLICY, reference]
      .filter(Boolean)
      .join("\n\n");

  const create = async (): Promise<void> => {
    await client.connect({
      command: options.agyPath,
      args: ["acp", "--log-file", logPath],
      cwd: options.cwd,
      env: { ...options.env, ANTIGRAVITY_SERVER_CSRF_TOKEN: token },
    });
    if (closing) {
      client.close();
      throw new Error("The side conversation was closed while starting.");
    }
    await withTimeout(
      client.initialize({
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      }),
      LS_TIMEOUT_MS,
      "Antigravity did not start",
    );
    let failure: Error | null = null;
    const deadline = Date.now() + LS_TIMEOUT_MS;
    const port = () =>
      waitForAgyLanguageServerPort(
        logPath,
        deadline,
        undefined,
        () => failure,
        "agy did not report its language server port; this agy version may not support side conversations",
      );

    let reference = "";
    if (options.context === "snapshot") {
      // The language server boots on the first session-level request;
      // `session/list` also fails fast when agy is signed out.
      const listed = client.listSessions();
      listed.catch((error: unknown) => {
        failure = new Error(errorMessage(error));
      });
      server = { port: await port(), token };
      await listed;
      void collectOrphans().catch(() => undefined);
      const trajectory = await callAgyLanguageServer(
        server,
        "GetCascadeTrajectorySteps",
        { cascadeId: options.parentSessionId },
        AbortSignal.timeout(LS_TIMEOUT_MS),
      );
      const steps =
        isRecord(trajectory) && Array.isArray(trajectory.steps)
          ? trajectory.steps
          : [];
      const plan = planAgySideFork(steps);
      reference = referenceText(plan.pendingRequests);
      for (const forkAt of plan.forkAt) {
        try {
          const forked = await callAgyLanguageServer(
            server,
            "ForkConversation",
            {
              sourceCascadeId: options.parentSessionId,
              forkAtStepIndex: forkAt,
              targetForkWorkspace: "FORK_TARGET_CURRENT_WORKSPACE",
            },
            AbortSignal.timeout(LS_TIMEOUT_MS),
          );
          const id =
            isRecord(forked) && typeof forked.newCascadeId === "string"
              ? forked.newCascadeId.trim()
              : "";
          if (!id)
            throw new Error("Antigravity fork returned no conversation id");
          sideId = id;
          await registry.register(id, options.parentSessionId);
          log.info(
            {
              event: "agy_side_conversation_forked",
              parentSessionId: options.parentSessionId,
              forkAtStepIndex: forkAt,
              sideSessionId: id,
            },
            "Forked Antigravity conversation for a side conversation",
          );
          break;
        } catch (error) {
          // The turn moved on between reading and forking: try the
          // previous turn end.
          if (
            error instanceof Error &&
            /end of a turn|user message/u.test(error.message)
          )
            continue;
          throw new Error(
            `Antigravity could not fork the main conversation: ${errorMessage(error)}`,
          );
        }
      }
      if (sideId) {
        const meta = {
          _meta: {
            antigravity: { systemPrompt: { append: systemAppend(reference) } },
          },
        };
        try {
          await withTimeout(
            client.resumeSession(sideId, options.cwd, meta),
            LS_TIMEOUT_MS,
            "Antigravity did not resume the side conversation",
          );
        } catch (error) {
          if (isAgyAuthRequiredError(error)) throw error;
          await withTimeout(
            client.loadSession(sideId, options.cwd, meta),
            LS_TIMEOUT_MS,
            "Antigravity did not load the side conversation",
          );
        }
      }
      // No finished turn yet: start fresh, naming the running request.
    }
    if (!sideId) {
      const id = await withTimeout(
        client.newSession(options.cwd, {
          _meta: {
            antigravity: { systemPrompt: { append: systemAppend(reference) } },
          },
        }),
        LS_TIMEOUT_MS,
        "Antigravity did not start the side conversation",
      );
      sideId = id;
      await registry.register(id, options.parentSessionId);
      // agy may accept a fork point but fail to fork; a fresh session never
      // inherited the boundary, so it goes in front of the first question.
      preface = SIDE_BOUNDARY;
      if (!server) {
        try {
          server = { port: await port(), token };
          void collectOrphans().catch(() => undefined);
        } catch (error) {
          // Without the server the conversation cannot be deleted later;
          // the registry keeps it hidden until a later side collects it.
          log.warn(
            { err: error, sideSessionId: id },
            "Antigravity side conversation has no language server",
          );
        }
      }
    }

    // agy resets mode and model on resume; a side always asks first.
    if (client.getSessionModes(sideId)?.currentModeId !== "default")
      await client.setSessionMode(sideId, "default");
    if (options.model) {
      await applyAgyModel(
        client,
        sideId,
        options.model,
        options.reasoningEffort,
      ).catch((error: unknown) =>
        log.info(
          { err: error, sideSessionId: sideId },
          "Antigravity side conversation keeps agy's default model",
        ),
      );
    }
  };

  try {
    await withTimeout(
      create(),
      CREATE_TIMEOUT_MS,
      "Antigravity took too long to start the side conversation",
    );
  } catch (error) {
    await close();
    throw new Error(errorMessage(error));
  }

  const activeSideId = sideId as string;
  const configOptions = client.getSessionConfigOptions(activeSideId);

  const finishTurn = async (
    outcome: { stopReason?: string; usage?: unknown } | Error,
  ) => {
    const active = turn;
    if (!active) return;
    // agy can resolve the prompt before its last chunks arrive; those still
    // belong to this turn.
    const started = active.lastUpdateAt;
    while (
      Date.now() - active.lastUpdateAt < SETTLE_QUIET_MS &&
      Date.now() - started < SETTLE_MAX_MS &&
      !closing
    )
      await new Promise((resolve) => setTimeout(resolve, 50));
    if (closing || turn !== active) return;
    const stopped =
      outcome instanceof Error ||
      outcome.stopReason === "cancelled" ||
      outcome.stopReason === "refusal";
    if (active.violation) {
      turn = null;
      emit({
        type: "closed",
        error: `Antigravity ran ${active.violation} without asking for approval (a permission rule allows it). The side conversation was closed to keep it read-only.`,
      });
      return;
    }
    // A declined call is the normal outcome of a write attempt; cancelling or
    // refusing the turn already explains itself.
    if (!stopped && active.declined.size > 0) {
      const message = startMessage();
      const text = `Declined ${[...active.declined].join(", ")}: side conversations are read-only. Ask in the main conversation to make changes.`;
      message.blocks.push({ type: "text", text });
      emit({ type: "text", id: message.id, text });
    }
    turn = null;
    current = null;
    if (outcome instanceof Error) {
      emit({ type: "done", error: errorMessage(outcome) });
      return;
    }
    const reported = isRecord(outcome.usage) ? outcome.usage : undefined;
    if (typeof reported?.inputTokens === "number")
      usage.inputTokens += reported.inputTokens;
    if (typeof reported?.outputTokens === "number")
      usage.outputTokens += reported.outputTokens;
    emit({
      type: "done",
      ...(outcome.stopReason === "refusal"
        ? { error: "Antigravity refused the request." }
        : {}),
      ...(reported ? { usage: { ...usage } } : {}),
    });
  };

  return {
    providerSessionId: activeSideId,
    model:
      selectAgyConfigValues(configOptions, AGY_MODEL_CONFIG_ID).current ??
      options.model,
    reasoningEffort:
      selectAgyConfigValues(configOptions, AGY_THOUGHT_CONFIG_ID).current ??
      options.reasoningEffort,
    async send(text: string, _requestId: string, images: SideImage[] = []) {
      if (closing) throw new Error("Side conversation closed");
      if (turn) throw new Error("Wait for the current side reply to finish.");
      const blocks: ContentBlock[] = [];
      if (firstPrompt && preface) blocks.push({ type: "text", text: preface });
      blocks.push({ type: "text", text });
      for (const image of images) {
        blocks.push({
          type: "image",
          mimeType: image.mimeType,
          data: (await readFile(image.path)).toString("base64"),
        });
      }
      firstPrompt = false;
      current = null;
      turn = { declined: new Set(), lastUpdateAt: Date.now() };
      // The prompt resolves when the turn ends; the reply streams meanwhile.
      void client.prompt(activeSideId, blocks).then(
        (result) => finishTurn(result),
        (error: unknown) =>
          finishTurn(error instanceof Error ? error : new Error(String(error))),
      );
    },
    async interrupt() {
      if (turn) await client.cancel(activeSideId);
    },
    close,
  };
}
