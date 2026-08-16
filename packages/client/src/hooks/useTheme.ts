import { useCallback, useEffect, useState } from "react";
import { UI_KEYS } from "../lib/storageKeys";

export type Theme = "auto" | "light" | "dark" | "verydark";

const themeLabels: Record<Theme, string> = {
  auto: "Auto",
  light: "Light",
  dark: "Dark",
  verydark: "Very Dark",
};

export const THEMES: Theme[] = ["auto", "light", "dark", "verydark"];

const MOBILE_SHELL_THEME_MESSAGE = "yep-anywhere:mobile-shell-theme";
let mobileShellThemeListenerInstalled = false;

export function getThemeLabel(theme: Theme): string {
  return themeLabels[theme];
}

function isMobileShellFrame(): boolean {
  return (
    document.documentElement.dataset.mobileShell === "true" &&
    window.parent !== window
  );
}

function resolveTheme(theme: Theme): "light" | "dark" {
  if (theme !== "auto") return theme === "light" ? "light" : "dark";
  return typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

function syncMobileShellTheme(theme: Theme): void {
  if (!isMobileShellFrame()) return;

  window.parent.postMessage(
    {
      type: MOBILE_SHELL_THEME_MESSAGE,
      theme,
      resolvedTheme: resolveTheme(theme),
    },
    "*",
  );
}

function installMobileShellThemeListener(): void {
  if (mobileShellThemeListenerInstalled || !isMobileShellFrame()) return;
  mobileShellThemeListenerInstalled = true;

  const mediaQuery = window.matchMedia("(prefers-color-scheme: light)");
  const handleChange = () => {
    const theme = loadTheme();
    if (theme === "auto") syncMobileShellTheme(theme);
  };
  if (typeof mediaQuery.addEventListener === "function") {
    mediaQuery.addEventListener("change", handleChange);
  } else {
    mediaQuery.addListener(handleChange);
  }
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.setAttribute("data-theme", theme);
  syncMobileShellTheme(theme);
}

function loadTheme(): Theme {
  const stored = localStorage.getItem(UI_KEYS.theme);
  if (stored && THEMES.includes(stored as Theme)) {
    return stored as Theme;
  }
  return "auto";
}

function saveTheme(theme: Theme) {
  localStorage.setItem(UI_KEYS.theme, theme);
}

/**
 * Hook to manage theme preference.
 * Persists to localStorage and applies data-theme attribute.
 */
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(loadTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setTheme = useCallback((newTheme: Theme) => {
    setThemeState(newTheme);
    saveTheme(newTheme);
  }, []);

  return { theme, setTheme };
}

/**
 * Initialize theme on app load (call once at startup).
 * This runs before React renders to avoid flash of wrong theme.
 */
export function initializeTheme() {
  const theme = loadTheme();
  installMobileShellThemeListener();
  applyTheme(theme);
}

/**
 * Get current resolved theme (useful for components that need
 * to know if we're actually in light or dark mode when auto)
 */
export function getResolvedTheme(): "light" | "dark" {
  return resolveTheme(loadTheme());
}

/**
 * Hook to reactively get the resolved theme (light or dark).
 * Listens for both localStorage changes and system preference changes.
 */
export function useResolvedTheme(): "light" | "dark" {
  const [resolved, setResolved] = useState<"light" | "dark">(getResolvedTheme);

  useEffect(() => {
    const update = () => setResolved(getResolvedTheme());

    // Listen for system preference changes
    const mediaQuery = window.matchMedia("(prefers-color-scheme: light)");
    mediaQuery.addEventListener("change", update);

    // Listen for storage changes (theme changed in another tab or by useTheme)
    window.addEventListener("storage", update);

    // Also listen for attribute changes on documentElement (for same-tab updates)
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (
          mutation.type === "attributes" &&
          mutation.attributeName === "data-theme"
        ) {
          update();
          break;
        }
      }
    });
    observer.observe(document.documentElement, { attributes: true });

    return () => {
      mediaQuery.removeEventListener("change", update);
      window.removeEventListener("storage", update);
      observer.disconnect();
    };
  }, []);

  return resolved;
}
