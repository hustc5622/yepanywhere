import { useEffect, useSyncExternalStore } from "react";
import { getCodexAccountsStore } from "../lib/codexAccounts";

export function useCodexAccounts() {
  const store = getCodexAccountsStore();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => {
    void store.load();
  }, [store]);
  return { ...snapshot, refresh: store.refresh };
}
