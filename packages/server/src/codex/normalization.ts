const CODEX_TOOL_NAME_ALIASES: Record<string, string> = {
  exec: "CodexExec",
  shell_command: "Bash",
  exec_command: "Bash",
  write_stdin: "WriteStdin",
  update_plan: "UpdatePlan",
  apply_patch: "Edit",
  web_search_call: "WebSearch",
  search_query: "WebSearch",
};

export interface CodexReadShellInfo {
  filePath: string;
  startLine?: number;
  endLine?: number;
  stripLineNumbers: boolean;
}

export interface CodexWriteShellInfo {
  filePath: string;
  content: string;
}

export interface CodexToolCallContext {
  toolName: string;
  input: unknown;
  readShellInfo?: CodexReadShellInfo;
  writeShellInfo?: CodexWriteShellInfo;
}

interface NormalizedCodexToolInvocation {
  toolName: string;
  input: unknown;
  readShellInfo?: CodexReadShellInfo;
  writeShellInfo?: CodexWriteShellInfo;
}

interface NormalizedCodexToolOutput {
  content: string;
  structured?: unknown;
  isError: boolean;
}

interface NormalizedCodexToolOutputWithExitCode
  extends NormalizedCodexToolOutput {
  exitCode?: number;
}

export interface CodexUpdatePlanStep {
  step: string;
  status: string;
}

export interface CodexUpdatePlanInput {
  explanation?: string;
  plan: CodexUpdatePlanStep[];
}

const SHELL_EXECUTABLES = new Set(["bash", "sh", "zsh", "dash"]);

/**
 * Parse the data-only JavaScript literal subset emitted by Codex code mode.
 * Session content is untrusted, so this deliberately never evaluates code.
 */
class CodexJavaScriptLiteralParser {
  private index = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.source.length) {
      throw new Error("Unsupported trailing JavaScript expression");
    }
    return value;
  }

  private parseValue(): unknown {
    this.skipWhitespace();
    const char = this.source[this.index];
    if (char === "{") return this.parseObject();
    if (char === "[") return this.parseArray();
    if (char === '"' || char === "'" || char === "`") {
      return this.parseString();
    }
    if (char === "-" || /\d/.test(char ?? "")) return this.parseNumber();

    const identifier = this.parseIdentifier();
    if (identifier === "true") return true;
    if (identifier === "false") return false;
    if (identifier === "null") return null;
    if (identifier === "undefined") return undefined;
    throw new Error("Unsupported JavaScript expression");
  }

  private parseObject(): Record<string, unknown> {
    const value: Record<string, unknown> = {};
    this.index += 1;
    this.skipWhitespace();

    while (this.index < this.source.length && this.source[this.index] !== "}") {
      const char = this.source[this.index];
      const key =
        char === '"' || char === "'" || char === "`"
          ? this.parseString()
          : this.parseIdentifier();
      if (!key) throw new Error("Missing object key");

      this.skipWhitespace();
      if (this.source[this.index] !== ":") {
        throw new Error("Missing object separator");
      }
      this.index += 1;
      value[key] = this.parseValue();
      this.skipWhitespace();

      if (this.source[this.index] === ",") {
        this.index += 1;
        this.skipWhitespace();
        continue;
      }
      break;
    }

    if (this.source[this.index] !== "}") {
      throw new Error("Unterminated object literal");
    }
    this.index += 1;
    return value;
  }

  private parseArray(): unknown[] {
    const value: unknown[] = [];
    this.index += 1;
    this.skipWhitespace();

    while (this.index < this.source.length && this.source[this.index] !== "]") {
      value.push(this.parseValue());
      this.skipWhitespace();
      if (this.source[this.index] === ",") {
        this.index += 1;
        this.skipWhitespace();
        continue;
      }
      break;
    }

    if (this.source[this.index] !== "]") {
      throw new Error("Unterminated array literal");
    }
    this.index += 1;
    return value;
  }

  private parseString(): string {
    const quote = this.source[this.index];
    if (quote !== '"' && quote !== "'" && quote !== "`") {
      throw new Error("Expected string literal");
    }
    this.index += 1;
    let value = "";

    while (this.index < this.source.length) {
      const char = this.source[this.index];
      this.index += 1;
      if (char === quote) return value;
      if (quote === "`" && char === "$" && this.source[this.index] === "{") {
        throw new Error("Template expressions are not data literals");
      }
      if (char !== "\\") {
        value += char;
        continue;
      }

      const escaped = this.source[this.index];
      this.index += 1;
      switch (escaped) {
        case "n":
          value += "\n";
          break;
        case "r":
          value += "\r";
          break;
        case "t":
          value += "\t";
          break;
        case "b":
          value += "\b";
          break;
        case "f":
          value += "\f";
          break;
        case "v":
          value += "\v";
          break;
        case "u": {
          const hex = this.source.slice(this.index, this.index + 4);
          if (!/^[0-9a-f]{4}$/i.test(hex)) {
            throw new Error("Invalid unicode escape");
          }
          value += String.fromCharCode(Number.parseInt(hex, 16));
          this.index += 4;
          break;
        }
        case "x": {
          const hex = this.source.slice(this.index, this.index + 2);
          if (!/^[0-9a-f]{2}$/i.test(hex)) {
            throw new Error("Invalid hex escape");
          }
          value += String.fromCharCode(Number.parseInt(hex, 16));
          this.index += 2;
          break;
        }
        default:
          value += escaped ?? "";
      }
    }

    throw new Error("Unterminated string literal");
  }

  private parseNumber(): number {
    const match = this.source
      .slice(this.index)
      .match(/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/i);
    if (!match?.[0]) throw new Error("Invalid number literal");
    this.index += match[0].length;
    return Number(match[0]);
  }

  private parseIdentifier(): string {
    const match = this.source
      .slice(this.index)
      .match(/^[A-Za-z_$][A-Za-z0-9_$-]*/);
    if (!match?.[0]) return "";
    this.index += match[0].length;
    return match[0];
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.source[this.index] ?? "")) this.index += 1;
  }
}

function extractCodexExecScript(input: unknown): string {
  if (typeof input === "string") return input;
  if (!isRecord(input)) return "";
  for (const key of ["script", "code", "input", "raw"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function isJavaScriptCodePosition(
  source: string,
  targetIndex: number,
): boolean {
  let state:
    | "code"
    | "single-quote"
    | "double-quote"
    | "template"
    | "line-comment"
    | "block-comment" = "code";

  for (let index = 0; index < targetIndex; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (state === "code") {
      if (char === "'") state = "single-quote";
      else if (char === '"') state = "double-quote";
      else if (char === "`") state = "template";
      else if (char === "/" && next === "/") {
        state = "line-comment";
        index += 1;
      } else if (char === "/" && next === "*") {
        state = "block-comment";
        index += 1;
      }
      continue;
    }

    if (state === "line-comment") {
      if (char === "\n" || char === "\r") state = "code";
      continue;
    }
    if (state === "block-comment") {
      if (char === "*" && next === "/") {
        state = "code";
        index += 1;
      }
      continue;
    }

    if (char === "\\") {
      index += 1;
      continue;
    }
    if (
      (state === "single-quote" && char === "'") ||
      (state === "double-quote" && char === '"') ||
      (state === "template" && char === "`")
    ) {
      state = "code";
    }
  }

  return state === "code";
}

function extractToolCallArguments(script: string, toolName: string): string[] {
  const escapedName = toolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\btools\\.${escapedName}\\s*\\(`, "g");
  const argumentsList: string[] = [];

  for (const match of script.matchAll(pattern)) {
    if (!isJavaScriptCodePosition(script, match.index ?? 0)) continue;
    const openIndex = script.indexOf("(", match.index ?? 0);
    if (openIndex < 0) continue;

    let depth = 1;
    let quote: '"' | "'" | "`" | null = null;
    let escaping = false;
    for (let index = openIndex + 1; index < script.length; index += 1) {
      const char = script[index];
      if (quote) {
        if (escaping) {
          escaping = false;
        } else if (char === "\\") {
          escaping = true;
        } else if (char === quote) {
          quote = null;
        }
        continue;
      }
      if (char === '"' || char === "'" || char === "`") {
        quote = char;
      } else if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          argumentsList.push(script.slice(openIndex + 1, index).trim());
          break;
        }
      }
    }
  }

  return argumentsList;
}

function normalizeUpdatePlanInput(value: unknown): CodexUpdatePlanInput | null {
  if (!isRecord(value) || !Array.isArray(value.plan)) return null;

  const plan: CodexUpdatePlanStep[] = [];
  for (const item of value.plan) {
    if (
      !isRecord(item) ||
      typeof item.step !== "string" ||
      typeof item.status !== "string"
    ) {
      return null;
    }
    const step = item.step.trim();
    const status = item.status.trim();
    if (!step || !status) return null;
    plan.push({
      step,
      status: status === "inProgress" ? "in_progress" : status,
    });
  }

  const explanation =
    typeof value.explanation === "string" ? value.explanation.trim() : "";
  return {
    ...(explanation ? { explanation } : {}),
    plan,
  };
}

/** Extract the latest literal `tools.update_plan(...)` snapshot from exec. */
export function extractCodexExecUpdatePlan(
  input: unknown,
): CodexUpdatePlanInput | null {
  const script = extractCodexExecScript(input);
  if (!script) return null;

  let latest: CodexUpdatePlanInput | null = null;
  for (const argument of extractToolCallArguments(script, "update_plan")) {
    try {
      const parsed = new CodexJavaScriptLiteralParser(argument).parse();
      latest = normalizeUpdatePlanInput(parsed) ?? latest;
    } catch {
      // Dynamic JavaScript must remain a normal CodexExec operation.
    }
  }
  return latest;
}

export function parseCodexToolArguments(argumentsText?: string): unknown {
  if (!argumentsText) {
    return {};
  }
  try {
    return JSON.parse(argumentsText);
  } catch {
    return { raw: argumentsText };
  }
}

export function canonicalizeCodexToolName(
  name: string,
  namespace?: string,
): string {
  if (namespace) {
    return `${namespace}${name}`;
  }
  return (
    CODEX_TOOL_NAME_ALIASES[name] ??
    CODEX_TOOL_NAME_ALIASES[name.toLowerCase()] ??
    name
  );
}

export function normalizeCodexToolInvocation(
  toolName: string,
  input: unknown,
): NormalizedCodexToolInvocation {
  if (toolName === "CodexExec") {
    if (typeof input === "string") {
      return { toolName, input: { script: input } };
    }
    return { toolName, input };
  }

  if (toolName === "Read") {
    const readShellInfo = createReadShellInfoFromInput(input);
    return readShellInfo
      ? { toolName, input, readShellInfo }
      : { toolName, input };
  }

  if (toolName === "Write") {
    const writeShellInfo = createWriteShellInfoFromInput(input);
    return writeShellInfo
      ? { toolName, input, writeShellInfo }
      : { toolName, input };
  }

  if (toolName !== "Bash") {
    return { toolName, input };
  }

  let normalizedInput: unknown = input;
  if (typeof input === "string" && input.trim()) {
    normalizedInput = { command: input };
  } else if (isRecord(input)) {
    const normalized = { ...input };
    if (
      typeof normalized.command !== "string" &&
      typeof normalized.cmd === "string"
    ) {
      normalized.command = normalized.cmd;
    }
    normalizedInput = normalized;
  }

  const command = extractBashCommand(normalizedInput);
  if (!command) {
    return { toolName: "Bash", input: normalizedInput };
  }
  const normalizedCommand = unwrapShellLauncherCommand(command);

  const readShellInfo = parseReadShellCommand(normalizedCommand);
  if (readShellInfo) {
    return {
      toolName: "Read",
      input: createReadToolInput(readShellInfo),
      readShellInfo,
    };
  }

  const grepInput = parseRipgrepCommand(normalizedCommand);
  if (grepInput) {
    return {
      toolName: "Grep",
      input: grepInput,
    };
  }

  const writeShellInfo = parseHeredocWriteShellCommand(normalizedCommand);
  if (writeShellInfo) {
    return {
      toolName: "Write",
      input: createWriteToolInput(writeShellInfo),
      writeShellInfo,
    };
  }

  return { toolName: "Bash", input: normalizedInput };
}

function createReadShellInfoFromInput(
  input: unknown,
): CodexReadShellInfo | null {
  if (!isRecord(input) || typeof input.file_path !== "string") {
    return null;
  }

  const filePath = input.file_path.trim();
  if (!filePath) {
    return null;
  }

  const startLine = parsePositiveInteger(input.offset ?? input.start_line);
  const limit = parsePositiveInteger(input.limit);
  const endLine =
    startLine !== undefined && limit !== undefined
      ? startLine + Math.max(limit - 1, 0)
      : undefined;

  return {
    filePath,
    ...(startLine !== undefined && { startLine }),
    ...(endLine !== undefined && { endLine }),
    // External Codex Read rows usually include `nl`-style prefixes. This is
    // harmless for unnumbered output because normalizeReadOutput only strips
    // lines that actually start with a line number.
    stripLineNumbers: true,
  };
}

function createWriteShellInfoFromInput(
  input: unknown,
): CodexWriteShellInfo | null {
  if (
    !isRecord(input) ||
    typeof input.file_path !== "string" ||
    typeof input.content !== "string"
  ) {
    return null;
  }

  const filePath = input.file_path.trim();
  if (!filePath) {
    return null;
  }

  return {
    filePath,
    content: input.content,
  };
}

export function normalizeCodexToolOutputWithContext(
  output: unknown,
  context?: CodexToolCallContext,
): NormalizedCodexToolOutput {
  const normalized = normalizeCodexToolOutput(output);
  let content = normalized.content;
  let structured = normalized.structured;
  let isError = normalized.isError;
  const exitCode = normalized.exitCode ?? extractExitCodeFromText(content);
  const sessionId = extractSessionIdFromText(content);

  if (context?.toolName === "CodexExec") {
    const execText = extractCodexExecOutputText(output);
    if (execText !== undefined) {
      content = execText;
      if (/^Script failed\s*$/im.test(execText.split("\n", 1)[0] ?? "")) {
        isError = true;
      }
    }
  } else if (context?.toolName === "Grep") {
    const grepContent = extractCodexShellOutputContent(content);
    const grepResult = normalizeRipgrepOutput(grepContent);
    const isNoMatchesResult = exitCode === 1 && grepResult.numFiles === 0;

    if (!isError || isNoMatchesResult) {
      isError = false;
      structured = sessionId
        ? { ...grepResult, session_id: sessionId }
        : grepResult;
      content = grepContent;
    }
  } else if (context?.toolName === "Read" && context.readShellInfo) {
    if (!isError) {
      const readContent = extractCodexShellOutputContent(content);
      const readResult = normalizeReadOutput(
        readContent,
        context.readShellInfo,
      );
      structured = sessionId
        ? { ...readResult, session_id: sessionId }
        : readResult;
      content = readContent;
    }
  } else if (context?.toolName === "Write" && context.writeShellInfo) {
    if (!isError) {
      const writeResult = normalizeWriteOutput(context.writeShellInfo);
      structured = sessionId
        ? { ...writeResult, session_id: sessionId }
        : writeResult;
    }
  }

  return { content, structured, isError };
}

function extractCodexExecOutputText(output: unknown): string | undefined {
  let candidate = output;
  if (typeof candidate === "string" && candidate.trimStart().startsWith("[")) {
    const serialized = candidate;
    try {
      candidate = JSON.parse(serialized) as unknown;
    } catch {
      return serialized;
    }
  }

  if (!Array.isArray(candidate)) {
    return typeof candidate === "string" ? candidate : undefined;
  }

  const segments = candidate
    .map((item) =>
      isRecord(item) &&
      (item.type === "input_text" || item.type === "output_text") &&
      typeof item.text === "string"
        ? item.text
        : undefined,
    )
    .filter((text): text is string => text !== undefined && text.length > 0);

  if (segments.length === 0) {
    return undefined;
  }

  return segments.reduce((combined, segment) => {
    if (!combined) return segment;
    return `${combined}${combined.endsWith("\n") ? "" : "\n"}${segment}`;
  }, "");
}

export function normalizeCodexCommandExecutionOutput(
  execution: {
    aggregatedOutput: string;
    exitCode?: number;
    status?: string;
  },
  context?: CodexToolCallContext,
): NormalizedCodexToolOutput {
  const baseOutput = execution.aggregatedOutput;
  const hasExitCode = execution.exitCode !== undefined;
  let content =
    execution.status === "declined"
      ? "Command execution was declined."
      : baseOutput || "(no output)";

  const isDeclined = execution.status === "declined";
  let isError = !isDeclined && hasExitCode && execution.exitCode !== 0;
  if (!isDeclined && execution.status) {
    const normalizedStatus = execution.status.toLowerCase();
    if (normalizedStatus === "failed" || normalizedStatus === "error") {
      isError = true;
    }
  }

  // Preserve legacy command output formatting for non-zero exits.
  if (
    !isDeclined &&
    execution.exitCode !== undefined &&
    execution.exitCode !== 0 &&
    baseOutput
  ) {
    content = `Exit code: ${execution.exitCode}\n${baseOutput}`;
  }

  let structured: unknown;
  if (context?.toolName === "Grep") {
    const grepResult = normalizeRipgrepOutput(baseOutput);
    const isNoMatchesResult =
      execution.exitCode === 1 && grepResult.numFiles === 0;
    if (!isError || isNoMatchesResult) {
      isError = false;
      structured = grepResult;
      content = baseOutput;
    }
  } else if (
    context?.toolName === "Read" &&
    context.readShellInfo &&
    !isError &&
    execution.status !== "declined"
  ) {
    structured = normalizeReadOutput(baseOutput, context.readShellInfo);
    content = baseOutput;
  } else if (
    context?.toolName === "Write" &&
    context.writeShellInfo &&
    !isError &&
    execution.status !== "declined"
  ) {
    structured = normalizeWriteOutput(context.writeShellInfo);
  }

  return { content, structured, isError };
}

function extractBashCommand(input: unknown): string {
  if (!isRecord(input)) return "";
  if (typeof input.command === "string" && input.command.trim()) {
    return input.command.trim();
  }
  if (typeof input.cmd === "string" && input.cmd.trim()) {
    return input.cmd.trim();
  }
  return "";
}

function tokenizeShellCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (!char) continue;

    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function getExecutableName(token: string): string {
  const normalized = token.replace(/\\/g, "/");
  return (normalized.split("/").pop() || token).toLowerCase();
}

function isShellExecutable(token: string): boolean {
  return SHELL_EXECUTABLES.has(getExecutableName(token));
}

function getShellLauncherPrefixLength(tokens: string[]): number {
  if (tokens.length < 3) {
    return 0;
  }

  const first = tokens[0] || "";
  const second = tokens[1] || "";
  const third = tokens[2] || "";

  // /usr/bin/env bash -lc "command"
  if (
    getExecutableName(first) === "env" &&
    isShellExecutable(second) &&
    third === "-lc" &&
    tokens.length >= 4
  ) {
    return 3;
  }

  // /bin/bash -lc "command"
  if (isShellExecutable(first) && second === "-lc" && tokens.length >= 3) {
    return 2;
  }

  return 0;
}

function unwrapShellLauncherCommand(command: string): string {
  let normalized = command.trim();

  // Allow nested wrappers, e.g. `bash -lc "env bash -lc \"...\""`
  for (let i = 0; i < 3; i++) {
    const tokens = tokenizeShellCommand(normalized);
    const launcherPrefixLength = getShellLauncherPrefixLength(tokens);
    if (launcherPrefixLength === 0 || tokens.length <= launcherPrefixLength) {
      break;
    }
    normalized = tokens.slice(launcherPrefixLength).join(" ").trim();
  }

  return normalized;
}

function parseLineRangeToken(
  token: string,
): { startLine: number; endLine: number } | null {
  const match = token.match(/^(\d+)(?:,(\d+))?p$/);
  if (!match?.[1]) return null;

  const startLine = Number.parseInt(match[1], 10);
  const endLine = match[2] ? Number.parseInt(match[2], 10) : startLine;
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) {
    return null;
  }

  return {
    startLine,
    endLine: Math.max(startLine, endLine),
  };
}

function parseReadShellCommand(command: string): CodexReadShellInfo | null {
  const tokens = tokenizeShellCommand(command);
  if (tokens.length === 0) return null;

  if (tokens[0] === "cat" && tokens.length === 2) {
    const filePath = tokens[1];
    if (!filePath || filePath.startsWith("-")) {
      return null;
    }
    return {
      filePath,
      stripLineNumbers: false,
    };
  }

  if (tokens[0] === "sed" && tokens[1] === "-n" && tokens.length === 4) {
    const range = parseLineRangeToken(tokens[2] ?? "");
    const filePath = tokens[3];
    if (!range || !filePath || filePath.startsWith("-")) {
      return null;
    }
    return {
      filePath,
      startLine: range.startLine,
      endLine: range.endLine,
      stripLineNumbers: false,
    };
  }

  const isNlSedCommand =
    tokens[0] === "nl" &&
    tokens[1] === "-ba" &&
    tokens[3] === "|" &&
    tokens[4] === "sed" &&
    tokens[5] === "-n" &&
    tokens.length === 7;
  if (isNlSedCommand) {
    const filePath = tokens[2];
    const range = parseLineRangeToken(tokens[6] ?? "");
    if (!filePath || !range) return null;
    return {
      filePath,
      startLine: range.startLine,
      endLine: range.endLine,
      stripLineNumbers: true,
    };
  }

  return null;
}

function parseHeredocWriteShellCommand(
  command: string,
): CodexWriteShellInfo | null {
  const normalized = command.replace(/\r\n/g, "\n").trimEnd();
  const lines = normalized.split("\n");
  if (lines.length < 2) {
    return null;
  }

  const header = lines[0]?.trim() ?? "";
  const match =
    /^cat\s+>\s*(?<path>'[^']+'|"[^"]+"|[^\s]+)\s+<<(?<stripTabs>-?)(?<quote>['"]?)(?<marker>[A-Za-z_][A-Za-z0-9_]*)\k<quote>\s*$/.exec(
      header,
    );
  if (!match?.groups) {
    return null;
  }

  const marker = match.groups.marker;
  if (!marker) {
    return null;
  }

  const stripTabs = match.groups.stripTabs === "-";
  const filePath = stripOuterQuotes(match.groups.path ?? "");
  if (!filePath || filePath.startsWith("-")) {
    return null;
  }

  const terminatorLineIndex = lines.findIndex((line, index) => {
    if (index === 0) {
      return false;
    }
    const candidate = stripTabs ? line.replace(/^\t+/, "") : line;
    return candidate.trim() === marker;
  });
  if (terminatorLineIndex < 1) {
    return null;
  }

  const trailingLines = lines.slice(terminatorLineIndex + 1);
  if (trailingLines.some((line) => line.trim().length > 0)) {
    return null;
  }

  const bodyLines = lines.slice(1, terminatorLineIndex);
  let content = bodyLines.join("\n");
  if (bodyLines.length > 0) {
    content += "\n";
  }

  return {
    filePath,
    content,
  };
}

function createReadToolInput(
  readInfo: CodexReadShellInfo,
): Record<string, unknown> {
  const input: Record<string, unknown> = { file_path: readInfo.filePath };

  if (readInfo.startLine !== undefined) {
    input.offset = readInfo.startLine;
  }
  if (
    readInfo.startLine !== undefined &&
    readInfo.endLine !== undefined &&
    readInfo.endLine >= readInfo.startLine
  ) {
    input.limit = readInfo.endLine - readInfo.startLine + 1;
  }

  return input;
}

function createWriteToolInput(
  writeInfo: CodexWriteShellInfo,
): Record<string, unknown> {
  return {
    file_path: writeInfo.filePath,
    content: writeInfo.content,
  };
}

function parseRipgrepCommand(command: string): Record<string, unknown> | null {
  const tokens = tokenizeShellCommand(command);
  if (tokens[0] !== "rg" || tokens.length < 2) {
    return null;
  }

  if (
    tokens.some((token) => token === "|" || token === "&&" || token === ";")
  ) {
    return null;
  }

  const flagsWithValue = new Set([
    "-g",
    "--glob",
    "-e",
    "--regexp",
    "-f",
    "--file",
    "-m",
    "--max-count",
    "-A",
    "--after-context",
    "-B",
    "--before-context",
    "-C",
    "--context",
    "-t",
    "--type",
    "-T",
    "--type-not",
  ]);

  let pattern = "";
  const searchPaths: string[] = [];

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;

    if (token === "--") {
      const rest = tokens.slice(i + 1).filter(Boolean);
      if (!pattern && rest[0]) {
        pattern = rest[0];
      }
      if (pattern) {
        searchPaths.push(...rest.slice(1));
      }
      break;
    }

    if (token === "-e" || token === "--regexp") {
      const next = tokens[i + 1];
      if (next && !pattern) {
        pattern = next;
      }
      i += 1;
      continue;
    }

    if (flagsWithValue.has(token)) {
      i += 1;
      continue;
    }

    if (token.startsWith("--glob=") || token.startsWith("--regexp=")) {
      if (token.startsWith("--regexp=") && !pattern) {
        pattern = token.slice("--regexp=".length);
      }
      continue;
    }

    if (token.startsWith("-")) {
      continue;
    }

    if (!pattern) {
      pattern = token;
    } else {
      searchPaths.push(token);
    }
  }

  if (!pattern) {
    return null;
  }

  const input: Record<string, unknown> = {
    pattern,
    output_mode: "content",
  };
  if (searchPaths.length > 0) {
    input.path = searchPaths.join(" ");
  }
  return input;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseNumericExitCode(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return Number.parseInt(value, 10);
  }
  return undefined;
}

function parsePositiveInteger(value: unknown): number | undefined {
  const parsed = parseNumericExitCode(value);
  if (parsed === undefined || parsed < 1) {
    return undefined;
  }
  return parsed;
}

function extractExitCodeFromRecord(
  record: Record<string, unknown>,
): number | undefined {
  const direct = parseNumericExitCode(record.exit_code ?? record.exitCode);
  if (direct !== undefined) {
    return direct;
  }

  const metadata = record.metadata;
  if (isRecord(metadata)) {
    const nested = parseNumericExitCode(
      metadata.exit_code ?? metadata.exitCode,
    );
    if (nested !== undefined) {
      return nested;
    }
  }

  return undefined;
}

function hasFailedStatus(record: Record<string, unknown>): boolean {
  const status = record.status;
  if (typeof status !== "string") {
    return false;
  }
  const normalized = status.toLowerCase();
  return normalized === "failed" || normalized === "error";
}

function extractExitCodeFromText(output: string): number | undefined {
  const match = output.match(
    /(?:^|\n)\s*(?:Exit code:|Process exited with code)\s*(-?\d+)\b/i,
  );
  if (!match?.[1]) {
    return undefined;
  }
  return Number.parseInt(match[1], 10);
}

function extractSessionIdFromText(output: string): number | undefined {
  const match = output.match(
    /(?:^|\n)\s*(?:Process\s+running\s+with\s+session\s+ID|session(?:\s+id)?)\s*:?\s*(\d+)\b/i,
  );
  if (!match?.[1]) {
    return undefined;
  }
  return Number.parseInt(match[1], 10);
}

function normalizeCodexToolOutput(
  output: unknown,
): NormalizedCodexToolOutputWithExitCode {
  if (typeof output === "string") {
    let structured: unknown;
    let isError = false;
    let content = output;
    let exitCode: number | undefined;

    try {
      structured = JSON.parse(output);
      if (typeof structured === "string") {
        content = structured;
        exitCode = extractExitCodeFromText(structured);
        if (exitCode !== undefined) {
          isError = exitCode !== 0;
        }
      } else if (isRecord(structured)) {
        exitCode = extractExitCodeFromRecord(structured);
        isError =
          structured.is_error === true ||
          (exitCode !== undefined && exitCode !== 0) ||
          hasFailedStatus(structured);
      }
    } catch {
      structured = undefined;
      exitCode = extractExitCodeFromText(output);
      if (exitCode !== undefined) {
        isError = exitCode !== 0;
      } else {
        isError = /(?:^|\n)\s*(error|fatal|failed):/i.test(output);
      }
    }

    return { content, structured, isError, exitCode };
  }

  if (output === null || output === undefined) {
    return { content: "", isError: false };
  }

  if (typeof output === "number" || typeof output === "boolean") {
    return {
      content: String(output),
      structured: output,
      isError: false,
    };
  }

  if (Array.isArray(output) || isRecord(output)) {
    const exitCode = isRecord(output)
      ? extractExitCodeFromRecord(output)
      : undefined;
    const isError =
      isRecord(output) &&
      (output.is_error === true ||
        (exitCode ?? 0) !== 0 ||
        hasFailedStatus(output));
    return {
      content: JSON.stringify(output, null, 2),
      structured: output,
      isError,
      exitCode,
    };
  }

  return { content: String(output), isError: false };
}

function extractCodexShellOutputContent(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  const inlineMarker = "Output:\n";
  if (normalized.startsWith(inlineMarker)) {
    return normalized.slice(inlineMarker.length);
  }

  const marker = "\nOutput:\n";
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex < 0) {
    return normalized;
  }

  const rawOutput = normalized.slice(markerIndex + marker.length);
  return rawOutput.startsWith("\n") ? rawOutput.slice(1) : rawOutput;
}

function normalizeRipgrepOutput(output: string): {
  mode: "files_with_matches" | "content";
  filenames: string[];
  numFiles: number;
  content?: string;
  numLines?: number;
} {
  const normalized = output.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  if (!normalized.trim()) {
    return {
      mode: "files_with_matches",
      filenames: [],
      numFiles: 0,
    };
  }

  const lines = normalized.split("\n");
  const hasLineBasedMatches = lines.some(
    (line) => /^.+:\d+(?::|-)/.test(line) || /^\d+(?::|-)/.test(line),
  );

  if (hasLineBasedMatches) {
    const filenames = Array.from(
      new Set(
        lines
          .map(extractFilenameFromRipgrepLine)
          .filter((file): file is string => !!file),
      ),
    );

    const numFiles = filenames.length > 0 ? filenames.length : 1;
    return {
      mode: "content",
      filenames,
      numFiles,
      content: normalized,
      numLines: lines.length,
    };
  }

  const filenames = Array.from(
    new Set(lines.map((line) => line.trim()).filter((line) => line.length > 0)),
  );
  return {
    mode: "files_with_matches",
    filenames,
    numFiles: filenames.length,
  };
}

function extractFilenameFromRipgrepLine(line: string): string | null {
  const match = line.match(/^(.+?):\d+(?::|-)/);
  if (match?.[1]) {
    return match[1];
  }
  return null;
}

function normalizeReadOutput(
  output: string,
  readInfo: CodexReadShellInfo,
): {
  type: "text";
  file: {
    filePath: string;
    content: string;
    numLines: number;
    startLine: number;
    totalLines: number;
  };
} {
  const normalized = output.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  let startLine = readInfo.startLine ?? 1;

  const contentLines = readInfo.stripLineNumbers
    ? lines.map((line, index) => {
        const match = line.match(/^\s*(\d+)\s+(.*)$/);
        if (match?.[1]) {
          if (index === 0) {
            startLine = Number.parseInt(match[1], 10);
          }
          return match[2] ?? "";
        }
        return line;
      })
    : lines;

  const content = contentLines.join("\n");
  const numLines = countContentLines(content);
  const computedEndLine =
    numLines > 0 ? startLine + numLines - 1 : (readInfo.endLine ?? startLine);
  const totalLines = Math.max(
    readInfo.endLine ?? computedEndLine,
    computedEndLine,
  );

  return {
    type: "text",
    file: {
      filePath: readInfo.filePath,
      content,
      numLines,
      startLine,
      totalLines,
    },
  };
}

function normalizeWriteOutput(writeInfo: CodexWriteShellInfo): {
  type: "text";
  file: {
    filePath: string;
    content: string;
    numLines: number;
    startLine: number;
    totalLines: number;
  };
} {
  const numLines = countContentLines(writeInfo.content);
  return {
    type: "text",
    file: {
      filePath: writeInfo.filePath,
      content: writeInfo.content,
      numLines,
      startLine: 1,
      totalLines: numLines,
    },
  };
}

function countContentLines(content: string): number {
  if (!content) {
    return 0;
  }

  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.length;
}

function stripOuterQuotes(value: string): string {
  if (value.length < 2) {
    return value;
  }

  const first = value[0];
  const last = value[value.length - 1];
  if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
    return value.slice(1, -1);
  }

  return value;
}
