import { DEFAULT_PROVIDER, type ProviderInfo } from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";

let cachedProviders: ProviderInfo[] | null = null;
let providersRequest: Promise<{ providers: ProviderInfo[] }> | null = null;

function fetchProvidersShared(): Promise<{ providers: ProviderInfo[] }> {
  if (!providersRequest) {
    providersRequest = api.getProviders().finally(() => {
      providersRequest = null;
    });
  }
  return providersRequest;
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
 * Prefers the configured default provider, otherwise the first available one.
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
