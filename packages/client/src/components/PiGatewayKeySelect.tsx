import { useCallback, useEffect, useMemo, useState } from "react";
import type { LlmGatewayChannelEntry, LlmGatewayKeyEntry } from "../api/client";
import {
  bareGatewayModelId,
  gatewayChannelIdForModel,
} from "../hooks/useLlmGatewayKeys";
import { useI18n } from "../i18n";

interface PiGatewayKeySelectProps {
  /** Selected key id; `null` means the default channel's environment key. */
  value: string | null;
  onChange: (keyId: string | null) => void;
  /**
   * Model the session will start with, channel-qualified (`aitl/claude-opus-5`)
   * or bare for the default channel. Only used to annotate which keys match the
   * currently selected model; it never hides keys.
   */
  modelId?: string;
  disabled?: boolean;
  channels: LlmGatewayChannelEntry[];
  loading: boolean;
  busy: boolean;
  error: string | null;
  onAdd: (input: {
    channelId: string;
    apiKey: string;
    label: string | null;
  }) => Promise<boolean>;
  onRemove: (keyId: string) => Promise<boolean>;
  onRefresh: (fresh?: boolean) => Promise<void>;
}

/** Whether `key` can serve `bareModelId`, given what the probe reported. */
function keyReachesModel(
  key: LlmGatewayKeyEntry,
  bareModelId: string | null,
): boolean {
  const models = key.status?.models ?? [];
  if (!bareModelId || key.status?.ok !== true || models.length === 0) {
    return true;
  }
  return models.includes(bareModelId);
}

/**
 * Picks which gateway API key the new Pi session runs on, and manages the key
 * pool of every configured gateway.
 *
 * Every channel's keys are always listed, even before a model is chosen, so a
 * freshly added key never disappears. Selecting a key is the primary action:
 * the model dropdown narrows to what that key can actually reach.
 */
export function PiGatewayKeySelect({
  value,
  onChange,
  modelId,
  disabled,
  channels,
  loading,
  busy,
  error,
  onAdd,
  onRemove,
  onRefresh,
}: PiGatewayKeySelectProps) {
  const { t } = useI18n();
  const [adding, setAdding] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [addChannelId, setAddChannelId] = useState<string | null>(null);

  const defaultChannel = useMemo(
    () => channels.find((channel) => channel.isDefault) ?? channels[0] ?? null,
    [channels],
  );
  const modelChannelId = useMemo(
    () => gatewayChannelIdForModel(channels, modelId),
    [channels, modelId],
  );
  const modelChannel = useMemo(
    () =>
      modelChannelId
        ? (channels.find((channel) => channel.id === modelChannelId) ?? null)
        : defaultChannel,
    [channels, defaultChannel, modelChannelId],
  );
  const bareModelId = useMemo(() => bareGatewayModelId(modelId), [modelId]);

  const allKeys = useMemo(
    () => channels.flatMap((channel) => channel.keys),
    [channels],
  );
  const defaultEnvKeyId =
    defaultChannel?.keys.find((key) => key.isEnvKey)?.id ?? null;
  const selectedId = value ?? defaultEnvKeyId;
  const selectedKey = allKeys.find((key) => key.id === selectedId) ?? null;

  // Drop a stale selection (key removed on the server) instead of silently
  // starting the session on a different credential.
  useEffect(() => {
    if (loading || !value || channels.length === 0) return;
    if (!allKeys.some((key) => key.id === value)) onChange(null);
  }, [allKeys, channels.length, loading, onChange, value]);

  const activeAddChannelId =
    addChannelId ??
    selectedKey?.channelId ??
    modelChannel?.id ??
    defaultChannel?.id ??
    null;

  const handleAdd = useCallback(async () => {
    if (!activeAddChannelId || !newKey.trim()) return;
    const ok = await onAdd({
      channelId: activeAddChannelId,
      apiKey: newKey.trim(),
      label: newLabel.trim() || null,
    });
    if (!ok) return;
    setNewKey("");
    setNewLabel("");
    setAdding(false);
    setAddChannelId(null);
  }, [activeAddChannelId, newKey, newLabel, onAdd]);

  const handleRemove = useCallback(
    async (keyId: string) => {
      if (value === keyId) onChange(null);
      await onRemove(keyId);
    },
    [onChange, onRemove, value],
  );

  if (loading && channels.length === 0) return null;
  if (channels.length === 0) return null;

  const renderKey = (
    channel: LlmGatewayChannelEntry,
    key: LlmGatewayKeyEntry,
  ) => {
    const status = key.status;
    const reachable = status?.ok !== false;
    const supportsModel = keyReachesModel(key, bareModelId);
    const otherGateway = modelChannel ? channel.id !== modelChannel.id : false;
    const name = key.isEnvKey
      ? t("newSessionGatewayKeyEnvName")
      : (key.label ?? key.preview);
    const meta: string[] = [];
    if (key.isEnvKey || key.label) meta.push(key.preview);
    if (status?.modelCount !== null && status?.modelCount !== undefined) {
      meta.push(t("newSessionGatewayKeyModels", { count: status.modelCount }));
    }
    if (status?.balanceUsd !== null && status?.balanceUsd !== undefined) {
      meta.push(
        t("newSessionGatewayKeyBalance", {
          amount: status.balanceUsd.toFixed(2),
        }),
      );
    }
    const notes: { tone: "warn" | "error"; text: string }[] = [];
    if (!reachable) {
      notes.push({
        tone: "error",
        text: t("newSessionGatewayKeyUnreachable", {
          error: status?.error ?? "",
        }),
      });
    } else if (otherGateway) {
      notes.push({
        tone: "warn",
        text: t("newSessionGatewayKeySwitchesGateway", {
          gateway: channel.label,
        }),
      });
    } else if (!supportsModel && bareModelId) {
      notes.push({
        tone: "warn",
        text: t("newSessionGatewayKeyModelUnsupported", { model: bareModelId }),
      });
    }
    const selected = selectedId === key.id;
    return (
      <div
        className={`gateway-key-row ${selected ? "selected" : ""}`}
        key={key.id}
      >
        <button
          type="button"
          className={`gateway-key-option ${selected ? "selected" : ""}`}
          onClick={() =>
            onChange(
              key.isEnvKey && channel.id === defaultChannel?.id ? null : key.id,
            )
          }
          disabled={disabled || busy || !reachable}
          aria-pressed={selected}
        >
          <span className="gateway-key-dot" aria-hidden />
          <span className="gateway-key-body">
            <span className="gateway-key-title">
              <span className="gateway-key-name">{name}</span>
              {key.isEnvKey && (
                <span className="gateway-key-badge">
                  {t("newSessionGatewayKeyEnvBadge")}
                </span>
              )}
            </span>
            {meta.length > 0 && (
              <span className="gateway-key-meta">{meta.join(" · ")}</span>
            )}
            {notes.map((note) => (
              <span
                className={`gateway-key-note gateway-key-note-${note.tone}`}
                key={note.text}
              >
                {note.text}
              </span>
            ))}
          </span>
        </button>
        {!key.isEnvKey && (
          <button
            type="button"
            className="gateway-key-remove"
            onClick={() => void handleRemove(key.id)}
            disabled={disabled || busy}
            aria-label={t("gatewayKeysRemove")}
            title={t("gatewayKeysRemove")}
          >
            ×
          </button>
        )}
      </div>
    );
  };

  const multiChannel = channels.length > 1;

  return (
    <div className="new-session-gateway-key-section">
      <div className="new-session-gateway-key-header">
        <h3>{t("newSessionGatewayKeyTitle")}</h3>
        <div className="gateway-key-header-actions">
          {!adding && (
            <button
              type="button"
              className="gateway-key-text-button"
              onClick={() => setAdding(true)}
              disabled={disabled || busy}
            >
              {t("gatewayKeysAdd")}
            </button>
          )}
          <button
            type="button"
            className="gateway-key-text-button"
            onClick={() => void onRefresh(true)}
            disabled={disabled || busy || loading}
          >
            {loading ? t("gatewayKeysChecking") : t("gatewayKeysRefresh")}
          </button>
        </div>
      </div>
      <p className="new-session-section-hint">
        {t("newSessionGatewayKeyHint")}
      </p>

      <div className="gateway-key-list">
        {channels.map((channel) => (
          <div className="gateway-key-group" key={channel.id}>
            {multiChannel && (
              <div className="gateway-key-group-header">
                <span className="gateway-key-group-name">{channel.label}</span>
                {modelChannel?.id === channel.id && bareModelId && (
                  <span className="gateway-key-group-tag">
                    {t("newSessionGatewayKeyCurrentModelGateway")}
                  </span>
                )}
              </div>
            )}
            {channel.keys.length === 0 ? (
              <p className="gateway-key-empty">{t("gatewayKeysEmpty")}</p>
            ) : (
              channel.keys.map((key) => renderKey(channel, key))
            )}
          </div>
        ))}
      </div>

      {adding && (
        <div className="gateway-key-add-form">
          {multiChannel && (
            <label className="gateway-key-add-channel">
              <span>{t("gatewayKeysChannelLabel")}</span>
              <select
                value={activeAddChannelId ?? ""}
                onChange={(event) => setAddChannelId(event.target.value)}
                disabled={busy}
              >
                {channels.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    {channel.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <input
            type="password"
            autoComplete="off"
            value={newKey}
            placeholder={t("gatewayKeysApiKeyPlaceholder")}
            onChange={(event) => setNewKey(event.target.value)}
            disabled={busy}
          />
          <input
            type="text"
            value={newLabel}
            placeholder={t("gatewayKeysLabelPlaceholder")}
            onChange={(event) => setNewLabel(event.target.value)}
            disabled={busy}
          />
          <div className="gateway-key-add-actions">
            <button
              type="button"
              className="gateway-key-primary-button"
              onClick={() => void handleAdd()}
              disabled={busy || !newKey.trim()}
            >
              {busy ? t("gatewayKeysChecking") : t("gatewayKeysSave")}
            </button>
            <button
              type="button"
              className="gateway-key-text-button"
              onClick={() => {
                setAdding(false);
                setNewKey("");
                setNewLabel("");
                setAddChannelId(null);
              }}
              disabled={busy}
            >
              {t("gatewayKeysCancel")}
            </button>
          </div>
        </div>
      )}
      {error && <p className="new-session-limit-error">{error}</p>}
    </div>
  );
}
