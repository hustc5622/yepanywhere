import { DEFAULT_PROVIDER, type ProviderInfo } from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";

let cachedProviders: ProviderInfo[] | null = null;
let providersRequest: Promise<{ providers: ProviderInfo[] }> | null = null;
let claudeRefreshRequest: Promise<{ provider: ProviderInfo }> | null = null;

function fetchProvidersShared(): Promise<{ providers: ProviderInfo[] }> {
  if (!providersRequest) {
    providersRequest = api.getProviders().finally(() => {
      providersRequest = null;
    });
  }
  return providersRequest;
}

function refreshClaudeProviderShared(): Promise<{ provider: ProviderInfo }> {
  if (!claudeRefreshRequest) {
    claudeRefreshRequest = api
      .getProvider("claude", { fresh: true })
      .finally(() => {
        claudeRefreshRequest = null;
      });
  }
  return claudeRefreshRequest;
}

function replaceProvider(
  providers: ProviderInfo[],
  nextProvider: ProviderInfo,
): ProviderInfo[] {
  return providers.map((provider) =>
    provider.name === nextProvider.name ? nextProvider : provider,
  );
}

/**
 * Hook to fetch and cache available AI providers with their auth status.
 *
 * Returns:
 * - providers: Array of provider info objects
 * - loading: Whether the initial fetch is in progress
 * - error: Any error that occurred during fetch
 * - refetch: Function to manually refresh provider status
 */
export function useProviders() {
  const [providers, setProviders] = useState<ProviderInfo[]>(
    () => cachedProviders ?? [],
  );
  const [loading, setLoading] = useState(cachedProviders === null);
  const [error, setError] = useState<Error | null>(null);
  const hasFetchedRef = useRef(false);

  const fetch = useCallback(async () => {
    // Keep the last provider snapshot interactive while revalidating. Several
    // screens consume this hook, so also share an in-flight request instead of
    // repeating CLI and remote-provider probes for every mounted consumer.
    setLoading(cachedProviders === null);
    setError(null);
    try {
      const data = await fetchProvidersShared();
      cachedProviders = data.providers;
      setProviders(data.providers);

      // The aggregate endpoint deliberately returns Claude's cached/fallback
      // catalog without waiting for SSH. Join its background probe and replace
      // that one entry when fresh remote metadata becomes available.
      if (data.providers.some((provider) => provider.name === "claude")) {
        void refreshClaudeProviderShared()
          .then(({ provider }) => {
            const nextProviders = replaceProvider(
              cachedProviders ?? data.providers,
              provider,
            );
            cachedProviders = nextProviders;
            setProviders(nextProviders);
          })
          .catch(() => {
            // The fast aggregate snapshot remains usable when SSH is offline.
          });
      }
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch - only once (avoid StrictMode double-fetch)
  useEffect(() => {
    if (hasFetchedRef.current) return;
    hasFetchedRef.current = true;
    fetch();
  }, [fetch]);

  return { providers, loading, error, refetch: fetch };
}

/**
 * Get the list of providers that are available (installed + authenticated/enabled).
 */
export function getAvailableProviders(
  providers: ProviderInfo[],
): ProviderInfo[] {
  return providers.filter((p) => p.installed && (p.authenticated || p.enabled));
}

/**
 * Get the default provider from available providers.
 * Prefers Claude if available, otherwise the first available provider.
 */
export function getDefaultProvider(
  providers: ProviderInfo[],
): ProviderInfo | null {
  const available = getAvailableProviders(providers);
  if (available.length === 0) return null;

  // Prefer the configured default provider.
  const defaultProv = available.find((p) => p.name === DEFAULT_PROVIDER);
  if (defaultProv) return defaultProv;

  // available[0] is guaranteed to exist since we checked length > 0
  return available[0] ?? null;
}
