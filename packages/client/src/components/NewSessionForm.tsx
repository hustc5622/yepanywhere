import {
  type CodexMcpMode,
  DEFAULT_PERMISSION_MODE,
  type LiveProviderName,
  type LlmGatewayModelCapabilities,
  type LlmGatewayModelLimits,
  type LlmGatewayRequestProtocol,
  type LlmGatewaySessionConfig,
  type ModelInfo,
  type NewSessionProviderDefaults,
  type ProviderInfo,
  type ProviderMcpServerStatus,
  getLlmGatewayModelDefaultLimits,
  getNewSessionProviderDefaults,
  resolveModel,
} from "@yep-anywhere/shared";
import {
  type CSSProperties,
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import { type UploadedFile, api } from "../api/client";
import { ENTER_SENDS_MESSAGE } from "../constants";
import { useToastContext } from "../contexts/ToastContext";
import { useConnection } from "../hooks/useConnection";
import { useDraftPersistence } from "../hooks/useDraftPersistence";
import {
  EFFORT_LEVEL_OPTIONS,
  type EffortLevel,
  type ThinkingMode,
  type ThinkingOption,
  getModelSetting,
  useModelSettings,
} from "../hooks/useModelSettings";
import { useProviderPermissionModeConfig } from "../hooks/useProviderPermissionModeConfig";
import {
  getAvailableProviders,
  getDefaultProvider,
  useProviders,
} from "../hooks/useProviders";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useServerSettings } from "../hooks/useServerSettings";
import { useI18n } from "../i18n";
import { getAgentCommandConfigs } from "../lib/agentCommands";
import { readClipboardUserInput } from "../lib/clipboard";
import {
  getModelReasoningEfforts,
  resolveModelReasoningEffort,
} from "../lib/codexReasoning";
import { hasCoarsePointer } from "../lib/deviceDetection";
import {
  getProviderPermissionModes,
  normalizeProviderPermissionMode,
} from "../lib/providerPermissionModes";
import {
  HistoricalEditQueueError,
  requireStartedHistoricalEdit,
  shouldRestoreHistoricalEditAfterFailure,
} from "../lib/sessionBranching";
import type { PermissionMode, SessionNavigationState } from "../types";
import { CodexUsageCard } from "./CodexUsageCard";
import { FilterDropdown, type FilterOption } from "./FilterDropdown";
import { clearFabPrefill, getFabPrefill } from "./FloatingActionButton";
import { SlashCommandButton } from "./SlashCommandButton";
import { VoiceInputButton, type VoiceInputButtonRef } from "./VoiceInputButton";

interface PendingFile {
  id: string;
  file: File;
  previewUrl?: string;
}

const CODEX_MCP_MODE_ORDER: CodexMcpMode[] = ["clear", "standard", "full"];
const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";

const NEW_SESSION_PROVIDER_ACCENTS = {
  claude: "var(--provider-claude)",
  "claude-ollama": "var(--provider-claude)",
  codex: "var(--provider-codex)",
  "codex-oss": "var(--provider-codex)",
  gemini: "var(--provider-gemini)",
  "gemini-acp": "var(--provider-gemini)",
  pi: "var(--provider-pi)",
  kimi: "var(--provider-kimi)",
  zcode: "var(--provider-zcode)",
} satisfies Record<LiveProviderName, string>;

export function getNewSessionProviderAccent(
  provider: LiveProviderName | null | undefined,
): string {
  return provider
    ? NEW_SESSION_PROVIDER_ACCENTS[provider]
    : "var(--app-yep-green)";
}

const EFFORT_LABEL_KEYS: Record<
  EffortLevel,
  | "newSessionEffortLow"
  | "newSessionEffortMedium"
  | "newSessionEffortHigh"
  | "newSessionEffortXHigh"
  | "newSessionEffortMax"
> = {
  low: "newSessionEffortLow",
  medium: "newSessionEffortMedium",
  high: "newSessionEffortHigh",
  xhigh: "newSessionEffortXHigh",
  max: "newSessionEffortMax",
};

function getThinkingOption(
  mode: ThinkingMode,
  effort: EffortLevel,
): ThinkingOption {
  if (mode === "off") return "off";
  if (mode === "auto") return "auto";
  return `on:${effort}`;
}

type ThinkingPreset = "off" | "auto" | `on:${string}`;

const THINKING_PRESET_ORDER: readonly ThinkingPreset[] = [
  "off",
  "auto",
  "on:low",
  "on:medium",
  "on:high",
  "on:xhigh",
  "on:max",
];
const DEFAULT_GATEWAY_CAPABILITIES: LlmGatewayModelCapabilities = {
  attachment: false,
  reasoning: false,
  temperature: true,
  toolCall: true,
};

function getDefaultGatewayCapabilities(
  hasReasoningVariants = false,
): LlmGatewayModelCapabilities {
  return {
    ...DEFAULT_GATEWAY_CAPABILITIES,
    reasoning: hasReasoningVariants,
  };
}

function isEffortLevel(value: string): value is EffortLevel {
  return EFFORT_LEVEL_OPTIONS.some((option) => option.value === value);
}

function getThinkingPreset(
  mode: ThinkingMode,
  effort: EffortLevel,
): ThinkingPreset {
  if (mode === "on") return `on:${effort}`;
  return mode;
}

function normalizeThinkingOption(
  option: ThinkingOption | undefined,
): ThinkingPreset | null {
  if (!option) return null;
  if (option === "off" || option === "auto") return option;
  const effort = option.startsWith("on:") ? option.slice(3) : option;
  return isEffortLevel(effort) ? `on:${effort}` : null;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  return `${Math.round(tokens / 1_000)}K`;
}

function getPreferredModelId(
  models: ModelInfo[],
  preferredModelId?: string | null,
  fallbackModelId?: string,
) {
  const configuredModelId = preferredModelId ?? resolveModel(getModelSetting());

  if (!configuredModelId) {
    return (
      models.find((m) => m.id === "default")?.id ??
      models[0]?.id ??
      models.find((m) => m.id === fallbackModelId)?.id ??
      null
    );
  }

  if (configuredModelId) {
    const matchingPreferredModel = models.find(
      (m) => m.id === configuredModelId,
    );
    if (matchingPreferredModel) return matchingPreferredModel.id;

    const matchingResolvedModel = models.find(
      (model) =>
        model.id !== "default" && model.resolvedModel === configuredModelId,
    );
    if (matchingResolvedModel) return matchingResolvedModel.id;

    const legacyClaudeModel = {
      fable: "claude-fable-5[1m]",
      "sonnet[1m]": "sonnet",
      "opus[1m]": "opus",
      best: "opus",
    }[configuredModelId];
    if (legacyClaudeModel) {
      const matchingLegacyModel = models.find(
        (model) => model.id === legacyClaudeModel,
      );
      if (matchingLegacyModel) return matchingLegacyModel.id;
    }
  }

  return (
    models.find((m) => m.id === fallbackModelId)?.id ?? models[0]?.id ?? null
  );
}

function getPreferredGatewayModelId(
  models: ModelInfo[],
  preferredModelId?: string | null,
): string | null {
  const configuredModelId = preferredModelId ?? resolveModel(getModelSetting());

  if (configuredModelId) {
    const matchingPreferredModel = models.find(
      (model) => model.id === configuredModelId,
    );
    if (matchingPreferredModel) return matchingPreferredModel.id;
  }

  return models[0]?.id ?? null;
}

/**
 * Resolve a managed gateway model's context/output window.
 *
 * Prefers the real limits the model advertises (populated from
 * the gateway `/v1/models` catalog, carried on ModelInfo. Only backfills
 * per-field from the curated catalog when the live
 * catalog omits a value. Returns limits only when both context and output are
 * known, since the session config requires both.
 */
function resolveGatewayModelLimits(
  model: ModelInfo | undefined,
): LlmGatewayModelLimits | undefined {
  if (!model) return undefined;
  const curated = getLlmGatewayModelDefaultLimits(model.id);
  const context = model.contextWindow ?? curated?.context;
  const output = model.maxOutputTokens ?? curated?.output;
  if (!context || !output) return undefined;
  return { context, output };
}

function sameLlmGatewayConfig(
  a: LlmGatewaySessionConfig | undefined,
  b: LlmGatewaySessionConfig | undefined,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface NewSessionFormProps {
  projectId: string;
  /** Whether to focus the textarea on mount (default: true) */
  autoFocus?: boolean;
  /** Number of rows for the textarea (default: 6) */
  rows?: number;
  /** Placeholder text for the textarea */
  placeholder?: string;
  /** Compact mode: no header, no mode selector (default: false) */
  compact?: boolean;
}

export function NewSessionForm({
  projectId,
  autoFocus = true,
  rows = 6,
  placeholder,
  compact = false,
}: NewSessionFormProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const basePath = useRemoteBasePath();
  const [message, setMessage, draftControls] = useDraftPersistence(
    `draft-new-session-${projectId}`,
  );
  const [mode, setMode] = useState<PermissionMode>(DEFAULT_PERMISSION_MODE);
  const [selectedProvider, setSelectedProvider] =
    useState<LiveProviderName | null>(null);
  const selectedProviderAccent = getNewSessionProviderAccent(selectedProvider);
  const newSessionThemeStyle = {
    "--new-session-accent": selectedProviderAccent,
  } as CSSProperties;
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [codexReasoningEffort, setCodexReasoningEffort] = useState<
    string | null
  >(null);
  const [kimiReasoningEffort, setKimiReasoningEffort] = useState<string | null>(
    null,
  );
  const [selectedGatewayProtocol, setSelectedGatewayProtocol] =
    useState<LlmGatewayRequestProtocol>("openai-compatible");
  const [selectedCodexMcpMode, setSelectedCodexMcpMode] =
    useState<CodexMcpMode>("standard");
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const pendingFilesRef = useRef<PendingFile[]>(pendingFiles);
  pendingFilesRef.current = pendingFiles;
  const [isStarting, setIsStarting] = useState(false);
  const [startRetryBlockedMessage, setStartRetryBlockedMessage] = useState<
    string | null
  >(null);
  const [uploadProgress, setUploadProgress] = useState<
    Record<string, { uploaded: number; total: number }>
  >({});
  const [interimTranscript, setInterimTranscript] = useState("");
  const [isSavingDefaults, setIsSavingDefaults] = useState(false);

  // ZCode MCP server status snapshot. Loaded once per provider selection
  // (no polling) purely as informational context for new sessions.
  const [zcodeMcpServers, setZcodeMcpServers] = useState<Record<
    string,
    ProviderMcpServerStatus
  > | null>(null);
  const [zcodeMcpLoading, setZcodeMcpLoading] = useState(false);
  const [zcodeMcpError, setZcodeMcpError] = useState<string | null>(null);

  useEffect(() => {
    if (selectedProvider !== "zcode") return;
    let cancelled = false;
    setZcodeMcpServers(null);
    setZcodeMcpError(null);
    setZcodeMcpLoading(true);
    api
      .listZCodeMcpServers(projectId)
      .then((response) => {
        if (cancelled) return;
        setZcodeMcpServers(response.servers);
        setZcodeMcpLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setZcodeMcpError(
          error instanceof Error ? error.message : String(error),
        );
        setZcodeMcpLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedProvider, projectId]);

  // Object URLs keep their backing Blob alive for the lifetime of the page.
  // Removal and successful submission revoke them below; this cleanup covers
  // route changes, cancelled drafts, and failed starts that unmount the form.
  useEffect(
    () => () => {
      for (const pendingFile of pendingFilesRef.current) {
        if (pendingFile.previewUrl) {
          URL.revokeObjectURL(pendingFile.previewUrl);
        }
      }
    },
    [],
  );
  // Unavailable providers (not installed / not authed) are collapsed by default
  // so the selector grid stays tidy instead of showing tall, uneven cards.
  const [showUnavailableProviders, setShowUnavailableProviders] =
    useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const voiceButtonRef = useRef<VoiceInputButtonRef>(null);
  const hasInitializedDefaultsRef = useRef(false);
  // Thinking toggle state
  const {
    thinkingMode,
    setThinkingMode,
    cycleThinkingMode,
    thinkingLevel,
    setEffortLevel,
  } = useModelSettings();

  // Connection for uploads (uses WebSocket when enabled)
  const connection = useConnection();

  // Toast for error messages
  const { showToast } = useToastContext();

  // Fetch available providers
  const { providers, loading: providersLoading } = useProviders();
  const {
    settings,
    isLoading: settingsLoading,
    updateSetting: updateServerSetting,
  } = useServerSettings();
  const availableProviders = getAvailableProviders(providers);
  const resolvedPlaceholder = placeholder ?? t("newSessionPlaceholder");
  const selectedProviderInfo = providers.find(
    (provider) => provider.name === selectedProvider,
  );
  const {
    labels: modeLabels,
    descriptions: modeDescriptions,
    title: permissionModeTitle,
    description: permissionModeDescription,
  } = useProviderPermissionModeConfig(selectedProvider);
  const codexMcpModeLabels: Record<CodexMcpMode, string> = {
    clear: t("newSessionCodexMcpClearLabel"),
    standard: t("newSessionCodexMcpStandardLabel"),
    full: t("newSessionCodexMcpFullLabel"),
  };
  const codexMcpModeDescriptions: Record<CodexMcpMode, string> = {
    clear: t("newSessionCodexMcpClearDescription"),
    standard: t("newSessionCodexMcpStandardDescription"),
    full: t("newSessionCodexMcpFullDescription"),
  };
  // ZCode mcp/list lifecycle statuses (real CLI 0.16.1 enum).
  const zcodeMcpStatusLabels: Record<string, string> = {
    connecting: t("newSessionZcodeMcpStatusConnecting"),
    connected: t("newSessionZcodeMcpStatusConnected"),
    disabled: t("newSessionZcodeMcpStatusDisabled"),
    disconnected: t("newSessionZcodeMcpStatusDisconnected"),
    failed: t("newSessionZcodeMcpStatusFailed"),
    untrusted: t("newSessionZcodeMcpStatusUntrusted"),
  };
  // Get models and capabilities for the currently selected provider.
  const availableModels: ModelInfo[] = selectedProviderInfo?.models ?? [];
  const selectedModelInfo = availableModels.find(
    (model) => model.id === selectedModel,
  );
  const selectedGatewayProtocols =
    selectedProvider === "pi"
      ? (selectedModelInfo?.supportedRequestProtocols ?? [])
      : [];
  const isManagedGatewayModel = selectedGatewayProtocols.length > 0;
  const codexReasoningEfforts = useMemo(
    () => getModelReasoningEfforts(selectedModelInfo),
    [selectedModelInfo],
  );
  const claudeReasoningEfforts = useMemo(
    () =>
      selectedProvider === "claude"
        ? getModelReasoningEfforts(selectedModelInfo)
        : [],
    [selectedModelInfo, selectedProvider],
  );
  const kimiReasoningEfforts = useMemo(
    () =>
      selectedProvider === "kimi"
        ? getModelReasoningEfforts(selectedModelInfo)
        : [],
    [selectedModelInfo, selectedProvider],
  );
  const piReasoningEfforts = useMemo(
    () =>
      selectedProvider === "pi"
        ? getModelReasoningEfforts(selectedModelInfo)
        : [],
    [selectedModelInfo, selectedProvider],
  );
  const effectiveCodexReasoningEffort =
    selectedProvider === "codex"
      ? resolveModelReasoningEffort(
          selectedModelInfo,
          codexReasoningEffort ??
            (codexReasoningEfforts.length === 0
              ? thinkingLevel === "max"
                ? "xhigh"
                : thinkingLevel
              : undefined),
        )
      : undefined;
  const effectiveKimiReasoningEffort =
    selectedProvider === "kimi" && kimiReasoningEfforts.length > 0
      ? resolveModelReasoningEffort(selectedModelInfo, kimiReasoningEffort)
      : undefined;
  const resolvedPiThinkingEffort =
    selectedProvider === "pi"
      ? resolveModelReasoningEffort(
          selectedModelInfo,
          thinkingMode === "on" ? thinkingLevel : null,
        )
      : undefined;
  const selectedReasoningEffort =
    selectedProvider === "codex" && thinkingMode === "on"
      ? effectiveCodexReasoningEffort
      : selectedProvider === "kimi"
        ? effectiveKimiReasoningEffort
        : selectedProvider === "pi" && thinkingMode !== "off"
          ? resolvedPiThinkingEffort
          : undefined;
  const getEffortLabel = useCallback(
    (effort: string): string => {
      return isEffortLevel(effort) ? t(EFFORT_LABEL_KEYS[effort]) : effort;
    },
    [t],
  );
  const resolvedClaudeThinkingEffort =
    selectedProvider === "claude"
      ? resolveModelReasoningEffort(selectedModelInfo, thinkingLevel)
      : undefined;
  const effectiveThinkingEffort =
    resolvedClaudeThinkingEffort && isEffortLevel(resolvedClaudeThinkingEffort)
      ? resolvedClaudeThinkingEffort
      : resolvedPiThinkingEffort && isEffortLevel(resolvedPiThinkingEffort)
        ? resolvedPiThinkingEffort
        : thinkingLevel;
  const selectedThinkingPreset: ThinkingPreset =
    selectedProvider === "codex" &&
    thinkingMode === "on" &&
    effectiveCodexReasoningEffort
      ? `on:${effectiveCodexReasoningEffort}`
      : getThinkingPreset(thinkingMode, effectiveThinkingEffort);
  const thinkingOptions = useMemo((): FilterOption<ThinkingPreset>[] => {
    const presets: Array<{
      value: ThinkingPreset;
      description?: string;
    }> = [
      { value: "off" },
      { value: "auto" },
      ...((selectedProvider === "codex" && codexReasoningEfforts.length > 0) ||
      (selectedProvider === "claude" && claudeReasoningEfforts.length > 0) ||
      (selectedProvider === "pi" && piReasoningEfforts.length > 0)
        ? (selectedProvider === "claude"
            ? claudeReasoningEfforts
            : selectedProvider === "pi"
              ? piReasoningEfforts
              : codexReasoningEfforts
          ).map((option) => ({
            value: `on:${option.reasoningEffort}` as ThinkingPreset,
            description: option.description,
          }))
        : THINKING_PRESET_ORDER.slice(2).map((value) => ({ value }))),
    ];

    return presets.map(({ value: preset, description }) => {
      if (preset === "off") {
        return {
          value: preset,
          label: t("newSessionThinkingOff"),
        };
      }
      if (preset === "auto") {
        return {
          value: preset,
          label: t("newSessionThinkingAuto"),
        };
      }
      const effort = preset.slice(3);
      return {
        value: preset,
        label: t("newSessionThinkingOn", {
          level: getEffortLabel(effort),
        }),
        description,
      };
    });
  }, [
    claudeReasoningEfforts,
    codexReasoningEfforts,
    getEffortLabel,
    piReasoningEfforts,
    selectedProvider,
    t,
  ]);
  const applyThinkingPreset = useCallback(
    (preset: ThinkingPreset) => {
      if (preset === "off" || preset === "auto") {
        setThinkingMode(preset);
        return;
      }
      const effort = preset.slice(3);
      if (
        selectedProvider === "codex" &&
        codexReasoningEfforts.some(
          (option) => option.reasoningEffort === effort,
        )
      ) {
        setCodexReasoningEffort(effort);
        setThinkingMode("on");
        return;
      }
      if (!isEffortLevel(effort)) return;
      setEffortLevel(effort);
      setThinkingMode("on");
    },
    [codexReasoningEfforts, selectedProvider, setEffortLevel, setThinkingMode],
  );
  const handleThinkingSelect = useCallback(
    (selected: ThinkingPreset[]) => {
      applyThinkingPreset(selected[0] ?? "off");
    },
    [applyThinkingPreset],
  );
  const kimiReasoningOptions = useMemo((): FilterOption<string>[] => {
    return kimiReasoningEfforts.map((option) => {
      const effort = option.reasoningEffort;
      const label =
        effort === "off"
          ? t("newSessionThinkingOff")
          : t("newSessionThinkingOn", {
              level:
                effort === "on"
                  ? t("processInfoDefaultModel")
                  : getEffortLabel(effort),
            });
      return {
        value: effort,
        label,
        description: option.description,
      };
    });
  }, [getEffortLabel, kimiReasoningEfforts, t]);
  const handleKimiReasoningSelect = useCallback((selected: string[]) => {
    setKimiReasoningEffort(selected[0] ?? null);
  }, []);
  const showKimiReasoningSelector =
    selectedProvider === "kimi" && kimiReasoningOptions.length > 0;

  // Default to true for backwards compatibility with providers that don't set these flags
  const permissionModes = getProviderPermissionModes(
    selectedProvider,
    selectedProviderInfo?.permissionModes,
  );
  const supportsPermissionMode =
    (selectedProviderInfo?.supportsPermissionMode ?? true) &&
    permissionModes.length > 0;
  const providerSupportsThinkingToggle =
    selectedProviderInfo?.supportsThinkingToggle ?? true;
  const supportsThinkingToggle =
    providerSupportsThinkingToggle &&
    (selectedProvider !== "claude" ||
      !selectedModelInfo ||
      selectedModelInfo.supportsAdaptiveThinking === true ||
      selectedModelInfo.supportsEffort === true);
  const commandButtons = useMemo(
    () =>
      getAgentCommandConfigs(
        selectedProvider,
        selectedProviderInfo?.supportsSlashCommands,
        [],
        [],
        {
          codexCommands: t("codexCommandsLabel"),
          skills: t("codexSkillsLabel"),
          slashCommands: t("slashCommandsLabel"),
        },
      ),
    [selectedProvider, selectedProviderInfo?.supportsSlashCommands, t],
  );

  const applyProviderSelection = useCallback(
    (provider: ProviderInfo, savedDefaults?: NewSessionProviderDefaults) => {
      const providerName = provider.name;
      const models = provider.models ?? [];
      const savedGatewayConfig = savedDefaults?.llmGatewayConfig;
      // Codex saved defaults store the bare model slug plus a separate model
      // source; map them back to the composite picker id (e.g.
      // "deepseek/deepseek-v4-flash") so the right grouped option preselects.
      const codexPreferredModel =
        providerName === "codex" &&
        savedDefaults?.model &&
        savedDefaults?.codexModelProvider
          ? models.find(
              (m) =>
                m.modelProvider === savedDefaults.codexModelProvider &&
                (m.providerModelId ?? m.id) === savedDefaults.model,
            )?.id
          : undefined;

      const preferredModel =
        providerName === "pi"
          ? getPreferredGatewayModelId(
              models,
              savedGatewayConfig?.model ??
                savedDefaults?.model ??
                provider.currentModel,
            )
          : getPreferredModelId(
              models,
              codexPreferredModel ??
                savedDefaults?.model ??
                provider.currentModel,
              providerName === "codex" ? DEFAULT_CODEX_MODEL : undefined,
            );

      setSelectedProvider(providerName);
      setMode(
        normalizeProviderPermissionMode(
          providerName,
          savedDefaults?.permissionMode,
          provider.permissionModes,
        ),
      );
      setSelectedCodexMcpMode(
        providerName === "codex"
          ? (savedDefaults?.codexMcpMode ?? "standard")
          : "standard",
      );
      setKimiReasoningEffort(
        providerName === "kimi"
          ? (savedDefaults?.reasoningEffort ?? null)
          : null,
      );

      if (providerName === "pi") {
        const modelInfo = models.find((model) => model.id === preferredModel);
        const supportedProtocols = modelInfo?.supportedRequestProtocols ?? [];
        const savedProtocol = savedGatewayConfig?.requestProtocol;
        const protocol =
          savedProtocol && supportedProtocols.includes(savedProtocol)
            ? savedProtocol
            : (supportedProtocols[0] ?? "openai-compatible");
        setSelectedGatewayProtocol(protocol);
      }

      setSelectedModel(preferredModel);

      const savedThinkingPreset = normalizeThinkingOption(
        savedDefaults?.thinking,
      );
      const savedCodexReasoningEffort =
        providerName === "codex"
          ? (savedDefaults?.reasoningEffort ??
            (savedThinkingPreset?.startsWith("on:")
              ? savedThinkingPreset.slice(3) === "max"
                ? "xhigh"
                : savedThinkingPreset.slice(3)
              : null))
          : null;
      setCodexReasoningEffort(savedCodexReasoningEffort);

      if (savedThinkingPreset === "off" || savedThinkingPreset === "auto") {
        setThinkingMode(savedThinkingPreset);
      } else if (savedThinkingPreset?.startsWith("on:")) {
        const effort = savedThinkingPreset.slice(3);
        if (isEffortLevel(effort)) setEffortLevel(effort);
        setThinkingMode("on");
      } else if (savedCodexReasoningEffort) {
        setThinkingMode("on");
      } else if (provider.currentEffortLevel) {
        setEffortLevel(provider.currentEffortLevel);
      }
    },
    [setEffortLevel, setThinkingMode],
  );

  // Initialize provider/model/mode from saved defaults once settings and providers load.
  useEffect(() => {
    if (
      hasInitializedDefaultsRef.current ||
      providersLoading ||
      settingsLoading
    ) {
      return;
    }

    hasInitializedDefaultsRef.current = true;

    if (providers.length === 0) return;

    const availableProviderNames = new Set(
      availableProviders.map((p) => p.name),
    );
    const savedDefaults = settings?.newSessionDefaults;
    const savedProviderName =
      savedDefaults?.provider &&
      availableProviderNames.has(savedDefaults.provider)
        ? savedDefaults.provider
        : null;
    const initialProvider =
      providers.find((p) => p.name === savedProviderName) ??
      getDefaultProvider(providers);

    if (!initialProvider) return;

    applyProviderSelection(
      initialProvider,
      getNewSessionProviderDefaults(savedDefaults, initialProvider.name),
    );
  }, [
    applyProviderSelection,
    availableProviders,
    providers,
    providersLoading,
    settings,
    settingsLoading,
  ]);

  // Restore each provider's own saved options when switching providers.
  const handleProviderSelect = (providerName: LiveProviderName) => {
    const provider = providers.find((p) => p.name === providerName);
    if (!provider) return;
    applyProviderSelection(
      provider,
      getNewSessionProviderDefaults(settings?.newSessionDefaults, providerName),
    );
  };

  // Build model options for FilterDropdown
  const modelOptions = useMemo((): FilterOption<string>[] => {
    const options: FilterOption<string>[] = [];

    // Derive a stable color per provider prefix so grouped models get a
    // consistent colored dot in the dropdown.
    const providerColor = (provider: string): string => {
      let hash = 0;
      for (let i = 0; i < provider.length; i += 1) {
        hash = (hash * 31 + provider.charCodeAt(i)) >>> 0;
      }
      return `hsl(${hash % 360} 60% 55%)`;
    };

    for (const model of availableModels) {
      const label = model.size
        ? `${model.name} (${(model.size / (1024 * 1024 * 1024)).toFixed(1)} GB)`
        : model.name;

      let description = model.description;
      const parts: string[] = description ? [description] : [];
      if (model.parameterSize) parts.push(model.parameterSize);
      // Prefer the model's advertised window; fall back to the curated
      // catalog only when the live catalog omits one.
      const effectiveContextWindow =
        model.contextWindow ??
        (selectedProvider === "pi"
          ? getLlmGatewayModelDefaultLimits(model.id)?.context
          : undefined);
      if (effectiveContextWindow) {
        parts.push(
          t("newSessionModelContextWindow", {
            size: formatContextWindow(effectiveContextWindow),
          }),
        );
      }
      const reasoningEfforts = getModelReasoningEfforts(model);
      if (reasoningEfforts.length > 0) {
        parts.push(
          t("newSessionModelThinkingEfforts", {
            levels: reasoningEfforts
              .map((effort) => getEffortLabel(effort.reasoningEffort))
              .join(" / "),
          }),
        );
      }
      if (model.parentModel) parts.push(model.parentModel);
      if (model.quantizationLevel) parts.push(model.quantizationLevel);
      if (model.supportedRequestProtocols?.length) {
        parts.push(
          model.supportedRequestProtocols
            .map((protocol) =>
              protocol === "anthropic" ? "Anthropic" : "OpenAI-compatible",
            )
            .join(" / "),
        );
      }
      if (parts.length > 0) description = parts.join(" · ");

      // Codex models carry an explicit model source (Codex `model_provider`);
      // group by its friendly display name so users can tell which channel a
      // model routes through. Gateway catalog ids can be `channel/model` and
      // group by the slash prefix. The synthetic "default" entry (no slash,
      // no source) stays ungrouped at the top.
      let group: string | undefined;
      if (model.modelProvider) {
        const source = selectedProviderInfo?.codexModelSources?.find(
          (candidate) => candidate.id === model.modelProvider,
        );
        group = source?.displayName ?? model.modelProvider;
      } else {
        const slashIndex = model.id.indexOf("/");
        group = slashIndex > 0 ? model.id.slice(0, slashIndex) : undefined;
      }

      options.push({
        value: model.id,
        label,
        description,
        ...(group ? { group, color: providerColor(group) } : {}),
      });
    }

    return options;
  }, [
    availableModels,
    getEffortLabel,
    selectedProvider,
    selectedProviderInfo?.codexModelSources,
    t,
  ]);

  // Codex model sources that exist but cannot be selected yet (e.g. the server
  // is missing the source's API key). Shown as a setup hint under the picker.
  const unavailableCodexSourceHints = useMemo(() => {
    if (selectedProvider !== "codex") return [];
    return (selectedProviderInfo?.codexModelSources ?? [])
      .filter((source) => !source.available)
      .map((source) =>
        source.unavailableReason === "missing_api_key"
          ? t("newSessionCodexSourceMissingKey", { source: source.displayName })
          : t("newSessionCodexSourceUnavailable", {
              source: source.displayName,
            }),
      );
  }, [selectedProvider, selectedProviderInfo?.codexModelSources, t]);

  const selectedModelCapabilitySummary = useMemo(() => {
    if (selectedProvider === "pi") {
      const limits = resolveGatewayModelLimits(selectedModelInfo);
      if (!limits) return null;
      return t("newSessionModelContextWindow", {
        size: formatContextWindow(limits.context),
      });
    }
    if (selectedProvider !== "claude" || !selectedModelInfo) return null;
    const parts: string[] = [];
    if (selectedModelInfo.contextWindow) {
      parts.push(
        t("newSessionModelContextWindow", {
          size: formatContextWindow(selectedModelInfo.contextWindow),
        }),
      );
    }
    const efforts = getModelReasoningEfforts(selectedModelInfo);
    if (efforts.length > 0) {
      parts.push(
        t("newSessionModelThinkingEfforts", {
          levels: efforts
            .map((effort) => getEffortLabel(effort.reasoningEffort))
            .join(" / "),
        }),
      );
    }
    return parts.join(" · ") || null;
  }, [getEffortLabel, selectedModelInfo, selectedProvider, t]);

  const showGatewayEndpointSelector =
    selectedProvider === "pi" &&
    selectedModel !== null &&
    isManagedGatewayModel;

  // Handle model selection from FilterDropdown
  const handleModelSelect = useCallback(
    (selected: string[]) => {
      const nextModel = selected[0] ?? null;
      if (selectedProvider === "pi") {
        const nextInfo = availableModels.find(
          (model) => model.id === nextModel,
        );
        const supportedProtocols = nextInfo?.supportedRequestProtocols ?? [];
        const nextProtocol = supportedProtocols.includes(
          selectedGatewayProtocol,
        )
          ? selectedGatewayProtocol
          : (supportedProtocols[0] ?? "openai-compatible");
        setSelectedGatewayProtocol(nextProtocol);
        setSelectedModel(nextModel);
        return;
      }
      setSelectedModel(nextModel);
    },
    [availableModels, selectedGatewayProtocol, selectedProvider],
  );

  const handleGatewayProtocolSelect = useCallback(
    (protocol: LlmGatewayRequestProtocol) => {
      if (!selectedGatewayProtocols.includes(protocol)) return;
      setSelectedGatewayProtocol(protocol);
    },
    [selectedGatewayProtocols],
  );

  // Combined display text: committed text + interim transcript
  const displayText = interimTranscript
    ? message + (message.trimEnd() ? " " : "") + interimTranscript
    : message;

  // Auto-scroll textarea when voice input updates (interim transcript changes)
  // Browser handles scrolling for normal typing, but programmatic updates need explicit scroll
  useEffect(() => {
    if (interimTranscript) {
      const textarea = textareaRef.current;
      if (textarea) {
        textarea.scrollTop = textarea.scrollHeight;
      }
    }
  }, [interimTranscript]);

  // Focus textarea on mount if autoFocus is enabled
  useEffect(() => {
    if (autoFocus) {
      textareaRef.current?.focus();
    }
  }, [autoFocus]);

  // Check for FAB pre-fill on mount (when coming from FloatingActionButton)
  useEffect(() => {
    const prefill = getFabPrefill();
    if (prefill) {
      setMessage(prefill);
      clearFabPrefill();
      // Focus and move cursor to end
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(prefill.length, prefill.length);
      }
    }
  }, [setMessage]);

  const handleFileSelect = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files?.length) return;

    const newPendingFiles: PendingFile[] = Array.from(files).map((file) => ({
      id: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file,
      previewUrl: file.type.startsWith("image/")
        ? URL.createObjectURL(file)
        : undefined,
    }));

    setPendingFiles((prev) => [...prev, ...newPendingFiles]);
    e.target.value = ""; // Reset for re-selection
  };

  const handleRemoveFile = (id: string) => {
    setPendingFiles((prev) => {
      const file = prev.find((f) => f.id === id);
      if (file?.previewUrl) {
        URL.revokeObjectURL(file.previewUrl);
      }
      return prev.filter((f) => f.id !== id);
    });
  };

  const handleModeSelect = (selectedMode: PermissionMode) => {
    setMode(selectedMode);
  };

  const handleCodexMcpModeSelect = (selectedMode: CodexMcpMode) => {
    setSelectedCodexMcpMode(selectedMode);
  };

  const handleSelectEffort = useCallback(
    (effort: EffortLevel) => {
      setEffortLevel(effort);
      setThinkingMode("on");
    },
    [setEffortLevel, setThinkingMode],
  );

  const gatewayModelLimits = useMemo((): LlmGatewayModelLimits | undefined => {
    if (selectedProvider !== "pi") return undefined;
    return resolveGatewayModelLimits(selectedModelInfo);
  }, [selectedProvider, selectedModelInfo]);
  const hasGatewayConfigError =
    selectedProvider === "pi" &&
    isManagedGatewayModel &&
    !selectedGatewayProtocols.includes(selectedGatewayProtocol);
  const llmGatewayConfigForRequest = useMemo(():
    | LlmGatewaySessionConfig
    | undefined => {
    if (
      selectedProvider !== "pi" ||
      !isManagedGatewayModel ||
      !selectedModel ||
      hasGatewayConfigError
    ) {
      return undefined;
    }
    const reasoningEfforts = getModelReasoningEfforts(
      selectedModelInfo,
      selectedGatewayProtocol,
    );
    return {
      model: selectedModel,
      requestProtocol: selectedGatewayProtocol,
      ...(selectedModelInfo?.name && selectedModelInfo.name !== selectedModel
        ? { name: selectedModelInfo.name }
        : {}),
      ...(gatewayModelLimits ? { limits: gatewayModelLimits } : {}),
      capabilities: getDefaultGatewayCapabilities(reasoningEfforts.length > 0),
    };
  }, [
    gatewayModelLimits,
    hasGatewayConfigError,
    isManagedGatewayModel,
    selectedModel,
    selectedModelInfo,
    selectedGatewayProtocol,
    selectedProvider,
  ]);
  const selectedModelForRequest =
    selectedProvider === "pi" && isManagedGatewayModel
      ? undefined
      : (selectedModel ?? undefined);
  // Codex picker ids may be composite `source/model`; the API takes the bare
  // model slug plus a separate `codexModelProvider` (model source) field.
  const codexModelProviderForRequest =
    selectedProvider === "codex"
      ? (selectedModelInfo?.modelProvider ?? undefined)
      : undefined;
  const modelForRequest =
    selectedProvider === "codex"
      ? (selectedModelInfo?.providerModelId ??
        selectedModelForRequest ??
        undefined)
      : selectedModelForRequest;
  const thinkingForRequest = supportsThinkingToggle
    ? getThinkingOption(thinkingMode, effectiveThinkingEffort)
    : undefined;
  const currentProviderDefaults = useMemo(
    (): NewSessionProviderDefaults => ({
      model: modelForRequest,
      thinking: thinkingForRequest,
      reasoningEffort: selectedReasoningEffort,
      permissionMode: mode,
      codexMcpMode:
        selectedProvider === "codex" ? selectedCodexMcpMode : undefined,
      codexModelProvider: codexModelProviderForRequest,
      llmGatewayConfig: llmGatewayConfigForRequest,
    }),
    [
      mode,
      llmGatewayConfigForRequest,
      selectedCodexMcpMode,
      codexModelProviderForRequest,
      modelForRequest,
      selectedProvider,
      selectedReasoningEffort,
      thinkingForRequest,
    ],
  );

  const handleSaveDefaults = useCallback(async () => {
    if (!selectedProvider) return;

    setIsSavingDefaults(true);
    try {
      const byProvider: Partial<
        Record<LiveProviderName, NewSessionProviderDefaults>
      > = {
        [selectedProvider]: currentProviderDefaults,
      };
      await updateServerSetting("newSessionDefaults", {
        provider: selectedProvider,
        ...currentProviderDefaults,
        byProvider,
      });
      showToast(t("newSessionDefaultsSaved"), "success");
    } catch (err) {
      console.error("Failed to save new session defaults:", err);
      showToast(
        err instanceof Error ? err.message : t("newSessionDefaultsSaveError"),
        "error",
      );
    } finally {
      setIsSavingDefaults(false);
    }
  }, [
    currentProviderDefaults,
    selectedProvider,
    showToast,
    t,
    updateServerSetting,
  ]);

  const handleStartSession = async () => {
    // Stop voice recording and get any pending interim text
    const pendingVoice = voiceButtonRef.current?.stopAndFinalize() ?? "";

    // Combine committed text with any pending voice text
    let finalMessage = message.trimEnd();
    if (pendingVoice) {
      finalMessage = finalMessage
        ? `${finalMessage} ${pendingVoice}`
        : pendingVoice;
    }

    const hasContent = finalMessage.trim() || pendingFiles.length > 0;
    if (
      !projectId ||
      !hasContent ||
      isStarting ||
      startRetryBlockedMessage ||
      hasGatewayConfigError
    ) {
      return;
    }

    const trimmedMessage = finalMessage.trim();

    setInterimTranscript("");
    setIsStarting(true);
    let sessionStartOutcomePending = false;

    try {
      let sessionId: string;
      let processId: string;
      let initialPermissionMode = mode;
      let initialModeVersion = 0;
      const uploadedFiles: UploadedFile[] = [];

      // Get model and thinking settings
      const thinking = thinkingForRequest;
      const sessionOptions = {
        mode,
        model: modelForRequest,
        thinking,
        reasoningEffort: selectedReasoningEffort,
        provider: selectedProvider ?? undefined,
        codexMcpMode:
          selectedProvider === "codex" ? selectedCodexMcpMode : undefined,
        codexModelProvider: codexModelProviderForRequest,
        llmGatewayConfig: llmGatewayConfigForRequest,
      };

      if (pendingFiles.length > 0) {
        // Two-phase flow: create session first, then upload to real session folder
        // Step 1: Create the session without sending a message
        sessionStartOutcomePending = true;
        const createResult = await requireStartedHistoricalEdit(
          await api.createSession(projectId, sessionOptions),
          api.cancelQueuedRequest,
          "session start",
        );
        sessionStartOutcomePending = false;
        sessionId = createResult.sessionId;
        processId = createResult.processId;
        initialPermissionMode = createResult.permissionMode;
        initialModeVersion = createResult.modeVersion;

        // Step 2: Upload files to the real session folder
        for (const pendingFile of pendingFiles) {
          try {
            const uploadedFile = await connection.upload(
              projectId,
              sessionId,
              pendingFile.file,
              {
                onProgress: (bytesUploaded) => {
                  setUploadProgress((prev) => ({
                    ...prev,
                    [pendingFile.id]: {
                      uploaded: bytesUploaded,
                      total: pendingFile.file.size,
                    },
                  }));
                },
              },
            );
            uploadedFiles.push(uploadedFile);
          } catch (uploadErr) {
            console.error("Failed to upload file:", uploadErr);
            const uploadMessage =
              uploadErr instanceof Error ? uploadErr.message : "";
            showToast(
              t("newSessionUploadError", { message: uploadMessage }),
              "error",
            );
            // Continue with other files
          }
        }

        // Step 3: Send the first message with attachments
        await api.queueMessage(
          sessionId,
          trimmedMessage,
          mode,
          uploadedFiles.length > 0 ? uploadedFiles : undefined,
          undefined, // tempId
          thinking, // Pass the captured thinking setting to avoid process restart
          sessionOptions.reasoningEffort,
        );
      } else {
        // No files - use single-step flow for efficiency
        sessionStartOutcomePending = true;
        const result = await requireStartedHistoricalEdit(
          await api.startSession(projectId, trimmedMessage, sessionOptions),
          api.cancelQueuedRequest,
          "session start",
        );
        sessionStartOutcomePending = false;
        sessionId = result.sessionId;
        processId = result.processId;
        initialPermissionMode = result.permissionMode;
        initialModeVersion = result.modeVersion;
      }

      // Clean up preview URLs
      for (const pf of pendingFiles) {
        if (pf.previewUrl) {
          URL.revokeObjectURL(pf.previewUrl);
        }
      }

      draftControls.clearDraft();
      // Pass initial status so SessionPage can connect SSE immediately
      // without waiting for getSession to complete
      // Also pass initial message as optimistic title (session name = first message)
      // Pass provider so provider-specific controls can render immediately
      const navigationState: SessionNavigationState = {
        initialStatus: {
          owner: "self",
          processId,
          permissionMode: initialPermissionMode,
          modeVersion: initialModeVersion,
        },
        initialTitle: trimmedMessage,
        initialProvider: selectedProvider ?? undefined,
      };
      navigate(`${basePath}/projects/${projectId}/sessions/${sessionId}`, {
        state: navigationState,
      });
    } catch (err) {
      console.error("Failed to start session:", err);
      const restoreForm = shouldRestoreHistoricalEditAfterFailure(
        err,
        false,
        sessionStartOutcomePending,
      );
      if (restoreForm) {
        draftControls.restoreFromStorage();
        setStartRetryBlockedMessage(null);
      }
      setIsStarting(false);

      // Show user-visible error message
      let errorMessage = t("newSessionStartError");
      if (err instanceof Error) {
        // Check for specific error types
        if (err.message.includes("Queue is full")) {
          errorMessage = t("newSessionServerBusy");
        } else if (err.message.includes("503")) {
          errorMessage = t("newSessionServerCapacity");
        } else if (err.message.includes("404")) {
          errorMessage = t("newSessionProjectNotFound");
        } else if (
          err.message.includes("fetch") ||
          err.message.includes("network")
        ) {
          errorMessage = t("newSessionNetworkError");
        } else {
          errorMessage = err.message;
        }
      }
      if (!restoreForm) {
        if (!(err instanceof HistoricalEditQueueError)) {
          errorMessage =
            "The session start status is unknown. Do not retry from this form because the original request may already be running.";
        }
        // Preserve the form for inspection, but block every submit path until
        // navigation/reload resolves the ambiguous queued or transport result.
        setStartRetryBlockedMessage(errorMessage);
      }
      showToast(errorMessage, "error");
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      // Skip Enter during IME composition (e.g. Chinese/Japanese/Korean input)
      if (e.nativeEvent.isComposing) return;

      // On mobile (touch devices), Enter adds newline - must use send button
      // On desktop, Enter sends message, Shift/Ctrl+Enter adds newline
      const isMobile = hasCoarsePointer();

      // If voice recording is active, Enter submits (on any device)
      if (voiceButtonRef.current?.isListening) {
        e.preventDefault();
        handleStartSession();
        return;
      }

      if (isMobile) {
        // Mobile: Enter always adds newline, send button required
        return;
      }

      if (ENTER_SENDS_MESSAGE) {
        if (e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        handleStartSession();
      } else {
        if (e.ctrlKey || e.shiftKey) {
          e.preventDefault();
          handleStartSession();
        }
      }
    }
  };

  const handlePaste = (e: ClipboardEvent) => {
    const copiedInput = readClipboardUserInput(e.clipboardData);
    if (copiedInput && copiedInput.images.length > 0) {
      e.preventDefault();

      if (copiedInput.text) {
        const textarea = textareaRef.current;
        const currentValue = textarea?.value ?? message;
        const start = textarea?.selectionStart ?? currentValue.length;
        const end = textarea?.selectionEnd ?? start;
        const nextMessage = `${currentValue.slice(0, start)}${copiedInput.text}${currentValue.slice(end)}`;
        const nextCursor = start + copiedInput.text.length;

        setInterimTranscript("");
        setMessage(nextMessage);
        setTimeout(() => {
          textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
        }, 0);
      }

      const newPendingFiles: PendingFile[] = copiedInput.images.map((file) => ({
        id: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        file,
        previewUrl: URL.createObjectURL(file),
      }));
      setPendingFiles((prev) => [...prev, ...newPendingFiles]);
      return;
    }

    const items = e.clipboardData?.items;
    if (!items) return;

    const files: File[] = [];
    for (const item of items) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) {
          files.push(file);
        }
      }
    }

    if (files.length > 0) {
      e.preventDefault();
      const newPendingFiles: PendingFile[] = files.map((file) => ({
        id: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        file,
        previewUrl: file.type.startsWith("image/")
          ? URL.createObjectURL(file)
          : undefined,
      }));
      setPendingFiles((prev) => [...prev, ...newPendingFiles]);
    }
  };

  // Voice input handlers
  const handleVoiceTranscript = useCallback(
    (transcript: string) => {
      const trimmed = message.trimEnd();
      if (trimmed) {
        setMessage(`${trimmed} ${transcript}`);
      } else {
        setMessage(transcript);
      }
      setInterimTranscript("");
      // Scroll to bottom after committing voice transcript
      // Use setTimeout to ensure state update has rendered
      setTimeout(() => {
        const textarea = textareaRef.current;
        if (textarea) {
          textarea.scrollTop = textarea.scrollHeight;
        }
      }, 0);
    },
    [message, setMessage],
  );

  const handleInterimTranscript = useCallback((transcript: string) => {
    setInterimTranscript(transcript);
  }, []);

  const insertIntoMessage = useCallback(
    (insertText: string) => {
      const textarea = textareaRef.current;
      const start = textarea?.selectionStart ?? message.length;
      const end = textarea?.selectionEnd ?? message.length;
      const before = message.slice(0, start);
      const after = message.slice(end);
      const leading = before.length > 0 && !/\s$/.test(before) ? " " : "";
      const trailing = after.length > 0 && !/^\s/.test(after) ? " " : " ";
      const nextMessage = `${before}${leading}${insertText}${trailing}${after}`;
      const nextCursor =
        before.length + leading.length + insertText.length + trailing.length;

      setInterimTranscript("");
      setMessage(nextMessage);

      const restoreFocus = () => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
      };

      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(restoreFocus);
      } else {
        setTimeout(restoreFocus, 0);
      }
    },
    [message, setMessage],
  );

  const handleSelectCommand = useCallback(
    (command: string) => {
      insertIntoMessage(command);
    },
    [insertIntoMessage],
  );

  const hasContent = message.trim() || pendingFiles.length > 0;
  const savedDefaults = settings?.newSessionDefaults;
  const savedProviderDefaults = selectedProvider
    ? getNewSessionProviderDefaults(savedDefaults, selectedProvider)
    : undefined;
  const codexMcpDefaultsMatch =
    selectedProvider === "codex"
      ? (savedProviderDefaults?.codexMcpMode ?? "standard") ===
        selectedCodexMcpMode
      : true;
  const thinkingDefaultsMatch = supportsThinkingToggle
    ? (savedProviderDefaults?.thinking ?? undefined) === thinkingForRequest
    : true;
  const reasoningEffortDefaultsMatch =
    selectedProvider === "codex" ||
    selectedProvider === "pi" ||
    selectedProvider === "kimi"
      ? (savedProviderDefaults?.reasoningEffort ?? undefined) ===
        selectedReasoningEffort
      : true;
  const gatewayDefaultsMatch =
    selectedProvider === "pi"
      ? sameLlmGatewayConfig(
          savedProviderDefaults?.llmGatewayConfig,
          llmGatewayConfigForRequest,
        )
      : true;
  const savedPermissionMode = normalizeProviderPermissionMode(
    selectedProvider,
    savedProviderDefaults?.permissionMode,
    selectedProviderInfo?.permissionModes,
  );
  const defaultsMatchCurrent =
    (savedDefaults?.provider ?? undefined) ===
      (selectedProvider ?? undefined) &&
    (savedProviderDefaults?.model ?? undefined) === modelForRequest &&
    (savedProviderDefaults?.codexModelProvider ?? undefined) ===
      codexModelProviderForRequest &&
    savedPermissionMode === mode &&
    thinkingDefaultsMatch &&
    reasoningEffortDefaultsMatch &&
    codexMcpDefaultsMatch &&
    gatewayDefaultsMatch;

  // Split providers into available vs unavailable so the unavailable ones can
  // be tucked behind a toggle (keeps the grid from looking ragged).
  const { availableProviderList, unavailableProviderList } = useMemo(() => {
    const isAvailable = (p: ProviderInfo) =>
      p.installed && (p.authenticated || p.enabled);
    return {
      availableProviderList: providers.filter(isAvailable),
      unavailableProviderList: providers.filter((p) => !isAvailable(p)),
    };
  }, [providers]);

  const renderProviderButton = (p: ProviderInfo) => {
    const isAvailable = p.installed && (p.authenticated || p.enabled);
    const isSelected = selectedProvider === p.name;
    return (
      <button
        key={p.name}
        type="button"
        className={`provider-option ${isSelected ? "selected" : ""} ${!isAvailable ? "disabled" : ""}`}
        data-provider={p.name}
        style={
          {
            "--provider-option-accent": getNewSessionProviderAccent(p.name),
          } as CSSProperties
        }
        onClick={() => isAvailable && handleProviderSelect(p.name)}
        disabled={isStarting || !isAvailable}
        aria-pressed={isSelected}
        title={
          !isAvailable
            ? t("newSessionProviderUnavailable", {
                provider: p.displayName,
                reason: !p.installed
                  ? t("newSessionProviderNotInstalled")
                  : t("newSessionProviderNotAuthenticated"),
              })
            : p.displayName
        }
      >
        <span className={`provider-option-dot provider-${p.name}`} />
        <div className="provider-option-content">
          <span className="provider-option-label">{p.displayName}</span>
          {!isAvailable && (
            <span className="provider-option-status">
              {!p.installed
                ? t("newSessionProviderStatusNotInstalled")
                : t("newSessionProviderStatusNotAuthenticated")}
            </span>
          )}
        </div>
      </button>
    );
  };

  // Shared input area with toolbar (textarea + attach/voice on left, send on right)
  const inputArea = (
    <>
      <textarea
        ref={textareaRef}
        value={displayText}
        onChange={(e) => {
          setInterimTranscript("");
          setMessage(e.target.value);
        }}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        placeholder={resolvedPlaceholder}
        disabled={isStarting}
        rows={rows}
        className="new-session-form-textarea"
      />
      <div className="new-session-form-toolbar">
        <div className="new-session-form-toolbar-left">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={handleFileSelect}
          />
          <button
            type="button"
            className="toolbar-button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isStarting}
            aria-label={t("newSessionAttachFiles")}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          <VoiceInputButton
            ref={voiceButtonRef}
            onTranscript={handleVoiceTranscript}
            onInterimTranscript={handleInterimTranscript}
            onListeningStart={() => textareaRef.current?.focus()}
            disabled={isStarting}
            className="toolbar-button"
          />
          {commandButtons
            .filter((button) => button.showButton && button.commands.length > 0)
            .map((button) => (
              <SlashCommandButton
                key={button.prefix}
                commands={button.commands}
                onSelectCommand={handleSelectCommand}
                disabled={isStarting}
                prefix={button.prefix}
                label={button.label}
              />
            ))}
          {supportsThinkingToggle && compact && (
            <button
              type="button"
              className={`toolbar-button thinking-toggle-button ${thinkingMode !== "off" ? `active ${thinkingMode}` : ""}`}
              onClick={cycleThinkingMode}
              disabled={isStarting}
              title={
                thinkingMode === "off"
                  ? t("newSessionThinkingOff")
                  : thinkingMode === "auto"
                    ? t("newSessionThinkingAuto")
                    : t("newSessionThinkingOn", {
                        level: getEffortLabel(
                          effectiveCodexReasoningEffort ?? thinkingLevel,
                        ),
                      })
              }
              aria-label={t("newSessionThinkingMode", { mode: thinkingMode })}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
                {thinkingMode === "auto" && (
                  <g>
                    <circle
                      cx="19"
                      cy="5"
                      r="5.5"
                      fill="currentColor"
                      stroke="none"
                    />
                    <text
                      x="19"
                      y="5"
                      textAnchor="middle"
                      dominantBaseline="central"
                      fill="var(--bg-primary, #1a1a2e)"
                      fontSize="8"
                      fontWeight="700"
                      fontFamily="system-ui, sans-serif"
                      stroke="none"
                    >
                      A
                    </text>
                  </g>
                )}
              </svg>
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={handleStartSession}
          disabled={
            isStarting ||
            Boolean(startRetryBlockedMessage) ||
            !hasContent ||
            hasGatewayConfigError
          }
          className="send-button"
          aria-label={t("newSessionStartAction")}
          title={startRetryBlockedMessage ?? undefined}
        >
          {isStarting ? (
            <span className="send-spinner" />
          ) : (
            <span className="send-icon">↑</span>
          )}
        </button>
      </div>
      {startRetryBlockedMessage && (
        <p className="new-session-limit-error" role="alert">
          {startRetryBlockedMessage}
        </p>
      )}
      {supportsThinkingToggle && compact && (
        <div className="new-session-effort-control">
          <span className="new-session-effort-label">
            {t("newSessionEffortTitle")}
          </span>
          <div className="new-session-effort-options">
            {EFFORT_LEVEL_OPTIONS.map((option) => {
              const label = getEffortLabel(option.value);
              const selected =
                thinkingMode === "on" && thinkingLevel === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  className={`new-session-effort-option ${selected ? "selected" : ""}`}
                  onClick={() => handleSelectEffort(option.value)}
                  disabled={isStarting}
                  aria-pressed={selected}
                  aria-label={`${t("newSessionEffortTitle")}: ${label}`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {showKimiReasoningSelector && compact && (
        <div className="new-session-effort-control">
          <span className="new-session-effort-label">
            {t("newSessionThinkingControlTitle")}
          </span>
          <div className="new-session-effort-options">
            {kimiReasoningOptions.map((option) => {
              const selected = effectiveKimiReasoningEffort === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  className={`new-session-effort-option ${selected ? "selected" : ""}`}
                  onClick={() => setKimiReasoningEffort(option.value)}
                  disabled={isStarting}
                  aria-pressed={selected}
                  aria-label={`${t("newSessionThinkingControlTitle")}: ${option.label}`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {pendingFiles.length > 0 && (
        <div className="pending-files-list">
          {pendingFiles.map((pf) => {
            const progress = uploadProgress[pf.id];
            return (
              <div key={pf.id} className="pending-file-chip">
                {pf.previewUrl && (
                  <img
                    src={pf.previewUrl}
                    alt=""
                    className="pending-file-preview"
                  />
                )}
                <div className="pending-file-info">
                  <span className="pending-file-name">{pf.file.name}</span>
                  <span className="pending-file-size">
                    {progress
                      ? `${Math.round((progress.uploaded / progress.total) * 100)}%`
                      : formatSize(pf.file.size)}
                  </span>
                </div>
                {!isStarting && (
                  <button
                    type="button"
                    className="pending-file-remove"
                    onClick={() => handleRemoveFile(pf.id)}
                    aria-label={t("newSessionRemoveFile", {
                      name: pf.file.name,
                    })}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      aria-hidden="true"
                    >
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );

  // Compact mode: just the input area, no header or mode selector
  if (compact) {
    return (
      <div
        className={`new-session-form new-session-form-compact ${interimTranscript ? "voice-recording" : ""}`}
        data-provider={selectedProvider ?? undefined}
        style={newSessionThemeStyle}
      >
        {inputArea}
      </div>
    );
  }

  // Full mode: form with header, input area, and mode selector
  return (
    <div
      className={`new-session-form new-session-container ${interimTranscript ? "voice-recording" : ""}`}
      data-provider={selectedProvider ?? undefined}
      style={newSessionThemeStyle}
    >
      <div className="new-session-header">
        <h1>{t("newSessionHeaderTitle")}</h1>
        <p className="new-session-subtitle">{t("newSessionHeaderSubtitle")}</p>
      </div>

      {selectedProvider === "codex" && <CodexUsageCard />}

      <div className="new-session-input-area">{inputArea}</div>

      {/* Provider Selection */}
      {!providersLoading && availableProviders.length > 1 && (
        <div className="new-session-provider-section">
          <h3>{t("newSessionProviderTitle")}</h3>
          <div className="provider-options">
            {availableProviderList.map(renderProviderButton)}
            {showUnavailableProviders &&
              unavailableProviderList.map(renderProviderButton)}
            {unavailableProviderList.length > 0 && (
              <button
                type="button"
                className="provider-option provider-option-toggle"
                onClick={() => setShowUnavailableProviders((v) => !v)}
                aria-expanded={showUnavailableProviders}
              >
                <span className="provider-option-label">
                  {showUnavailableProviders
                    ? t("newSessionProviderShowLess")
                    : t("newSessionProviderShowMore", {
                        count: unavailableProviderList.length,
                      })}
                </span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Model / Thinking Selection */}
      {selectedProvider &&
        (modelOptions.length > 0 ||
          supportsThinkingToggle ||
          showKimiReasoningSelector) && (
          <div className="new-session-model-section">
            <div className="new-session-model-controls">
              {modelOptions.length > 0 && (
                <div className="new-session-config-field">
                  <h3>{t("newSessionModelTitle")}</h3>
                  <FilterDropdown
                    label={t("newSessionModelTitle")}
                    options={modelOptions}
                    selected={selectedModel ? [selectedModel] : []}
                    onChange={handleModelSelect}
                    accentColor={selectedProviderAccent}
                    multiSelect={false}
                    placeholder={t("newSessionModelPlaceholder")}
                    selectedDescription={
                      selectedModelCapabilitySummary ?? undefined
                    }
                  />
                  {unavailableCodexSourceHints.length > 0 && (
                    <ul className="new-session-model-source-hints">
                      {unavailableCodexSourceHints.map((hint) => (
                        <li key={hint}>{hint}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {showGatewayEndpointSelector && (
                <div className="new-session-config-field">
                  <h3>{t("newSessionGatewayEndpointTitle")}</h3>
                  <div className="new-session-endpoint-options">
                    <button
                      type="button"
                      className={`new-session-endpoint-option ${selectedGatewayProtocol === "openai-compatible" ? "selected" : ""}`}
                      onClick={() =>
                        handleGatewayProtocolSelect("openai-compatible")
                      }
                      disabled={
                        isStarting ||
                        !selectedGatewayProtocols.includes("openai-compatible")
                      }
                      aria-pressed={
                        selectedGatewayProtocol === "openai-compatible"
                      }
                    >
                      {t("newSessionGatewayEndpointOpenAI")}
                    </button>
                    <button
                      type="button"
                      className={`new-session-endpoint-option ${selectedGatewayProtocol === "anthropic" ? "selected" : ""}`}
                      onClick={() => handleGatewayProtocolSelect("anthropic")}
                      disabled={
                        isStarting ||
                        !selectedGatewayProtocols.includes("anthropic")
                      }
                      aria-pressed={selectedGatewayProtocol === "anthropic"}
                    >
                      {t("newSessionGatewayEndpointAnthropic")}
                    </button>
                  </div>
                </div>
              )}
              {showKimiReasoningSelector && (
                <div className="new-session-config-field">
                  <h3>{t("newSessionThinkingControlTitle")}</h3>
                  <FilterDropdown
                    label={t("newSessionThinkingControlTitle")}
                    options={kimiReasoningOptions}
                    selected={
                      effectiveKimiReasoningEffort
                        ? [effectiveKimiReasoningEffort]
                        : []
                    }
                    onChange={handleKimiReasoningSelect}
                    accentColor={selectedProviderAccent}
                    multiSelect={false}
                    placeholder={t("newSessionThinkingControlTitle")}
                    align="right"
                  />
                </div>
              )}
              {supportsThinkingToggle && (
                <div className="new-session-config-field">
                  <h3>{t("newSessionThinkingControlTitle")}</h3>
                  <FilterDropdown
                    label={t("newSessionThinkingControlTitle")}
                    options={thinkingOptions}
                    selected={[selectedThinkingPreset]}
                    onChange={handleThinkingSelect}
                    accentColor={selectedProviderAccent}
                    multiSelect={false}
                    placeholder={t("newSessionThinkingControlTitle")}
                    align="right"
                  />
                </div>
              )}
            </div>
          </div>
        )}

      {/* Codex MCP Profile - matches cf / cf -mcp launch modes */}
      {selectedProvider === "codex" && (
        <div className="new-session-codex-mcp-section">
          <h3>{t("newSessionCodexMcpTitle")}</h3>
          <p className="new-session-section-hint">
            {t("newSessionCodexMcpDescription")}
          </p>
          <div className="codex-mcp-options">
            {CODEX_MCP_MODE_ORDER.map((mcpMode) => (
              <button
                key={mcpMode}
                type="button"
                className={`mode-option codex-mcp-option ${selectedCodexMcpMode === mcpMode ? "selected" : ""}`}
                onClick={() => handleCodexMcpModeSelect(mcpMode)}
                disabled={isStarting}
                aria-pressed={selectedCodexMcpMode === mcpMode}
              >
                <span
                  className={`mode-option-dot codex-mcp-${mcpMode}`}
                  aria-hidden="true"
                />
                <div className="mode-option-content">
                  <span className="mode-option-label">
                    {codexMcpModeLabels[mcpMode]}
                  </span>
                  <span className="mode-option-desc">
                    {codexMcpModeDescriptions[mcpMode]}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Read-only ZCode MCP server status snapshot, informational only */}
      {selectedProvider === "zcode" && (
        <div className="new-session-mcp-section">
          <h3>{t("newSessionZcodeMcpTitle")}</h3>
          {zcodeMcpLoading ? (
            <p className="settings-hint">{t("newSessionZcodeMcpLoading")}</p>
          ) : zcodeMcpError ? (
            <p className="new-session-limit-error" role="alert">
              {t("newSessionZcodeMcpError", { message: zcodeMcpError })}
            </p>
          ) : !zcodeMcpServers || Object.keys(zcodeMcpServers).length === 0 ? (
            <p className="settings-hint">{t("newSessionZcodeMcpNone")}</p>
          ) : (
            <ul className="new-session-mcp-list">
              {Object.entries(zcodeMcpServers).map(([name, server]) => (
                <li key={name} className="new-session-mcp-item">
                  <span className="new-session-mcp-name">{name}</span>
                  <span className="new-session-mcp-meta">
                    {zcodeMcpStatusLabels[server.status] ?? server.status}
                    {server.toolCount !== undefined
                      ? ` · ${t("newSessionZcodeMcpToolCount", {
                          count: server.toolCount,
                        })}`
                      : ""}
                    {server.transport ? ` · ${server.transport}` : ""}
                  </span>
                  {server.error && (
                    <span className="new-session-mcp-error">
                      {server.error}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Permission Mode Selection - only for providers that support it */}
      {selectedProvider && supportsPermissionMode && (
        <div className="new-session-mode-section">
          <h3>{permissionModeTitle}</h3>
          {permissionModeDescription && (
            <p className="new-session-section-hint">
              {permissionModeDescription}
            </p>
          )}
          <div className="mode-options">
            {permissionModes.map((m) => (
              <button
                key={m}
                type="button"
                className={`mode-option ${mode === m ? "selected" : ""}`}
                onClick={() => handleModeSelect(m)}
                disabled={isStarting}
              >
                <span className={`mode-option-dot mode-${m}`} />
                <div className="mode-option-content">
                  <span className="mode-option-label">{modeLabels[m]}</span>
                  <span className="mode-option-desc">
                    {modeDescriptions[m]}
                  </span>
                </div>
              </button>
            ))}
          </div>

          <div className="new-session-defaults-bar">
            <p className="new-session-defaults-copy">
              {t("newSessionDefaultsDescription")}
            </p>
            <button
              type="button"
              className="new-session-defaults-button"
              onClick={handleSaveDefaults}
              disabled={
                isStarting ||
                isSavingDefaults ||
                settingsLoading ||
                !selectedProvider ||
                hasGatewayConfigError ||
                defaultsMatchCurrent
              }
            >
              {isSavingDefaults
                ? t("newSessionDefaultsSaving")
                : t("newSessionDefaultsAction")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
