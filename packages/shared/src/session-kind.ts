export const SLASH_COMMAND_SESSION_KIND = "slash-command" as const;
export type SessionKind = typeof SLASH_COMMAND_SESSION_KIND;

export const COMMAND_MESSAGE_SESSION_TITLE = "<command-message>";

const COMMAND_MESSAGE_TAG_PATTERN = /^<command-message(?:\s|>)/i;
const COMMAND_TITLE_PATTERN = /^[$/][A-Za-z][A-Za-z0-9_-]*(?:\s|$)/;
const GIT_COMMIT_PUSH_WORKFLOW_PATTERN =
  /^\$git(?:-|\s+)commit(?:-|\s+)push(?:\s|$)/i;

interface SessionTitleSource {
  title?: string | null;
  customTitle?: string | null;
}

export function isSessionKind(
  value: string | null | undefined,
): value is SessionKind {
  return value === SLASH_COMMAND_SESSION_KIND;
}

export function isSlashCommandSessionTitle(
  title: string | null | undefined,
): boolean {
  const trimmedTitle = title?.trim();
  if (!trimmedTitle) return false;

  // Codex git-commit-push sessions often continue into review and follow-up
  // work, so keep them in the regular session library instead of filing them
  // with one-off slash/skill commands.
  if (GIT_COMMIT_PUSH_WORKFLOW_PATTERN.test(trimmedTitle)) return false;

  return (
    COMMAND_MESSAGE_TAG_PATTERN.test(trimmedTitle) ||
    COMMAND_TITLE_PATTERN.test(trimmedTitle)
  );
}

export function isSlashCommandSession(session: SessionTitleSource): boolean {
  return isSlashCommandSessionTitle(session.customTitle ?? session.title);
}

export function sessionMatchesKind(
  session: SessionTitleSource,
  kind: SessionKind,
): boolean {
  switch (kind) {
    case SLASH_COMMAND_SESSION_KIND:
      return isSlashCommandSession(session);
  }
}
