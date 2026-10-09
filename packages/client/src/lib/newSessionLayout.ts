import type { LiveProviderName } from "@yep-anywhere/shared";
import { API_BASE } from "./apiPath";
import { getCurrentInstallId } from "./storageKeys";

interface NewSessionLayout {
  provider?: LiveProviderName;
  codexAccountCount?: number;
  piGatewayKeyCounts?: number[];
}

export function getNewSessionScope(): string {
  return getCurrentInstallId() ?? API_BASE;
}

/** Only layout hints are persisted; live account data stays in memory. */
export function getNewSessionLayout(
  scope = getNewSessionScope(),
): NewSessionLayout {
  try {
    const value = JSON.parse(
      sessionStorage.getItem(`new-session-layout:${scope}`) ?? "{}",
    );
    return {
      provider:
        typeof value?.provider === "string" ? value.provider : undefined,
      codexAccountCount:
        Number.isSafeInteger(value?.codexAccountCount) &&
        value.codexAccountCount >= 0
          ? value.codexAccountCount
          : undefined,
      piGatewayKeyCounts:
        Array.isArray(value?.piGatewayKeyCounts) &&
        value.piGatewayKeyCounts.every(
          (count: unknown) =>
            typeof count === "number" &&
            Number.isSafeInteger(count) &&
            count >= 0,
        )
          ? value.piGatewayKeyCounts
          : undefined,
    };
  } catch {
    return {};
  }
}

export function updateNewSessionLayout(
  patch: NewSessionLayout,
  scope = getNewSessionScope(),
): void {
  try {
    sessionStorage.setItem(
      `new-session-layout:${scope}`,
      JSON.stringify({ ...getNewSessionLayout(scope), ...patch }),
    );
  } catch {
    // Storage may be unavailable; a generic skeleton is still usable.
  }
}
