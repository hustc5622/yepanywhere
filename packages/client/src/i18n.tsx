import {
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import enMessages from "./i18n/en.json";
import { UI_KEYS } from "./lib/storageKeys";

export const SUPPORTED_LOCALES = ["en", "zh-CN"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

const DEFAULT_LOCALE: Locale = "en";

const defaultMessages = enMessages;
type Messages = typeof defaultMessages;
type MessageKey = keyof Messages;

const localeLoaders: Record<Locale, () => Promise<Partial<Messages>>> = {
  en: async () => defaultMessages,
  "zh-CN": async () => (await import("./i18n/zh-CN.json")).default,
};

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function isLocale(value: string | null): value is Locale {
  return value !== null && SUPPORTED_LOCALES.includes(value as Locale);
}

function detectLocale(): Locale {
  const stored =
    typeof localStorage !== "undefined" &&
    typeof localStorage.getItem === "function"
      ? localStorage.getItem(UI_KEYS.locale)
      : null;
  if (isLocale(stored)) return stored;
  if (navigator.language.toLowerCase().startsWith("zh")) return "zh-CN";
  return DEFAULT_LOCALE;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectLocale);
  const [messages, setMessages] = useState<
    Partial<Record<Locale, Partial<Messages>>>
  >({
    en: defaultMessages,
  });

  useEffect(() => {
    if (
      typeof localStorage !== "undefined" &&
      typeof localStorage.setItem === "function"
    ) {
      localStorage.setItem(UI_KEYS.locale, locale);
    }
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    if (messages[locale]) return;

    let cancelled = false;

    void localeLoaders[locale]().then((loadedMessages) => {
      if (cancelled) return;
      setMessages((current) => ({ ...current, [locale]: loadedMessages }));
    });

    return () => {
      cancelled = true;
    };
  }, [locale, messages]);

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale: setLocaleState,
      t: (key, vars) => {
        const activeMessages = messages[locale] ?? defaultMessages;
        let text = String(activeMessages[key] ?? defaultMessages[key]);
        if (!vars) return text;
        for (const [name, value] of Object.entries(vars)) {
          text = text.replaceAll(`{${name}}`, String(value));
        }
        return text;
      },
    }),
    [locale, messages],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used within I18nProvider");
  }
  return context;
}
