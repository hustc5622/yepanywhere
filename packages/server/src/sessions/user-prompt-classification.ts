import { isCodexTurnAbortedNoticeText } from "./codex-turn-aborted.js";

const SESSION_SETUP_PREFIXES = [
  "# AGENTS.md instructions",
  "<environment_context>",
];

const SYNTHETIC_USER_PROMPT_PREFIXES = [
  "<permissions instructions>",
  "<recommended_plugins>",
  "<skill>",
  "<skills_instructions>",
];

export function isSessionSetupText(text: string): boolean {
  const trimmed = text.trimStart();
  return SESSION_SETUP_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

export function isSyntheticUserPromptText(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    isSessionSetupText(trimmed) ||
    SYNTHETIC_USER_PROMPT_PREFIXES.some((prefix) =>
      trimmed.startsWith(prefix),
    ) ||
    isCodexTurnAbortedNoticeText(trimmed)
  );
}
