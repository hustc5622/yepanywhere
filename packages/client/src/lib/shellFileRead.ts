/**
 * Recognize shell commands that only print one file, so the transcript can
 * offer to open that file in the side panel. Provider-agnostic: Codex
 * (`nl -ba f | sed -n '1,80p'`), Claude/Pi Bash (`cat f`, `head -n 50 f`), …
 */

export interface ShellFileRead {
  path: string;
  lineNumber?: number;
  lineEnd?: number;
}

/** Minimal POSIX-ish word splitter: quotes and backslashes, no expansion. */
function splitWords(segment: string): string[] | null {
  const words: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let hasWord = false;
  for (let i = 0; i < segment.length; i++) {
    const char = segment[i] as string;
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && i + 1 < segment.length) {
        const next = segment[i + 1] as string;
        if ('$`"\\'.includes(next)) current += segment[++i];
        else current += char;
      } else {
        if (quote === '"' && (char === "$" || char === "`")) return null;
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      hasWord = true;
    } else if (char === "\\" && i + 1 < segment.length) {
      current += segment[++i];
      hasWord = true;
    } else if (/\s/.test(char)) {
      if (hasWord) words.push(current);
      current = "";
      hasWord = false;
    } else {
      // Expansions, redirects and globs make the target unknowable.
      if ("$`<>*?(){};&".includes(char)) return null;
      current += char;
      hasWord = true;
    }
  }
  if (quote) return null;
  if (hasWord) words.push(current);
  return words;
}

/** `sed -n '12,40p'` / `sed -n 12p` → line range. */
function parseSedRange(
  args: string[],
): { start: number; end: number; file?: string } | null {
  const rest = args.filter((arg) => arg !== "-n");
  if (!args.includes("-n") || rest.length === 0 || rest.length > 2) return null;
  const match = /^(\d+)(?:,(\d+))?p$/.exec(rest[0] ?? "");
  if (!match) return null;
  const start = Number(match[1]);
  return { start, end: match[2] ? Number(match[2]) : start, file: rest[1] };
}

function parseHeadCount(args: string[]): { count?: number; file?: string } {
  let count: number | undefined;
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "-n" && args[i + 1]) count = Number(args[++i]);
    else if (/^-n\d+$/.test(arg)) count = Number(arg.slice(2));
    else if (/^-\d+$/.test(arg)) count = Number(arg.slice(1));
    else if (arg.startsWith("-")) return { file: undefined };
    else files.push(arg);
  }
  return { count, file: files.length === 1 ? files[0] : undefined };
}

/** The single file operand of a reader command, ignoring its flags. */
function readerOperand(words: string[]): string | undefined {
  const [command, ...args] = words;
  const allowedFlags: Record<string, RegExp> = {
    cat: /^-[nAbsetv]+$/,
    nl: /^-(ba|b|a|n\S*|w\d+)$/,
    bat: /^(-p|--plain|-n|--number|--paging=never)$/,
    less: /^-[NRSX]+$/,
  };
  const pattern = command ? allowedFlags[command] : undefined;
  if (!pattern) return undefined;
  const files = args.filter((arg) => !pattern.test(arg));
  if (files.some((file) => file.startsWith("-"))) return undefined;
  return files.length === 1 ? files[0] : undefined;
}

function readFromSegment(words: string[]): ShellFileRead | null {
  const [command, ...args] = words;
  if (!command) return null;
  if (command === "sed") {
    const range = parseSedRange(args);
    return range?.file
      ? { path: range.file, lineNumber: range.start, lineEnd: range.end }
      : null;
  }
  if (command === "head") {
    const { count, file } = parseHeadCount(args);
    if (!file) return null;
    return count
      ? { path: file, lineNumber: 1, lineEnd: count }
      : { path: file };
  }
  if (command === "tail") {
    const { file } = parseHeadCount(args);
    return file ? { path: file } : null;
  }
  const file = readerOperand(words);
  return file ? { path: file } : null;
}

/**
 * Detect `reader FILE` or `reader FILE | sed -n 'a,bp'` / `| head -n N`.
 * Returns null for anything else (compound commands, redirects, globs, …).
 */
export function detectShellFileRead(command: string): ShellFileRead | null {
  const trimmed = command.trim();
  if (!trimmed || trimmed.includes("\n")) return null;
  const segments = trimmed.split("|");
  if (segments.length > 2 || segments.some((part) => part.trim() === "")) {
    return null;
  }
  const words = segments.map((part) => splitWords(part.trim()));
  if (words.some((part) => !part || part.length === 0)) return null;
  const [first, second] = words as string[][];
  if (!first) return null;

  const read = readFromSegment(first);
  if (!read) return null;
  if (!second) return read;

  // Only a range filter may follow, applied to a whole-file reader.
  if (read.lineNumber !== undefined || !readerOperand(first)) return null;
  const [filter, ...filterArgs] = second;
  if (filter === "sed") {
    const range = parseSedRange(filterArgs);
    if (!range || range.file) return null;
    return { ...read, lineNumber: range.start, lineEnd: range.end };
  }
  if (filter === "head") {
    const { count, file } = parseHeadCount(filterArgs);
    if (file || !count) return null;
    return { ...read, lineNumber: 1, lineEnd: count };
  }
  return null;
}
