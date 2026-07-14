import {
  type CodexExecResultOverview,
  getCodexExecResultOverview,
  getCodexExecScript,
} from "./codexExec";

export type CodexWebOperationKind =
  | "search"
  | "image-search"
  | "open"
  | "click"
  | "find"
  | "screenshot"
  | "finance"
  | "weather"
  | "sports"
  | "time";

export interface CodexWebOperation {
  kind: CodexWebOperationKind;
  label: string;
  items: string[];
}

export interface CodexWebRunOverview {
  operations: CodexWebOperation[];
  operationCount: number;
  requestCount: number;
  queryCount: number;
  responseLength?: string;
  summary: string;
}

export interface CodexWebSource {
  title: string;
  url: string;
}

export interface CodexWebResultOverview {
  exec: CodexExecResultOverview;
  output: string;
  outputChars: number;
  outputLineCount: number;
  sources: CodexWebSource[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * The code-mode tool persists a JavaScript object literal rather than JSON.
 * This deliberately small parser handles the data-only subset emitted for
 * `tools.web__run(...)` without evaluating session content in the browser.
 */
class JavaScriptLiteralParser {
  private index = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    const value = this.parseValue();
    this.skipWhitespace();
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
    if (identifier) return identifier;
    throw new Error("Unsupported JavaScript literal");
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
          if (/^[0-9a-f]{4}$/i.test(hex)) {
            value += String.fromCharCode(Number.parseInt(hex, 16));
            this.index += 4;
          } else {
            value += "u";
          }
          break;
        }
        case "x": {
          const hex = this.source.slice(this.index, this.index + 2);
          if (/^[0-9a-f]{2}$/i.test(hex)) {
            value += String.fromCharCode(Number.parseInt(hex, 16));
            this.index += 2;
          } else {
            value += "x";
          }
          break;
        }
        default:
          value += escaped ?? "";
      }
    }

    throw new Error("Unterminated string literal");
  }

  private parseNumber(): number {
    const match = this.source.slice(this.index).match(/^-?\d+(?:\.\d+)?/);
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

function extractWebRunArgument(script: string): string | null {
  const match = /\btools\.web__run\s*\(/.exec(script);
  if (!match) return null;

  const openIndex = script.indexOf("(", match.index);
  if (openIndex < 0) return null;

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
      if (depth === 0) return script.slice(openIndex + 1, index).trim();
    }
  }
  return null;
}

function parseWebRunInput(input: unknown): Record<string, unknown> | null {
  const argument = extractWebRunArgument(getCodexExecScript(input));
  if (!argument) return null;
  try {
    const parsed = new JavaScriptLiteralParser(argument).parse();
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function getString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function describeRef(record: Record<string, unknown>): string {
  const ref = getString(record, "ref_id") || getString(record, "url");
  const line = record.lineno;
  return typeof line === "number" ? `${ref} · line ${line}` : ref;
}

function describeOperationItem(
  kind: CodexWebOperationKind,
  value: unknown,
): string {
  if (!isRecord(value)) return String(value ?? "");

  switch (kind) {
    case "search":
    case "image-search":
      return getString(value, "q");
    case "open":
      return describeRef(value);
    case "click":
      return `${getString(value, "ref_id")} · link ${String(value.id ?? "?")}`;
    case "find":
      return `“${getString(value, "pattern")}” in ${getString(value, "ref_id")}`;
    case "screenshot":
      return `${getString(value, "ref_id")} · page ${String(value.pageno ?? "?")}`;
    case "finance":
      return [getString(value, "ticker"), getString(value, "type")]
        .filter(Boolean)
        .join(" · ");
    case "weather":
      return getString(value, "location");
    case "sports":
      return [getString(value, "league"), getString(value, "team")]
        .filter(Boolean)
        .join(" · ");
    case "time":
      return getString(value, "utc_offset");
  }
}

const OPERATION_SPECS: Array<{
  key: string;
  kind: CodexWebOperationKind;
  label: string;
}> = [
  { key: "search_query", kind: "search", label: "Search" },
  { key: "image_query", kind: "image-search", label: "Image search" },
  { key: "open", kind: "open", label: "Open" },
  { key: "click", kind: "click", label: "Click" },
  { key: "find", kind: "find", label: "Find" },
  { key: "screenshot", kind: "screenshot", label: "Screenshot" },
  { key: "finance", kind: "finance", label: "Finance" },
  { key: "weather", kind: "weather", label: "Weather" },
  { key: "sports", kind: "sports", label: "Sports" },
  { key: "time", kind: "time", label: "Time" },
];

function pluralize(count: number, singular: string): string {
  const noun =
    count === 1
      ? singular
      : singular.endsWith("y")
        ? `${singular.slice(0, -1)}ies`
        : `${singular}s`;
  return `${count} ${noun}`;
}

function buildWebSummary(operations: CodexWebOperation[]): string {
  if (operations.length === 0) return "Web request";
  const first = operations[0];
  if (!first) return "Web request";

  if (operations.length === 1) {
    const countLabel =
      first.kind === "search" || first.kind === "image-search"
        ? pluralize(first.items.length, "query")
        : pluralize(first.items.length, "request");
    const firstItem = first.items.length === 1 ? first.items[0] : undefined;
    return `${first.label} · ${countLabel}${firstItem ? ` · ${firstItem}` : ""}`;
  }

  return `${operations.length} web operations · ${operations
    .map((operation) => operation.label)
    .join(" · ")}`;
}

export function getCodexWebRunOverview(
  input: unknown,
): CodexWebRunOverview | null {
  const parsed = parseWebRunInput(input);
  if (!parsed) return null;

  const operations: CodexWebOperation[] = [];
  for (const spec of OPERATION_SPECS) {
    const rawItems = parsed[spec.key];
    if (!Array.isArray(rawItems)) continue;
    const items = rawItems
      .map((item) => describeOperationItem(spec.kind, item))
      .filter(Boolean);
    operations.push({ kind: spec.kind, label: spec.label, items });
  }

  const requestCount = operations.reduce(
    (total, operation) => total + operation.items.length,
    0,
  );
  const queryCount = operations
    .filter(
      (operation) =>
        operation.kind === "search" || operation.kind === "image-search",
    )
    .reduce((total, operation) => total + operation.items.length, 0);
  const responseLength = getString(parsed, "response_length") || undefined;

  return {
    operations,
    operationCount: operations.length,
    requestCount,
    queryCount,
    ...(responseLength && { responseLength }),
    summary: buildWebSummary(operations),
  };
}

function decodeJsonString(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"')) return value;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return typeof parsed === "string" ? parsed : value;
  } catch {
    return value;
  }
}

function collectWebSources(output: string): CodexWebSource[] {
  const sources: CodexWebSource[] = [];
  const seen = new Set<string>();
  const add = (title: string, url: string) => {
    const normalizedUrl = url.replace(/[.,;]+$/, "");
    if (!normalizedUrl || seen.has(normalizedUrl)) return;
    seen.add(normalizedUrl);
    sources.push({ title: title.trim() || normalizedUrl, url: normalizedUrl });
  };

  for (const line of output.split("\n")) {
    const markdown = line.match(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/);
    if (markdown?.[1] && markdown[2]) {
      add(markdown[1], markdown[2]);
      continue;
    }

    const titled = line.match(/^(.{1,300}?)\s+\((https?:\/\/[^)\s]+)\)\s*$/);
    if (titled?.[1] && titled[2]) {
      add(titled[1], titled[2]);
    }
  }

  return sources;
}

export function getCodexWebResultOverview(
  result: unknown,
  isError = false,
): CodexWebResultOverview {
  const exec = getCodexExecResultOverview(result, isError);
  const output = decodeJsonString(exec.output);
  return {
    exec,
    output,
    outputChars: output.length,
    outputLineCount: output ? output.split("\n").length : 0,
    sources: collectWebSources(output),
  };
}
