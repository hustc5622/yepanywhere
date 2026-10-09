import { type CodexAccountEntry, api } from "../api/client";
import { getNewSessionScope, updateNewSessionLayout } from "./newSessionLayout";

/** The machine login and its saved profile are aliases of one account. */
export function visibleCodexAccounts(accounts: CodexAccountEntry[]) {
  const hasMachineAccount = accounts.some((entry) => entry.isDefault);
  return accounts.filter(
    (entry) => !hasMachineAccount || entry.isDefault || !entry.isActive,
  );
}

interface CodexAccountsSnapshot {
  accounts: CodexAccountEntry[] | null;
  loading: boolean;
  error: string | null;
}

function createAccountStore(scope: string) {
  let snapshot: CodexAccountsSnapshot = {
    accounts: null,
    loading: true,
    error: null,
  };
  let request: Promise<void> | null = null;
  let version = 0;
  const listeners = new Set<() => void>();
  const publish = (next: CodexAccountsSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const load = (fresh = false): Promise<void> => {
    if (request && !fresh) return request;
    const loadVersion = ++version;
    publish({ ...snapshot, loading: true, error: null });
    request = (async () => {
      try {
        const response = await api.getCodexAccounts({ fresh });
        if (loadVersion !== version) return;
        if (!response.error) {
          updateNewSessionLayout(
            {
              codexAccountCount: visibleCodexAccounts(response.accounts).length,
            },
            scope,
          );
        }
        publish({
          accounts:
            response.error && snapshot.accounts
              ? snapshot.accounts
              : response.accounts,
          loading: false,
          error: response.error,
        });
      } catch (error) {
        if (loadVersion !== version) return;
        publish({
          ...snapshot,
          loading: false,
          error: String(error instanceof Error ? error.message : error),
        });
      } finally {
        if (loadVersion === version) request = null;
      }
    })();
    return request;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load,
    refresh: () => load(true),
  };
}

const stores = new Map<string, ReturnType<typeof createAccountStore>>();

/** Share a live snapshot and in-flight reads between the picker and details. */
export function getCodexAccountsStore() {
  const scope = getNewSessionScope();
  let store = stores.get(scope);
  if (!store) {
    store = createAccountStore(scope);
    stores.set(scope, store);
  }
  return store;
}
