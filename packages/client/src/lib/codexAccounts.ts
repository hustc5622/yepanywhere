import type { CodexAccountEntry } from "../api/client";

export const CODEX_ACCOUNTS_UPDATED = "yep:codex-accounts-updated";

/** The machine login and its saved profile are aliases of one account. */
export function visibleCodexAccounts(accounts: CodexAccountEntry[]) {
  const hasMachineAccount = accounts.some((entry) => entry.isDefault);
  return accounts.filter(
    (entry) => !hasMachineAccount || entry.isDefault || !entry.isActive,
  );
}
