import type { Locale } from "../i18n";

/**
 * Locale-aware "smart" datetime formatter for session list cards.
 *
 * The output favors information density over strict precision: a card glance
 * should tell you "today vs days ago vs years ago" without forcing the eye
 * to parse a full ISO timestamp.
 *
 *   今天      → "14:32"
 *   昨天      → "昨天 09:15"
 *   本周内    → "周一 21:08" (uses locale's short weekday name)
 *   本年内    → "5月20日 18:44"
 *   跨年      → "2024-05-20 10:01"
 *
 * "Today" / "yesterday" are computed on **calendar days**, not 24-hour
 * offsets — a message at 23:50 yesterday should read "昨天 23:50" at 00:10
 * today, not "10 minutes ago".
 *
 * For testability the caller can inject `now`; production calls just rely on
 * the default (current wall clock).
 */
export function formatSmartTime(
  iso: string | number | Date,
  locale: Locale,
  now: Date = new Date(),
): string {
  const date = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(date.getTime())) return "";

  const todayStart = startOfDay(now);
  const dateStart = startOfDay(date);
  const daysAgo = Math.round(
    (todayStart.getTime() - dateStart.getTime()) / 86_400_000,
  );

  const time = formatTime(date, locale);

  if (daysAgo <= 0) return time;
  if (daysAgo === 1) return `${YESTERDAY[locale]} ${time}`;
  if (daysAgo < 7) return `${formatWeekday(date, locale)} ${time}`;

  if (date.getFullYear() === now.getFullYear()) {
    return `${formatMonthDay(date, locale)} ${time}`;
  }
  return `${formatFullDate(date)} ${time}`;
}

/** "昨天" / "Yesterday" — translated standalone. */
const YESTERDAY: Record<Locale, string> = {
  en: "Yesterday",
  "zh-CN": "昨天",
};

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** "14:32" — 24h, locale-formatted. */
function formatTime(date: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

/** "周一" / "Mon" — short weekday name in the user's locale. */
function formatWeekday(date: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { weekday: "short" }).format(date);
}

/** "5月20日" / "May 20" — month + day, locale-formatted. */
function formatMonthDay(date: Date, locale: Locale): string {
  // Chinese renders "5月20日" with month: "long"; English uses "May 20".
  const month: "long" | "short" = locale === "zh-CN" ? "long" : "short";
  return new Intl.DateTimeFormat(locale, {
    month,
    day: "numeric",
  }).format(date);
}

/** "2024-05-20" — ISO-style for cross-year dates, locale-independent so the
 *  ordering doesn't surprise users skimming a list. */
function formatFullDate(date: Date): string {
  // en-CA happens to format YYYY-MM-DD natively — clearer than building it
  // by hand and ensures consistent zero-padding.
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
