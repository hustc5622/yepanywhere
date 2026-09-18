import {
  extractBashCommandFromInput,
  isShellLauncherWrappedCommand,
  unwrapShellLauncherCommand,
} from "@yep-anywhere/shared";

export {
  isShellLauncherWrappedCommand,
  unwrapShellLauncherCommand,
} from "@yep-anywhere/shared";

export function getDisplayBashCommandFromInput(input: unknown): string {
  const raw = extractBashCommandFromInput(input);
  if (!raw) {
    return "";
  }
  return unwrapShellLauncherCommand(raw);
}

export function isCodexProvider(provider?: string): boolean {
  return provider === "codex" || provider === "codex-oss";
}

export function isCodexLikeBashInput(
  input: unknown,
  provider?: string,
): boolean {
  if (isCodexProvider(provider)) {
    return true;
  }

  const raw = extractBashCommandFromInput(input);
  if (!raw) {
    return false;
  }

  return isShellLauncherWrappedCommand(raw);
}
