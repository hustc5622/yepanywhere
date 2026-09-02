import { useCallback, useState } from "react";
import type { SearchSort } from "../api/client";
import { UI_KEYS } from "../lib/storageKeys";

/** Ordering used when neither the URL nor localStorage says otherwise. */
export const DEFAULT_SEARCH_SORT: SearchSort = "recent";

/** Narrow an untrusted string (URL param / storage value) to a SearchSort. */
export function parseSearchSort(
  raw: string | null | undefined,
): SearchSort | null {
  return raw === "recent" || raw === "relevance" ? raw : null;
}

function loadSortPreference(): SearchSort {
  if (typeof window === "undefined") return DEFAULT_SEARCH_SORT;
  try {
    return (
      parseSearchSort(window.localStorage.getItem(UI_KEYS.searchSort)) ??
      DEFAULT_SEARCH_SORT
    );
  } catch {
    return DEFAULT_SEARCH_SORT;
  }
}

function saveSortPreference(sort: SearchSort): void {
  try {
    window.localStorage.setItem(UI_KEYS.searchSort, sort);
  } catch {
    // Keep the in-memory preference when storage is unavailable.
  }
}

/**
 * Persist the search page's result ordering across visits.
 *
 * The URL `sort` param still wins for a single visit (shared links stay
 * self-describing); this hook only supplies the fallback and records whatever
 * ordering the user last landed on.
 */
export function useSearchSortPreference(): {
  storedSort: SearchSort;
  rememberSort: (sort: SearchSort) => void;
} {
  const [storedSort, setStoredSort] = useState<SearchSort>(loadSortPreference);

  const rememberSort = useCallback((sort: SearchSort) => {
    setStoredSort((prev) => (prev === sort ? prev : sort));
    saveSortPreference(sort);
  }, []);

  return { storedSort, rememberSort };
}
