import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type LlmGatewayChannelEntry,
  type LlmGatewayKeyEntry,
  api,
} from "../api/client";

export interface UseLlmGatewayKeysResult {
  channels: LlmGatewayChannelEntry[];
  /** Every key of every channel, flattened in channel order. */
  keys: LlmGatewayKeyEntry[];
  loading: boolean;
  /** A mutation (add/remove) is in flight. */
  busy: boolean;
  error: string | null;
  setError: (error: string | null) => void;
  refresh: (fresh?: boolean) => Promise<void>;
  addKey: (input: {
    channelId: string;
    apiKey: string;
    label: string | null;
  }) => Promise<boolean>;
  removeKey: (keyId: string) => Promise<boolean>;
}

/**
 * Loads the LLM gateway key pool of every configured channel.
 *
 * The new-session form needs this in two places at once (the key picker and
 * the model dropdown that narrows to the selected key's reachable models), so
 * the fetch lives here instead of inside the picker component.
 */
export function useLlmGatewayKeys(enabled = true): UseLlmGatewayKeysResult {
  const [channels, setChannels] = useState<LlmGatewayChannelEntry[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    async (fresh = false) => {
      if (!enabled) return;
      setLoading(true);
      try {
        const response = await api.getLlmGatewayKeys({ probe: true, fresh });
        setChannels(response.channels);
        setError(response.error);
      } catch (loadError) {
        setChannels([]);
        setError(
          loadError instanceof Error ? loadError.message : String(loadError),
        );
      } finally {
        setLoading(false);
      }
    },
    [enabled],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const addKey = useCallback(
    async (input: {
      channelId: string;
      apiKey: string;
      label: string | null;
    }) => {
      setBusy(true);
      setError(null);
      try {
        const response = await api.addLlmGatewayKey(input);
        if (response.error) {
          setError(response.error);
          return false;
        }
        await refresh(true);
        return true;
      } catch (addError) {
        setError(
          addError instanceof Error ? addError.message : String(addError),
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const removeKey = useCallback(
    async (keyId: string) => {
      setBusy(true);
      setError(null);
      try {
        await api.removeLlmGatewayKey(keyId);
        await refresh(true);
        return true;
      } catch (removeError) {
        setError(
          removeError instanceof Error
            ? removeError.message
            : String(removeError),
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const keys = useMemo(
    () => channels.flatMap((channel) => channel.keys),
    [channels],
  );

  return {
    channels,
    keys,
    loading,
    busy,
    error,
    setError,
    refresh,
    addKey,
    removeKey,
  };
}

/** Channel id a model id routes to, or `null` for the default channel. */
export function gatewayChannelIdForModel(
  channels: LlmGatewayChannelEntry[],
  modelId: string | undefined,
): string | null {
  if (!modelId) return null;
  const separator = modelId.indexOf("/");
  if (separator <= 0) return null;
  const prefix = modelId.slice(0, separator);
  return channels.some((channel) => channel.id === prefix) ? prefix : null;
}

/** Model id without its `channel/` prefix. */
export function bareGatewayModelId(modelId: string | undefined): string | null {
  if (!modelId) return null;
  const separator = modelId.indexOf("/");
  return separator > 0 ? modelId.slice(separator + 1) : modelId;
}
