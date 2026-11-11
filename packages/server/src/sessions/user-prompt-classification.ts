import { isCodexTurnAbortedNoticeText } from "./codex-turn-aborted.js";

const SESSION_SETUP_PREFIXES = [
  "# AGENTS.md instructions",
  "<environment_context>",
];

const SYNTHETIC_USER_PROMPT_PREFIXES = [
  "<permissions instructions>",
  "<skill>",
  "<skills_instructions>",
  // Codex host context recorded with the user role: goal continuation and
  // budget steering (`source="goal"`), user goal edits (`source="user_goal"`)
  // and the pre-0.16x goal wrapper. None of it is typed by the user.
  "<codex_internal_context",
  "<goal_context>",
  // Cursor writes this after a background task and stores it as a user query.
  "Briefly inform the user about the task result",
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
