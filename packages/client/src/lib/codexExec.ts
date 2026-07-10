export interface CodexExecOverview {
  script: string;
  operations: CodexExecOperation[];
  operationCount: number;
  commandCount: number;
  summary: string;
}

export interface CodexExecOperation {
  name: string;
  command?: string;
}

export type CodexExecStatus =
  | "completed"
  | "failed"
  | "running"
  | "terminated"
  | "unknown";

export interface CodexExecOutputSegment {
  text: string;
  exitCode?: number;
  wallTimeSeconds?: number;
  sessionId?: string | number;
  chunkId?: string;
  originalTokenCount?: number;
  isError: boolean;
}

export interface CodexExecImageOutput {
  imageUrl: string;
  detail?: string;
}

export interface CodexExecResultOverview {
  status: CodexExecStatus;
  wallTimeSeconds?: number;
  cellId?: string;
  output: string;
  outputLineCount: number;
  segments: CodexExecOutputSegment[];
  images: CodexExecImageOutput[];
  unknownItemCount: number;
}

export interface CodexExecResultOptions {
  parseNestedResults?: boolean;
}

const TOOL_CALL_PATTERN = /\btools\.([A-Za-z_$][\w$]*)\s*\(/g;
const EXEC_COMMAND_ARGUMENT_PATTERN =
  /(?:["']cmd["']|\bcmd)\s*:\s*(["'`])((?:\\[\s\S]|(?!\1)[\s\S])*)\1/;

const SCRIPT_STATUS_PATTERN =
  /^Script (completed|failed|terminated|running with cell ID (.+))$/i;
const WALL_TIME_PATTERN = /^Wall time:?\s*([0-9]+(?:\.[0-9]+)?)\s*seconds?$/i;
const OUTPUT_MARKER_PATTERN = /^Output:\s*$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function getCodexExecScript(input: unknown): string {
  if (typeof input === "string") {
    return input.trim();
  }
  if (!isRecord(input)) {
    return "";
  }

  for (const key of ["script", "code", "input", "raw"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function decodeJavaScriptString(quote: string, value: string): string {
  if (quote === '"') {
    try {
      return JSON.parse(`"${value}"`) as string;
    } catch {
      // Fall through to the small escape decoder below.
    }
  }

  return value.replace(/\\([\\'"`nrtbfv])/g, (_match, escaped: string) => {
    switch (escaped) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "v":
        return "\v";
      default:
        return escaped;
    }
  });
}

function compactCommand(command: string, maxLength = 76): string {
  const compact = command.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength - 1).trimEnd()}…`;
}

function findObjectEnd(source: string, start: number): number | undefined {
  let depth = 0;
  let quote: '"' | "'" | "`" | null = null;
  let escaping = false;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (!char) continue;

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
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return undefined;
}

function extractExecCommand(
  script: string,
  callIndex: number,
  callPrefixLength: number,
): string | undefined {
  let objectStart = callIndex + callPrefixLength;
  while (/\s/.test(script[objectStart] ?? "")) objectStart += 1;
  if (script[objectStart] !== "{") return undefined;

  const objectEnd = findObjectEnd(script, objectStart);
  if (objectEnd === undefined) return undefined;
  const objectSource = script.slice(objectStart, objectEnd + 1);
  const commandMatch = objectSource.match(EXEC_COMMAND_ARGUMENT_PATTERN);
  if (!commandMatch) return undefined;
  return decodeJavaScriptString(commandMatch[1] ?? '"', commandMatch[2] ?? "");
}

function extractOperations(script: string): CodexExecOperation[] {
  const operations: CodexExecOperation[] = [];

  for (const match of script.matchAll(TOOL_CALL_PATTERN)) {
    const name = match[1];
    if (!name) continue;

    if (name === "exec_command") {
      const command = extractExecCommand(
        script,
        match.index ?? 0,
        match[0].length,
      );
      operations.push({ name, ...(command && { command }) });
      continue;
    }

    operations.push({ name });
  }

  return operations;
}

function buildSummary(
  script: string,
  operations: CodexExecOperation[],
): string {
  if (operations.length === 0) {
    const firstLine = script
      .split("\n")
      .find((line) => line.trim())
      ?.trim();
    return firstLine ? compactCommand(firstLine, 140) : "Run script";
  }

  if (operations.length === 1) {
    const operation = operations[0];
    return operation?.command
      ? compactCommand(operation.command, 160)
      : (operation?.name ?? "Run script");
  }

  const commandCount = operations.filter(
    (operation) => operation.command,
  ).length;
  const allCommands = commandCount === operations.length;
  const labels = operations
    .slice(0, 2)
    .map((operation) =>
      operation.command ? compactCommand(operation.command) : operation.name,
    );
  const remaining = operations.length - labels.length;
  const noun = allCommands ? "commands" : "operations";
  return `${operations.length} ${noun} · ${labels.join(" · ")}${remaining > 0 ? ` · +${remaining}` : ""}`;
}

export function getCodexExecOverview(input: unknown): CodexExecOverview {
  const script = getCodexExecScript(input);
  const operations = extractOperations(script);
  return {
    script,
    operations,
    operationCount: operations.length,
    commandCount: operations.filter((operation) => operation.command).length,
    summary: buildSummary(script, operations),
  };
}

export function getCodexExecSummary(input: unknown): string {
  return getCodexExecOverview(input).summary;
}

const NESTED_RESULT_FIELD_PATTERN =
  /\b(?:chunk_id|chunkId|wall_time_seconds|wallTimeSeconds|exit_code|exitCode|session_id|sessionId|original_token_count|originalTokenCount)\b/;
const EXEC_RESULT_VARIABLE_PATTERN =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+tools\.exec_command\s*\(/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `text(r.output)` may contain arbitrary business JSON, while `text(r)` or an
 * explicit JSON object containing exec result metadata is an orchestration
 * envelope. Only enable nested-result decoding when the script makes that
 * intent visible; otherwise preserve JSON output verbatim.
 */
export function shouldParseCodexExecNestedResults(input: unknown): boolean {
  const script = getCodexExecScript(input);
  if (!script) return false;

  if (
    /\bJSON\.stringify\s*\(/.test(script) &&
    NESTED_RESULT_FIELD_PATTERN.test(script)
  ) {
    return true;
  }

  for (const match of script.matchAll(EXEC_RESULT_VARIABLE_PATTERN)) {
    const variable = match[1];
    if (!variable) continue;
    const escaped = escapeRegExp(variable);
    if (
      new RegExp(`\\btext\\s*\\(\\s*${escaped}\\s*\\)`).test(script) ||
      new RegExp(
        `\\btext\\s*\\(\\s*JSON\\.stringify\\s*\\(\\s*${escaped}(?:\\s*,|\\s*\\))`,
      ).test(script)
    ) {
      return true;
    }
  }

  return false;
}

function getFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function getInteger(value: unknown): number | undefined {
  const parsed = getFiniteNumber(value);
  return parsed === undefined ? undefined : Math.trunc(parsed);
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function getContentItems(value: unknown): unknown[] | null {
  if (Array.isArray(value)) {
    return value;
  }

  if (isRecord(value) && Array.isArray(value.items)) {
    return value.items;
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith("[")) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.some(
        (item) =>
          isRecord(item) &&
          (item.type === "input_text" ||
            item.type === "output_text" ||
            item.type === "input_image" ||
            item.type === "encrypted_content"),
      )
    ) {
      return parsed;
    }
  } catch {
    // A command may legitimately print text beginning with `[`. Keep it as text.
  }

  return null;
}

function parseScriptHeader(text: string): {
  status: CodexExecStatus;
  wallTimeSeconds?: number;
  cellId?: string;
  output: string;
} | null {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const firstLine = lines[0]?.trim() ?? "";
  const statusMatch = firstLine.match(SCRIPT_STATUS_PATTERN);
  if (!statusMatch?.[1]) {
    return null;
  }

  const normalizedStatus = statusMatch[1].toLowerCase();
  const status: CodexExecStatus =
    normalizedStatus === "completed"
      ? "completed"
      : normalizedStatus === "failed"
        ? "failed"
        : normalizedStatus === "terminated"
          ? "terminated"
          : "running";
  const cellId = status === "running" ? statusMatch[2]?.trim() : undefined;

  let lineIndex = 1;
  let wallTimeSeconds: number | undefined;
  const wallTimeMatch = lines[lineIndex]?.trim().match(WALL_TIME_PATTERN);
  if (wallTimeMatch?.[1]) {
    wallTimeSeconds = Number.parseFloat(wallTimeMatch[1]);
    lineIndex += 1;
  }
  if (OUTPUT_MARKER_PATTERN.test(lines[lineIndex]?.trim() ?? "")) {
    lineIndex += 1;
  }

  return {
    status,
    ...(wallTimeSeconds !== undefined && { wallTimeSeconds }),
    ...(cellId && { cellId }),
    output: lines.slice(lineIndex).join("\n").trimEnd(),
  };
}

const NESTED_RESULT_METADATA_KEYS = new Set([
  "chunk_id",
  "chunkId",
  "wall_time_seconds",
  "wallTimeSeconds",
  "exit_code",
  "exitCode",
  "session_id",
  "sessionId",
  "original_token_count",
  "originalTokenCount",
  "status",
  "is_error",
  "isError",
]);

function parseNestedResultText(
  text: string,
  parseNestedResults: boolean,
): CodexExecOutputSegment {
  const fallback = (): CodexExecOutputSegment => ({
    text: text.trimEnd(),
    isError: /^\s*(?:Script error:|Error:|Fatal:|Failed:)/im.test(text),
  });
  const trimmed = text.trim();
  if (!trimmed) {
    return fallback();
  }

  if (!parseNestedResults) {
    return fallback();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return fallback();
  }

  if (typeof parsed === "string") {
    return {
      text: parsed.trimEnd(),
      isError: /^\s*(?:Script error:|Error:|Fatal:|Failed:)/im.test(parsed),
    };
  }
  if (!isRecord(parsed)) {
    return fallback();
  }

  const exitCode = getInteger(parsed.exit_code ?? parsed.exitCode);
  const wallTimeSeconds = getFiniteNumber(
    parsed.wall_time_seconds ?? parsed.wallTimeSeconds,
  );
  const sessionIdValue = parsed.session_id ?? parsed.sessionId;
  const sessionId =
    typeof sessionIdValue === "string" || typeof sessionIdValue === "number"
      ? sessionIdValue
      : undefined;
  const chunkId = getString(parsed.chunk_id ?? parsed.chunkId);
  const originalTokenCount = getInteger(
    parsed.original_token_count ?? parsed.originalTokenCount,
  );
  const nestedStatus = getString(parsed.status)?.toLowerCase();
  const isError =
    (exitCode !== undefined && exitCode !== 0) ||
    parsed.is_error === true ||
    parsed.isError === true ||
    nestedStatus === "failed" ||
    nestedStatus === "error";

  let outputValue = parsed.output;
  if (outputValue === undefined && typeof parsed.content === "string") {
    outputValue = parsed.content;
  }
  if (outputValue === undefined && typeof parsed.message === "string") {
    outputValue = parsed.message;
  }

  let outputText = "";
  if (typeof outputValue === "string") {
    outputText = outputValue.trimEnd();
  } else if (outputValue !== undefined && outputValue !== null) {
    outputText = JSON.stringify(outputValue, null, 2);
  } else {
    const visibleRecord = Object.fromEntries(
      Object.entries(parsed).filter(
        ([key]) =>
          !NESTED_RESULT_METADATA_KEYS.has(key) &&
          key !== "content" &&
          key !== "message",
      ),
    );
    if (Object.keys(visibleRecord).length > 0) {
      outputText = JSON.stringify(visibleRecord, null, 2);
    }
  }

  return {
    text: outputText,
    ...(exitCode !== undefined && { exitCode }),
    ...(wallTimeSeconds !== undefined && { wallTimeSeconds }),
    ...(sessionId !== undefined && { sessionId }),
    ...(chunkId && { chunkId }),
    ...(originalTokenCount !== undefined && { originalTokenCount }),
    isError,
  };
}

function countOutputLines(text: string): number {
  if (!text) return 0;
  return text.split("\n").length;
}

/**
 * Convert code-mode's freeform output envelope into data useful to a human.
 * The result may be a string, content-item array, or a legacy JSON encoding of
 * that array. Unknown content items are counted instead of being dumped into
 * the transcript (notably encrypted payloads and image base64 JSON).
 */
export function getCodexExecResultOverview(
  result: unknown,
  isError = false,
  options: CodexExecResultOptions = {},
): CodexExecResultOverview {
  const contentItems = getContentItems(result);
  const rawItems = contentItems ?? [result];
  const textItems: string[] = [];
  const images: CodexExecImageOutput[] = [];
  let unknownItemCount = 0;

  for (const item of rawItems) {
    if (typeof item === "string") {
      textItems.push(item);
      continue;
    }
    if (typeof item === "number" || typeof item === "boolean") {
      textItems.push(String(item));
      continue;
    }
    if (!isRecord(item)) {
      if (item !== null && item !== undefined) unknownItemCount += 1;
      continue;
    }

    if (
      (item.type === "input_text" || item.type === "output_text") &&
      typeof item.text === "string"
    ) {
      textItems.push(item.text);
      continue;
    }
    if (item.type === "input_image" && typeof item.image_url === "string") {
      images.push({
        imageUrl: item.image_url,
        ...(typeof item.detail === "string" && { detail: item.detail }),
      });
      continue;
    }

    if (contentItems) {
      unknownItemCount += 1;
    } else {
      textItems.push(JSON.stringify(item));
    }
  }

  let status: CodexExecStatus = isError ? "failed" : "unknown";
  let wallTimeSeconds: number | undefined;
  let cellId: string | undefined;
  const segments: CodexExecOutputSegment[] = [];

  for (let index = 0; index < textItems.length; index += 1) {
    const text = textItems[index];
    if (text === undefined) continue;
    if (index === 0) {
      const header = parseScriptHeader(text);
      if (header) {
        status = header.status;
        wallTimeSeconds = header.wallTimeSeconds;
        cellId = header.cellId;
        if (header.output) {
          segments.push(
            parseNestedResultText(
              header.output,
              options.parseNestedResults === true,
            ),
          );
        }
        continue;
      }
    }
    segments.push(
      parseNestedResultText(text, options.parseNestedResults === true),
    );
  }

  if (
    status !== "failed" &&
    isError &&
    status !== "running" &&
    status !== "terminated"
  ) {
    status = "failed";
  }

  const output = segments
    .map((segment) => segment.text)
    .filter((text) => text.length > 0)
    .join("\n");

  return {
    status,
    ...(wallTimeSeconds !== undefined && { wallTimeSeconds }),
    ...(cellId && { cellId }),
    output,
    outputLineCount: countOutputLines(output),
    segments,
    images,
    unknownItemCount,
  };
}
