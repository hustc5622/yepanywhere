const OPEN_CODE_DEFAULT_TITLE_PATTERN =
  /^(?:new|child) session(?:\s*-\s*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/i;

const ENGLISH_TITLE_PREAMBLE_PATTERN =
  /^(?:(?:here(?:['’]s| is)|this is)\s+)?(?:a\s+)?title\s+(?:for\s+)?(?:this\s+)?(?:conversation|chat)\s*:?$/i;

const ENGLISH_TITLE_SUGGESTIONS_PATTERN =
  /^based on\b[\s\S]*\bhere (?:are|is) (?:some )?title suggestions?\s*:?$/i;

const ENGLISH_TITLE_PREAMBLE_PREFIX_PATTERN =
  /^(?:(?:here(?:['’]s| is)|this is)\s+)?(?:a\s+)?title\s+(?:for\s+)?(?:this\s+)?(?:conversation|chat)\s*:\s*/i;

const ENGLISH_TITLE_SUGGESTIONS_PREFIX_PATTERN =
  /^based on\b[\s\S]*?\bhere (?:are|is) (?:some )?title suggestions?\s*:\s*/i;

const CHINESE_TITLE_PREAMBLE_PATTERNS = [
  /^根据这个对话的内容[，,]\s*我为其生成的标题是\s*[：:]?$/,
  /^以下是标题\s*[：:]?$/,
  /^(?:#{1,6}\s*)?(?:对话标题|建议的标题)\s*[：:]?(?:\s+#{1,6})?$/,
] as const;

const CHINESE_TITLE_PREAMBLE_PREFIX_PATTERNS = [
  /^根据这个对话的内容[，,]\s*我为其生成的标题是\s*[：:]\s*/,
  /^以下是标题\s*[：:]\s*/,
  /^(?:#{1,6}\s*)?(?:对话标题|建议的标题)\s*[：:]\s*/,
] as const;

/**
 * Whether a title starts with a clear explanatory label. Unlike
 * `isGenericProviderTitle`, this also catches a topic appended after the
 * label, so strict AI-output validation can reject the whole response rather
 * than silently storing conversational boilerplate.
 */
export function hasProviderTitleBoilerplatePrefix(
  title: string | null | undefined,
): boolean {
  const normalized = title?.trim();
  if (!normalized) return false;

  return (
    ENGLISH_TITLE_PREAMBLE_PREFIX_PATTERN.test(normalized) ||
    ENGLISH_TITLE_SUGGESTIONS_PREFIX_PATTERN.test(normalized) ||
    CHINESE_TITLE_PREAMBLE_PREFIX_PATTERNS.some((pattern) =>
      pattern.test(normalized),
    )
  );
}

/**
 * Whether a provider-generated title is only a default label or explanatory
 * preamble, rather than a topic a user could use to find the session later.
 *
 * Patterns intentionally match the whole value. This keeps real topics such
 * as "修复 OpenCode 标题生成漂移" from being rejected merely because they
 * mention titles.
 */
export function isGenericProviderTitle(
  title: string | null | undefined,
): boolean {
  const normalized = title?.trim();
  if (!normalized) return false;

  return (
    normalized.toLowerCase() === "yep anywhere session" ||
    OPEN_CODE_DEFAULT_TITLE_PATTERN.test(normalized) ||
    ENGLISH_TITLE_PREAMBLE_PATTERN.test(normalized) ||
    ENGLISH_TITLE_SUGGESTIONS_PATTERN.test(normalized) ||
    CHINESE_TITLE_PREAMBLE_PATTERNS.some((pattern) => pattern.test(normalized))
  );
}

/** Trim a usable provider title, returning null for empty or generic output. */
export function normalizeProviderGeneratedTitle(
  title: string | null | undefined,
): string | null {
  const normalized = title?.trim();
  if (!normalized || isGenericProviderTitle(normalized)) return null;
  return normalized;
}
