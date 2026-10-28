import {
  type CodexMcpMode,
  type CodexServiceTier,
  DEFAULT_PERMISSION_MODE,
  type LiveProviderName,
  type LlmGatewayModelCapabilities,
  type LlmGatewayModelLimits,
  type LlmGatewayRequestProtocol,
  type LlmGatewaySessionConfig,
  type ModelInfo,
  type NewSessionProviderDefaults,
  type ProviderInfo,
  getLlmGatewayModelDefaultLimits,
  getNewSessionProviderDefaults,
  resolveModel,
} from "@yep-anywhere/shared";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import { type UploadedFile, api } from "../api/client";
import { useToastContext } from "../contexts/ToastContext";
import { useAgentCommandCatalog } from "../hooks/useAgentCommandCatalog";
import { useAgentCommandListing } from "../hooks/useAgentCommandListing";
import { useComposer } from "../hooks/useComposer";
import { useConnection } from "../hooks/useConnection";
import { useDraftPersistence } from "../hooks/useDraftPersistence";
import { useLlmGatewayKeys } from "../hooks/useLlmGatewayKeys";
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
import type { AgentCommandAvailability } from "../lib/agentCommands";
import {
  type CodexSkillCommand,
  resolveCodexSkillInputs,
} from "../lib/codexInputCommands";
import {
  getModelReasoningEfforts,
  resolveModelReasoningEffort,
} from "../lib/codexReasoning";
import { getPreferredCursorModelId } from "../lib/cursorModels";
import { draftFileStore } from "../lib/draftFileStore";
import {
  clearLegacySessionPrefill,
  getLegacySessionPrefill,
} from "../lib/legacySessionPrefill";
import { updateNewSessionLayout } from "../lib/newSessionLayout";
import {
  getProviderPermissionModes,
  normalizeProviderPermissionMode,
} from "../lib/providerPermissionModes";
import {
  HistoricalEditQueueError,
  requireStartedHistoricalEdit,
  shouldRestoreHistoricalEditAfterFailure,
} from "../lib/sessionBranching";
import { getCurrentInstallId } from "../lib/storageKeys";
import type { PermissionMode, SessionNavigationState } from "../types";
import { CodexAccountSelect } from "./CodexAccountSelect";
import { CodexUsageCard } from "./CodexUsageCard";
import { ComposerEditor } from "./ComposerEditor";
import {
  ComposerToolbar,
  composerToolbarButtonClass,
  composerToolbarIconSize,
} from "./ComposerToolbar";
import { CursorAccountCard } from "./CursorAccountCard";
import { CursorModelSelect } from "./CursorModelSelect";
import { FilterDropdown, type FilterOption } from "./FilterDropdown";
import { NewSessionSetupSkeleton } from "./NewSessionSkeleton";
import { PiGatewayKeySelect } from "./PiGatewayKeySelect";
import { ThinkingToggleButton } from "./ThinkingToggleButton";

interface PendingFile {
  id: string;
  file: File;
  previewUrl?: string;
}

const CODEX_MCP_MODE_ORDER: CodexMcpMode[] = ["clear", "standard", "full"];
const NEW_SESSION_COMMAND_AVAILABILITY: AgentCommandAvailability = {
  scope: "new-session",
};
const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";

const NEW_SESSION_PROVIDER_ACCENTS = {
  claude: "var(--provider-claude)",
  "claude-ollama": "var(--provider-claude)",
  codex: "var(--provider-codex)",
  "codex-oss": "var(--provider-codex)",
  gemini: "var(--provider-gemini)",
  "gemini-acp": "var(--provider-gemini)",
  pi: "var(--provider-pi)",
  cursor: "var(--provider-cursor)",
  mcode: "var(--provider-mcode)",
  dsh: "var(--provider-dsh)",
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
  const [codexFastMode, setCodexFastMode] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [codexReasoningEffort, setCodexReasoningEffort] = useState<
    string | null
  >(null);
  const [namedReasoningEffort, setNamedReasoningEffort] = useState<
    string | null
  >(null);
  const [selectedGatewayProtocol, setSelectedGatewayProtocol] =
    useState<LlmGatewayRequestProtocol>("openai-compatible");
  const [selectedCodexMcpMode, setSelectedCodexMcpMode] =
    useState<CodexMcpMode>("standard");
  /** Codex account (isolated CODEX_HOME); null = machine-wide ~/.codex login. */
  const [selectedCodexAccountId, setSelectedCodexAccountId] = useState<
    string | null
  >(null);
  /** Pi gateway API key; null = the channel's server-side environment key. */
  const [selectedLlmGatewayKeyId, setSelectedLlmGatewayKeyId] = useState<
    string | null
  >(null);
  const llmGatewayKeys = useLlmGatewayKeys(selectedProvider === "pi");
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const pendingFilesRef = useRef<PendingFile[]>(pendingFiles);
  const removedPendingFilesRef = useRef(new Map<string, PendingFile>());
  const pendingFileOrderRef = useRef<string[]>([]);
  pendingFilesRef.current = pendingFiles;
  const [isStarting, setIsStarting] = useState(false);
  const [startRetryBlockedMessage, setStartRetryBlockedMessage] = useState<
    string | null
  >(null);
  const [uploadProgress, setUploadProgress] = useState<
    Record<string, { uploaded: number; total: number }>
  >({});
  const [isSavingDefaults, setIsSavingDefaults] = useState(false);

  const [cursorCatalog, setCursorCatalog] = useState<ModelInfo[] | null>(null);
  const [cursorCatalogLoading, setCursorCatalogLoading] = useState(false);
  const [mcodeCatalog, setMcodeCatalog] = useState<ModelInfo[] | null>(null);
  const cursorPrepareKeyRef = useRef<string | null>(null);

  // Object URLs keep their backing Blob alive for the lifetime of the page.
  // Removal and successful submission revoke them below; this cleanup covers
  // route changes, cancelled drafts, and failed starts that unmount the form.
  useEffect(
    () => () => {
      for (const pendingFile of [
        ...pendingFilesRef.current,
        ...removedPendingFilesRef.current.values(),
      ]) {
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
  const {
    providers,
    loading: providersLoading,
    refetch: refetchProviders,
  } = useProviders();
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
  // Get models and capabilities for the currently selected provider.
  // A cold Cursor catalog must not block the shared provider list, so the
  // form loads it only after Cursor is selected and the list is still empty.
  const listedModels = selectedProviderInfo?.models ?? [];
  const availableModels: ModelInfo[] =
    selectedProvider === "mcode" && mcodeCatalog
      ? mcodeCatalog
      : selectedProvider === "cursor" &&
          listedModels.length === 0 &&
          cursorCatalog &&
          cursorCatalog.length > 0
        ? cursorCatalog
        : listedModels;
  const selectedModelInfo = availableModels.find(
    (model) => model.id === selectedModel,
  );
  const showCodexFastMode =
    selectedProvider === "codex" &&
    (!selectedModelInfo?.modelProvider ||
      selectedModelInfo.modelProvider === "openai");
  const supportsCodexFastMode = selectedModelInfo?.supportsFastMode === true;
  const serviceTierForRequest: CodexServiceTier | undefined = showCodexFastMode
    ? codexFastMode && supportsCodexFastMode
      ? "priority"
      : "default"
    : undefined;
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
  // MiniMax Code folds its plain/thinking model variants into an
  // off + named-effort picker (see server mcode-models.ts).
  const usesNamedEffortReasoning = selectedProvider === "mcode";
  const namedReasoningEfforts = useMemo(
    () =>
      usesNamedEffortReasoning
        ? getModelReasoningEfforts(selectedModelInfo)
        : [],
    [selectedModelInfo, usesNamedEffortReasoning],
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
            (codexReasoningEfforts.length === 0 ? thinkingLevel : undefined),
        )
      : undefined;
  const effectiveNamedReasoningEffort =
    usesNamedEffortReasoning && namedReasoningEfforts.length > 0
      ? resolveModelReasoningEffort(selectedModelInfo, namedReasoningEffort)
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
      : usesNamedEffortReasoning
        ? effectiveNamedReasoningEffort
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
    effectiveCodexReasoningEffort &&
    isEffortLevel(effectiveCodexReasoningEffort)
      ? effectiveCodexReasoningEffort
      : resolvedClaudeThinkingEffort &&
          isEffortLevel(resolvedClaudeThinkingEffort)
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
      if (selectedProvider === "codex") {
        setCodexReasoningEffort(effort);
        if (isEffortLevel(effort)) setEffortLevel(effort);
        setThinkingMode("on");
        return;
      }
      if (!isEffortLevel(effort)) return;
      setEffortLevel(effort);
      setThinkingMode("on");
    },
    [selectedProvider, setEffortLevel, setThinkingMode],
  );
  const handleThinkingSelect = useCallback(
    (selected: ThinkingPreset[]) => {
      applyThinkingPreset(selected[0] ?? "off");
    },
    [applyThinkingPreset],
  );
  const namedReasoningOptions = useMemo((): FilterOption<string>[] => {
    return namedReasoningEfforts.map((option) => {
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
  }, [getEffortLabel, namedReasoningEfforts, t]);
  const handleNamedReasoningSelect = useCallback((selected: string[]) => {
    setNamedReasoningEffort(selected[0] ?? null);
  }, []);
  const showNamedReasoningSelector =
    usesNamedEffortReasoning && namedReasoningOptions.length > 0;

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
  // Skills and provider commands for this project, without a session: the
  // provider's last report for the directory, or its skill directories.
  const { listing: commandListing, refresh: refreshCommandListing } =
    useAgentCommandListing({ projectId, provider: selectedProvider });
  const codexSkills = useMemo<CodexSkillCommand[]>(
    () =>
      selectedProvider === "codex"
        ? (commandListing?.skills ?? []).flatMap((skill) =>
            skill.path
              ? [
                  {
                    name: skill.name,
                    path: skill.path,
                    ...(skill.description
                      ? { description: skill.description }
                      : {}),
                  },
                ]
              : [],
          )
        : [],
    [commandListing, selectedProvider],
  );
  const codexInputsForMessage = (text: string) => {
    if (selectedProvider !== "codex") return undefined;
    const inputs = resolveCodexSkillInputs(text, codexSkills);
    return inputs.length > 0 ? inputs : undefined;
  };
  const commandButtons = useAgentCommandCatalog({
    provider: selectedProvider,
    supportsSlashCommands: selectedProviderInfo?.supportsSlashCommands,
    providerCommands: commandListing?.commands,
    codexSkills,
    availability: NEW_SESSION_COMMAND_AVAILABILITY,
  });

  const applyProviderSelection = useCallback(
    (provider: ProviderInfo, savedDefaults?: NewSessionProviderDefaults) => {
      const providerName = provider.name;
      updateNewSessionLayout({ provider: providerName });
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
        providerName === "cursor"
          ? getPreferredCursorModelId(
              models,
              savedDefaults?.model ?? provider.currentModel,
            )
          : providerName === "pi"
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
      setCodexFastMode(
        providerName === "codex" && savedDefaults?.serviceTier === "priority",
      );
      setSelectedCodexMcpMode(
        providerName === "codex"
          ? (savedDefaults?.codexMcpMode ?? "standard")
          : "standard",
      );
      setSelectedCodexAccountId(
        providerName === "codex"
          ? (savedDefaults?.codexAccountId ?? null)
          : null,
      );
      setSelectedLlmGatewayKeyId(
        providerName === "pi" ? (savedDefaults?.llmGatewayKeyId ?? null) : null,
      );
      setNamedReasoningEffort(
        providerName === "mcode"
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
              ? savedThinkingPreset.slice(3)
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

  // When an explicit gateway key is picked, the model dropdown narrows to the
  // models that key can actually reach: a key only works on its own gateway,
  // and aggregator keys often expose a subset of that gateway's catalog.
  const gatewayKeyModelFilter = useMemo(():
    | ((modelId: string) => boolean)
    | null => {
    if (selectedProvider !== "pi" || !selectedLlmGatewayKeyId) return null;
    const key = llmGatewayKeys.keys.find(
      (entry) => entry.id === selectedLlmGatewayKeyId,
    );
    if (!key) return null;
    const channels = llmGatewayKeys.channels;
    const defaultChannelId =
      (channels.find((channel) => channel.isDefault) ?? channels[0])?.id ??
      null;
    const reachable = key.status?.ok === true ? (key.status.models ?? []) : [];
    return (modelId: string) => {
      if (modelId === "default") return true;
      const separator = modelId.indexOf("/");
      const prefix = separator > 0 ? modelId.slice(0, separator) : null;
      const qualified =
        prefix !== null && channels.some((channel) => channel.id === prefix);
      const channelId = qualified ? prefix : defaultChannelId;
      if (channelId !== key.channelId) return false;
      if (reachable.length === 0) return true;
      return reachable.includes(
        qualified ? modelId.slice(separator + 1) : modelId,
      );
    };
  }, [
    llmGatewayKeys.channels,
    llmGatewayKeys.keys,
    selectedLlmGatewayKeyId,
    selectedProvider,
  ]);

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
      if (gatewayKeyModelFilter && !gatewayKeyModelFilter(model.id)) continue;
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
    gatewayKeyModelFilter,
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

  // Keep the model consistent with the chosen key: if the current model is not
  // reachable on it, fall back to the first model the key does serve.
  useEffect(() => {
    if (!gatewayKeyModelFilter || selectedProvider !== "pi") return;
    if (availableModels.length === 0) return;
    if (selectedModel && gatewayKeyModelFilter(selectedModel)) return;
    const next = availableModels.find((model) =>
      gatewayKeyModelFilter(model.id),
    );
    handleModelSelect(next ? [next.id] : []);
  }, [
    availableModels,
    gatewayKeyModelFilter,
    handleModelSelect,
    selectedModel,
    selectedProvider,
  ]);

  const handleGatewayProtocolSelect = useCallback(
    (protocol: LlmGatewayRequestProtocol) => {
      if (!selectedGatewayProtocols.includes(protocol)) return;
      setSelectedGatewayProtocol(protocol);
    },
    [selectedGatewayProtocols],
  );

  // Local files survive refreshes and navigation in IndexedDB, keyed like the
  // text draft. Until the restore finishes, starting is blocked so a draft
  // cannot be sent with `@[name]` tokens whose files are still loading.
  const draftFilesKey = `${getCurrentInstallId() ?? location.host}:new-session:${projectId}`;
  const [restoringFiles, setRestoringFiles] = useState(
    draftFileStore.available,
  );
  const reportedUnsavedRef = useRef(new Set<string>());
  useEffect(() => {
    if (!draftFileStore.available) return;
    let cancelled = false;
    void draftFileStore.load(draftFilesKey).then((stored) => {
      if (cancelled) return;
      if (stored.length > 0 && pendingFilesRef.current.length === 0) {
        const restored = stored.map(({ id, file }) => ({
          id,
          file,
          previewUrl: file.type.startsWith("image/")
            ? URL.createObjectURL(file)
            : undefined,
        }));
        pendingFileOrderRef.current = restored.map((file) => file.id);
        setPendingFiles(restored);
      }
      setRestoringFiles(false);
    });
    return () => {
      cancelled = true;
    };
  }, [draftFilesKey]);
  useEffect(() => {
    if (!draftFileStore.available || restoringFiles || isStarting) return;
    const timer = setTimeout(() => {
      void draftFileStore
        .save(
          draftFilesKey,
          pendingFiles.map(({ id, file }) => ({ id, file })),
        )
        .then(({ skippedNames }) => {
          const fresh = skippedNames.filter(
            (name) => !reportedUnsavedRef.current.has(name),
          );
          for (const name of fresh) reportedUnsavedRef.current.add(name);
          if (fresh.length > 0)
            showToast(
              t("newSessionFilesNotSaved", { names: fresh.join(", ") }),
              "info",
            );
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [draftFilesKey, isStarting, pendingFiles, restoringFiles, showToast, t]);

  const addPendingFiles = (files: File[], beforeAttachmentId?: string) => {
    const newPendingFiles: PendingFile[] = files.map((file) => ({
      id: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file,
      previewUrl: file.type.startsWith("image/")
        ? URL.createObjectURL(file)
        : undefined,
    }));
    const order = pendingFileOrderRef.current;
    const anchorIndex = beforeAttachmentId
      ? order.indexOf(beforeAttachmentId)
      : -1;
    order.splice(
      anchorIndex < 0 ? order.length : anchorIndex,
      0,
      ...newPendingFiles.map((file) => file.id),
    );
    setPendingFiles((prev) =>
      [...prev, ...newPendingFiles].sort(
        (left, right) => order.indexOf(left.id) - order.indexOf(right.id),
      ),
    );
  };

  const removePendingFiles = (ids: string[]) => {
    if (ids.length === 0) return;
    for (const file of pendingFilesRef.current) {
      if (ids.includes(file.id))
        removedPendingFilesRef.current.set(file.id, file);
    }
    setPendingFiles((prev) => prev.filter((file) => !ids.includes(file.id)));
  };

  const composer = useComposer({
    text: message,
    setText: setMessage,
    attachments: pendingFiles,
    describeAttachment: (pending) => {
      const progress = isStarting ? uploadProgress[pending.id] : undefined;
      return {
        id: pending.id,
        name: pending.file.name,
        mimeType: pending.file.type,
        previewUrl: pending.previewUrl,
        pending: !!progress,
        progress: progress
          ? progress.total > 0
            ? (progress.uploaded / progress.total) * 100
            : 0
          : undefined,
      };
    },
    // Pending files are still local, so copies carry their bytes.
    getClipboardSource: (pending) => ({
      name: pending.file.name,
      mimeType: pending.file.type,
      read: async () => pending.file,
    }),
    disabled: isStarting,
    onAttach: addPendingFiles,
    onRemove: removePendingFiles,
    onRestore: (ids) => {
      const restored = ids.flatMap((id) => {
        const file = removedPendingFilesRef.current.get(id);
        if (!file) return [];
        removedPendingFilesRef.current.delete(id);
        return [file];
      });
      if (restored.length > 0)
        setPendingFiles((prev) =>
          [...prev, ...restored].sort(
            (left, right) =>
              pendingFileOrderRef.current.indexOf(left.id) -
              pendingFileOrderRef.current.indexOf(right.id),
          ),
        );
    },
    commandConfigs: commandButtons,
    onCommandMenuOpen: refreshCommandListing,
    onSubmit: () => {
      void handleStartSession();
    },
  });
  const editorRef = composer.editorRef;

  // Focus the editor on mount if autoFocus is enabled
  useEffect(() => {
    if (autoFocus) {
      editorRef.current?.focus();
    }
  }, [autoFocus, editorRef]);

  // Recover a pending draft handoff from clients with the retired floating composer.
  useEffect(() => {
    const prefill = getLegacySessionPrefill();
    if (prefill) {
      setMessage(prefill);
      clearLegacySessionPrefill();
      // Focus and move cursor to end
      if (editorRef.current) {
        editorRef.current.focus();
        editorRef.current.setSelectionRange(prefill.length, prefill.length);
      }
    }
  }, [setMessage, editorRef]);

  const handleModeSelect = (selectedMode: PermissionMode) => {
    setMode(selectedMode);
  };

  const handleCodexMcpModeSelect = (selectedMode: CodexMcpMode) => {
    setSelectedCodexMcpMode(selectedMode);
  };

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

  const cursorListedCount =
    providers.find((provider) => provider.name === "cursor")?.models?.length ??
    0;
  useEffect(() => {
    if (selectedProvider !== "mcode") {
      setMcodeCatalog(null);
      return;
    }
    let cancelled = false;
    // The shared provider list returns immediately while ACP refreshes in the
    // background. Consume that refresh even when the previous list was nonempty.
    api
      .getProvider("mcode", { fresh: true })
      .then(({ provider }) => {
        if (cancelled) return;
        const models = provider.models ?? [];
        setMcodeCatalog(models);
        setSelectedModel((current) => getPreferredModelId(models, current));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [selectedProvider]);

  useEffect(() => {
    if (selectedProvider !== "cursor" || cursorListedCount > 0) return;
    let cancelled = false;
    setCursorCatalogLoading(true);
    api
      .getProvider("cursor", { fresh: true })
      .then((result) => {
        if (cancelled) return;
        setCursorCatalog(result.provider.models ?? []);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setCursorCatalogLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedProvider, cursorListedCount]);

  useEffect(() => {
    const discard = (key: string | null) => {
      if (!key) return;
      const splitAt = key.indexOf("\0");
      void api
        .discardCursorSession({
          projectId: key.slice(0, splitAt),
          model: key.slice(splitAt + 1) || undefined,
        })
        .catch(() => undefined);
    };
    if (selectedProvider !== "cursor" || !projectId || !modelForRequest) {
      discard(cursorPrepareKeyRef.current);
      cursorPrepareKeyRef.current = null;
      return;
    }
    const key = `${projectId}\0${modelForRequest}`;
    if (cursorPrepareKeyRef.current && cursorPrepareKeyRef.current !== key) {
      discard(cursorPrepareKeyRef.current);
    }
    cursorPrepareKeyRef.current = key;
    void api
      .prepareCursorSession({
        projectId,
        model: modelForRequest,
        permissionMode: mode,
      })
      .catch(() => undefined);
  }, [mode, modelForRequest, projectId, selectedProvider]);

  useEffect(
    () => () => {
      const key = cursorPrepareKeyRef.current;
      cursorPrepareKeyRef.current = null;
      if (!key) return;
      const splitAt = key.indexOf("\0");
      void api
        .discardCursorSession({
          projectId: key.slice(0, splitAt),
          model: key.slice(splitAt + 1) || undefined,
        })
        .catch(() => undefined);
    },
    [],
  );
  // Native Codex tiers outside the shared enum (e.g. ultra) travel only in
  // reasoningEffort; never send an unrelated shared thinking level alongside.
  const thinkingForRequest =
    supportsThinkingToggle &&
    !(
      selectedProvider === "codex" &&
      thinkingMode === "on" &&
      effectiveCodexReasoningEffort &&
      !isEffortLevel(effectiveCodexReasoningEffort)
    )
      ? getThinkingOption(thinkingMode, effectiveThinkingEffort)
      : undefined;
  const currentProviderDefaults = useMemo(
    (): NewSessionProviderDefaults => ({
      model: modelForRequest,
      thinking: thinkingForRequest,
      reasoningEffort: selectedReasoningEffort,
      serviceTier: serviceTierForRequest,
      permissionMode: mode,
      codexMcpMode:
        selectedProvider === "codex" ? selectedCodexMcpMode : undefined,
      codexModelProvider: codexModelProviderForRequest,
      codexAccountId:
        selectedProvider === "codex"
          ? (selectedCodexAccountId ?? undefined)
          : undefined,
      llmGatewayKeyId:
        selectedProvider === "pi"
          ? (selectedLlmGatewayKeyId ?? undefined)
          : undefined,
      llmGatewayConfig: llmGatewayConfigForRequest,
    }),
    [
      mode,
      llmGatewayConfigForRequest,
      selectedCodexAccountId,
      selectedLlmGatewayKeyId,
      selectedCodexMcpMode,
      codexModelProviderForRequest,
      modelForRequest,
      selectedProvider,
      selectedReasoningEffort,
      serviceTierForRequest,
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
    // Stop dictation and include any pending transcript.
    const finalMessage = composer.takeText();

    const hasContent = finalMessage.trim() || pendingFiles.length > 0;
    if (
      !projectId ||
      !hasContent ||
      isStarting ||
      restoringFiles ||
      startRetryBlockedMessage ||
      selectedProviderInfo?.unavailableReason ||
      hasGatewayConfigError
    ) {
      return;
    }

    const trimmedMessage = finalMessage.trim();

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
      // Session input toolbars initialize from this preference. Persist the
      // resolved native tier as well when restoring defaults or changing models.
      if (
        selectedProvider === "codex" &&
        selectedReasoningEffort &&
        isEffortLevel(selectedReasoningEffort)
      ) {
        setEffortLevel(selectedReasoningEffort);
      }
      const sessionOptions = {
        mode,
        model: modelForRequest,
        thinking,
        reasoningEffort: selectedReasoningEffort,
        serviceTier: serviceTierForRequest,
        provider: selectedProvider ?? undefined,
        codexMcpMode:
          selectedProvider === "codex" ? selectedCodexMcpMode : undefined,
        codexModelProvider: codexModelProviderForRequest,
        codexAccountId:
          selectedProvider === "codex"
            ? (selectedCodexAccountId ?? undefined)
            : undefined,
        llmGatewayKeyId:
          selectedProvider === "pi"
            ? (selectedLlmGatewayKeyId ?? undefined)
            : undefined,
        llmGatewayConfig: llmGatewayConfigForRequest,
        codexInputs: codexInputsForMessage(trimmedMessage),
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
          undefined, // deferred
          sessionOptions.codexInputs,
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
      void draftFileStore.remove(draftFilesKey);
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
        initialModel: sessionOptions.model,
        initialReasoningEffort: sessionOptions.reasoningEffort,
        initialServiceTier: sessionOptions.serviceTier,
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
        const code = (err as Error & { code?: string }).code;
        // Check for specific error types
        if (code === "runtime-update-required") {
          errorMessage = t("cursorRuntimeUpdateRequired");
          void refetchProviders();
        } else if (code === "runtime-unavailable") {
          errorMessage = t("cursorRuntimeUnavailable");
        } else if (err.message.includes("Queue is full")) {
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

  const hasContent = message.trim() || pendingFiles.length > 0;
  const savedDefaults = settings?.newSessionDefaults;
  const savedProviderDefaults = selectedProvider
    ? getNewSessionProviderDefaults(savedDefaults, selectedProvider)
    : undefined;
  const codexMcpDefaultsMatch =
    selectedProvider === "codex"
      ? (savedProviderDefaults?.codexMcpMode ?? "standard") ===
          selectedCodexMcpMode &&
        (savedProviderDefaults?.codexAccountId ?? null) ===
          selectedCodexAccountId
      : true;
  const thinkingDefaultsMatch = supportsThinkingToggle
    ? (savedProviderDefaults?.thinking ?? undefined) === thinkingForRequest
    : true;
  const reasoningEffortDefaultsMatch =
    selectedProvider === "codex" ||
    selectedProvider === "pi" ||
    selectedProvider === "mcode"
      ? (savedProviderDefaults?.reasoningEffort ?? undefined) ===
        selectedReasoningEffort
      : true;
  const gatewayDefaultsMatch =
    selectedProvider === "pi"
      ? sameLlmGatewayConfig(
          savedProviderDefaults?.llmGatewayConfig,
          llmGatewayConfigForRequest,
        ) &&
        (savedProviderDefaults?.llmGatewayKeyId ?? null) ===
          selectedLlmGatewayKeyId
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
    (serviceTierForRequest === undefined ||
      (savedProviderDefaults?.serviceTier ?? "default") ===
        serviceTierForRequest) &&
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

  // Shared composer (editor + toolbar); the send button starts the session.
  const inputArea = (
    <>
      <ComposerEditor
        composer={composer}
        containerClassName="new-session-composer"
        className="new-session-form-textarea"
        menuPlacement="below"
        placeholder={resolvedPlaceholder}
        disabled={isStarting}
        rows={rows}
        attachmentDetail={(pending) => {
          const progress = isStarting ? uploadProgress[pending.id] : undefined;
          return progress
            ? `${Math.round((progress.uploaded / progress.total) * 100)}%`
            : formatSize(pending.file.size);
        }}
      />
      <ComposerToolbar
        variant="new-session"
        attach={{
          onClick: composer.openFilePicker,
          disabled: isStarting,
          title: t("newSessionAttachFiles"),
        }}
        copy={{
          onCopy: composer.document.copyAll,
          disabled: isStarting || !hasContent,
        }}
        thinking={
          supportsThinkingToggle && compact ? (
            <ThinkingToggleButton
              mode={thinkingMode}
              levelLabel={getEffortLabel(
                effectiveCodexReasoningEffort ?? thinkingLevel,
              )}
              onCycle={cycleThinkingMode}
              disabled={isStarting}
              className={composerToolbarButtonClass("new-session")}
              iconSize={composerToolbarIconSize("new-session")}
            />
          ) : undefined
        }
        voice={{
          ...composer.voice,
          disabled: isStarting,
        }}
        commands={{
          buttons: commandButtons,
          onSelect: composer.completion.insertCommand,
          disabled: isStarting,
        }}
        actions={
          <button
            type="button"
            onClick={handleStartSession}
            disabled={
              isStarting ||
              restoringFiles ||
              Boolean(startRetryBlockedMessage) ||
              Boolean(selectedProviderInfo?.unavailableReason) ||
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
        }
      />
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
            {thinkingOptions
              .filter((option) => option.value.startsWith("on:"))
              .map((option) => {
                const label = getEffortLabel(option.value.slice(3));
                const selected = selectedThinkingPreset === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    className={`new-session-effort-option ${selected ? "selected" : ""}`}
                    onClick={() => applyThinkingPreset(option.value)}
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
      {showNamedReasoningSelector && compact && (
        <div className="new-session-effort-control">
          <span className="new-session-effort-label">
            {t("newSessionThinkingControlTitle")}
          </span>
          <div className="new-session-effort-options">
            {namedReasoningOptions.map((option) => {
              const selected = effectiveNamedReasoningEffort === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  className={`new-session-effort-option ${selected ? "selected" : ""}`}
                  onClick={() => setNamedReasoningEffort(option.value)}
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
    </>
  );

  // Compact mode: just the input area, no header or mode selector
  if (compact) {
    return (
      <div
        className={`new-session-form new-session-form-compact ${composer.isDictating ? "voice-recording" : ""}`}
        data-provider={selectedProvider ?? undefined}
        style={newSessionThemeStyle}
      >
        {selectedProviderInfo?.unavailableReason && (
          <p role="status" className="cursor-account-notice">
            {selectedProviderInfo.unavailableReason ===
            "runtime-update-required"
              ? t("cursorRuntimeUpdateRequired")
              : t("cursorRuntimeUnavailable")}
          </p>
        )}
        {inputArea}
      </div>
    );
  }

  // Full mode: form with header, input area, and mode selector
  return (
    <div
      className={`new-session-form new-session-container ${composer.isDictating ? "voice-recording" : ""}`}
      data-provider={selectedProvider ?? undefined}
      style={newSessionThemeStyle}
    >
      <div className="new-session-header">
        <h1>{t("newSessionHeaderTitle")}</h1>
        <p className="new-session-subtitle">{t("newSessionHeaderSubtitle")}</p>
      </div>

      {!selectedProvider && (providersLoading || settingsLoading) && (
        <NewSessionSetupSkeleton
          provider={settings?.newSessionDefaults?.provider}
        />
      )}
      {selectedProvider === "codex" && (
        <CodexAccountSelect
          value={selectedCodexAccountId}
          onChange={setSelectedCodexAccountId}
          disabled={isStarting}
        />
      )}
      {selectedProvider === "codex" && <CodexUsageCard />}
      {selectedProvider === "cursor" && (
        <CursorAccountCard
          providerInfo={selectedProviderInfo}
          unavailableReason={selectedProviderInfo?.unavailableReason}
          onRefresh={refetchProviders}
        />
      )}
      {selectedProvider === "pi" && (
        <PiGatewayKeySelect
          value={selectedLlmGatewayKeyId}
          onChange={setSelectedLlmGatewayKeyId}
          channels={llmGatewayKeys.channels}
          loading={llmGatewayKeys.loading}
          busy={llmGatewayKeys.busy}
          error={llmGatewayKeys.error}
          onAdd={llmGatewayKeys.addKey}
          onRemove={llmGatewayKeys.removeKey}
          onRefresh={llmGatewayKeys.refresh}
          modelId={
            // Pi's managed gateway models travel in `llmGatewayConfig`, not in
            // `model`, and only that id carries the channel prefix that says
            // which gateway's keys are selectable.
            llmGatewayConfigForRequest?.model ?? modelForRequest
          }
          disabled={isStarting}
        />
      )}

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
      {selectedProvider === "cursor" && availableModels.length > 0 && (
        <CursorModelSelect
          models={availableModels}
          value={selectedModel}
          onChange={setSelectedModel}
          accentColor={selectedProviderAccent}
          disabled={isStarting}
        />
      )}
      {selectedProvider === "cursor" &&
        availableModels.length === 0 &&
        cursorCatalogLoading && (
          <p className="new-session-model-section">
            {t("cursorModelsLoading")}
          </p>
        )}
      {selectedProvider &&
        selectedProvider !== "cursor" &&
        (modelOptions.length > 0 ||
          supportsThinkingToggle ||
          showNamedReasoningSelector) && (
          <div className="new-session-model-section">
            <div className="new-session-model-controls">
              {modelOptions.length > 0 && (
                <div className="new-session-config-field">
                  <h3>{t("newSessionModelTitle")}</h3>
                  <div className="new-session-model-picker">
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
                    {showCodexFastMode && (
                      <button
                        type="button"
                        role="switch"
                        aria-checked={serviceTierForRequest === "priority"}
                        aria-label={t("codexFastModeLabel")}
                        className="new-session-fast-toggle"
                        disabled={isStarting || !supportsCodexFastMode}
                        onClick={() => setCodexFastMode((enabled) => !enabled)}
                        title={
                          supportsCodexFastMode
                            ? t("newSessionCodexFastDescription")
                            : t("newSessionCodexFastUnavailable")
                        }
                      >
                        <span
                          className="new-session-fast-indicator"
                          aria-hidden="true"
                        />
                        {t("codexFastModeLabel")}
                      </button>
                    )}
                  </div>
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
              {showNamedReasoningSelector && (
                <div className="new-session-config-field">
                  <h3>{t("newSessionThinkingControlTitle")}</h3>
                  <FilterDropdown
                    label={t("newSessionThinkingControlTitle")}
                    options={namedReasoningOptions}
                    selected={
                      effectiveNamedReasoningEffort
                        ? [effectiveNamedReasoningEffort]
                        : []
                    }
                    onChange={handleNamedReasoningSelect}
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
