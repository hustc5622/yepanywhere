/**
 * Shell launcher recognition and unwrapping.
 *
 * Codex (and any provider that shells out through a login shell) reports tool
 * calls as `/bin/bash -lc "<real command>"`. Both the server normalizer and the
 * client renderers need the bare command: the server to classify and summarize
 * the call, the client to display it. Those two ends previously carried
 * byte-identical private copies of this logic, so a fix to one silently left
 * the other reporting a different command for the same tool call.
 *
 * Dependency-free on purpose — no node builtins, no React — so it stays usable
 * from the browser bundle, the server and the bridge sidecars alike.
 */

const SHELL_EXECUTABLES = new Set(["bash", "sh", "zsh", "dash"]);

/** Basename of an executable path, lowercased, accepting Windows separators. */
function getExecutableName(token: string): string {
  const normalized = token.replace(/\\/g, "/");
  const name = normalized.split("/").pop() || token;
  return name.toLowerCase();
}

function isShellExecutable(token: string): boolean {
  return SHELL_EXECUTABLES.has(getExecutableName(token));
}

/**
 * Split a command into tokens, honouring single quotes, double quotes and
 * backslash escapes.
 *
 * This is deliberately not a full shell parser: it only needs to be good
 * enough to recognize a launcher prefix and to hand the remainder back. An
 * unterminated quote yields the tokens accumulated so far rather than throwing,
 * because the input is a command that already ran — refusing to parse it would
 * mean refusing to display it.
 */
export function tokenizeShellCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const char of command) {
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

/**
 * Number of leading tokens that form a shell launcher prefix, or 0.
 *
 * Only `-lc` is recognized. A bare `-c` is intentionally excluded: providers
 * that matter here always use a login shell, and treating every `sh -c` as a
 * wrapper would strip commands the user actually wrote.
 */
export function getShellLauncherPrefixLength(tokens: string[]): number {
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

/** Whether a command is a launcher wrapping some other command. */
export function isShellLauncherWrappedCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) {
    return false;
  }
  const tokens = tokenizeShellCommand(trimmed);
  const launcherPrefixLength = getShellLauncherPrefixLength(tokens);
  return launcherPrefixLength > 0 && tokens.length > launcherPrefixLength;
}

/** Maximum launcher layers peeled by {@link unwrapShellLauncherCommand}. */
const MAX_LAUNCHER_DEPTH = 3;

/**
 * Strip launcher prefixes to recover the command a user would recognize.
 *
 * Nesting happens in practice (`bash -lc "env bash -lc \"...\""`), so up to
 * {@link MAX_LAUNCHER_DEPTH} layers are peeled. The bound is what keeps a
 * pathological input from looping; a command wrapped more deeply than that is
 * returned partially unwrapped rather than not at all.
 */
export function unwrapShellLauncherCommand(command: string): string {
  let normalized = command.trim();

  for (let i = 0; i < MAX_LAUNCHER_DEPTH; i++) {
    const tokens = tokenizeShellCommand(normalized);
    const launcherPrefixLength = getShellLauncherPrefixLength(tokens);
    if (launcherPrefixLength === 0 || tokens.length <= launcherPrefixLength) {
      break;
    }
    normalized = tokens.slice(launcherPrefixLength).join(" ").trim();
  }

  return normalized;
}

/**
 * Raw command string from a bash-like tool input, still wrapped.
 *
 * Providers disagree on the field name: Claude's Bash tool uses `command`,
 * some ACP bridges use `cmd`. Both are accepted, `command` first.
 */
export function extractBashCommandFromInput(input: unknown): string {
  if (!input || typeof input !== "object") {
    return "";
  }

  const candidate = input as Record<string, unknown>;
  if (typeof candidate.command === "string" && candidate.command.trim()) {
    return candidate.command.trim();
  }

  if (typeof candidate.cmd === "string" && candidate.cmd.trim()) {
    return candidate.cmd.trim();
  }

  return "";
}
