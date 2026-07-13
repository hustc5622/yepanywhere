import {
  type CodexMcpMode,
  DEFAULT_PERMISSION_MODE,
  type ModelInfo,
  type OpenCodeJsonObject,
  type OpenCodeModelCapabilities,
  type OpenCodeModelLimits,
  type OpenCodeRequestProtocol,
  type OpenCodeSessionConfig,
  type ProviderInfo,
  type ProviderName,
  resolveModel,
} from "@yep-anywhere/shared";
import {
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
import {
  getAvailableProviders,
  getDefaultProvider,
  useProviders,
} from "../hooks/useProviders";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useServerSettings } from "../hooks/useServerSettings";
import { useI18n } from "../i18n";
import { getStaticAgentCommandConfigs } from "../lib/agentCommands";
import {
  getModelReasoningEfforts,
  resolveModelReasoningEffort,
} from "../lib/codexReasoning";
import { hasCoarsePointer } from "../lib/deviceDetection";
import type { PermissionMode } from "../types";
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

const MODE_ORDER: PermissionMode[] = [
  "auto",
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
];
const CODEX_MCP_MODE_ORDER: CodexMcpMode[] = ["clear", "standard", "full"];
const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";

const EFFORT_LABEL_KEYS: Record<
  EffortLevel,
  | "newSessionEffortLow"
  | "newSessionEffortMedium"
  | "newSessionEffortHigh"
  | "newSessionEffortMax"
> = {
  low: "newSessionEffortLow",
  medium: "newSessionEffortMedium",
  high: "newSessionEffortHigh",
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
  "on:max",
];
const DEFAULT_OPENCODE_CAPABILITIES: OpenCodeModelCapabilities = {
  attachment: false,
  reasoning: false,
  temperature: true,
  toolCall: true,
};

function getDefaultOpenCodeCapabilities(
  protocol: OpenCodeRequestProtocol,
): OpenCodeModelCapabilities {
  return {
    ...DEFAULT_OPENCODE_CAPABILITIES,
    reasoning: protocol === "anthropic",
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
  }

  return (
    models.find((m) => m.id === fallbackModelId)?.id ?? models[0]?.id ?? null
  );
}

function getPreferredOpenCodeModelId(
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

function parseOpenCodeLimitInput(value: string): number | undefined | null {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const normalized = trimmed.replace(/[,_\s]/g, "").toLowerCase();
  const match = normalized.match(/^(\d+(?:\.\d+)?)([km])?$/);
  if (!match) return null;

  const amount = Number(match[1]);
  const suffix = match[2];
  const multiplier = suffix === "m" ? 1_000_000 : 1_000;
  const tokens = Math.round(amount * multiplier);

  if (!Number.isSafeInteger(tokens) || tokens <= 0) return null;
  return tokens;
}

function formatOpenCodeLimitInput(tokens: number | undefined): string {
  if (!tokens || tokens <= 0) return "";
  const valueInK = tokens / 1_000;
  return Number.isInteger(valueInK)
    ? String(valueInK)
    : String(Number(valueInK.toFixed(3)));
}

export function getOpenCodeModelLimits(
  contextInput: string,
  outputInput: string,
): { limits?: OpenCodeModelLimits; error?: "invalid" | "incomplete" } {
  const context = parseOpenCodeLimitInput(contextInput);
  const output = parseOpenCodeLimitInput(outputInput);

  if (context === null || output === null) return { error: "invalid" };
  if (context === undefined && output === undefined) return {};
  if (context === undefined || output === undefined) {
    return { error: "incomplete" };
  }
  return { limits: { context, output } };
}

export function parseOpenCodeAdvancedInput(value: string): {
  value?: OpenCodeJsonObject;
  error?: "invalid";
} {
  const trimmed = value.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return { error: "invalid" };
    }
    return { value: parsed as OpenCodeJsonObject };
  } catch {
    return { error: "invalid" };
  }
}

function formatOpenCodeAdvancedInput(
  value: OpenCodeJsonObject | undefined,
): string {
  return value ? JSON.stringify(value, null, 2) : "";
}

function sameOpenCodeConfig(
  a: OpenCodeSessionConfig | undefined,
  b: OpenCodeSessionConfig | undefined,
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
  const [selectedProvider, setSelectedProvider] = useState<ProviderName | null>(
    null,
  );
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [codexReasoningEffort, setCodexReasoningEffort] = useState<
    string | null
  >(null);
  const [selectedOpenCodeProtocol, setSelectedOpenCodeProtocol] =
    useState<OpenCodeRequestProtocol>("openai-compatible");
  const [selectedCodexMcpMode, setSelectedCodexMcpMode] =
    useState<CodexMcpMode>("standard");
  const [opencodeContextLimit, setOpencodeContextLimit] = useState("");
  const [opencodeOutputLimit, setOpencodeOutputLimit] = useState("");
  const [opencodeCapabilities, setOpencodeCapabilities] =
    useState<OpenCodeModelCapabilities>(DEFAULT_OPENCODE_CAPABILITIES);
  const [showOpenCodeAdvanced, setShowOpenCodeAdvanced] = useState(false);
  const [opencodeProviderPatch, setOpencodeProviderPatch] = useState("");
  const [opencodeModelPatch, setOpencodeModelPatch] = useState("");
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [isStarting, setIsStarting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<
    Record<string, { uploaded: number; total: number }>
  >({});
  const [interimTranscript, setInterimTranscript] = useState("");
  const [isSavingDefaults, setIsSavingDefaults] = useState(false);
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
  const modeLabels: Record<PermissionMode, string> = {
    auto: t("modeAutoLabel"),
    default: t("modeDefaultLabel"),
    acceptEdits: t("modeAcceptEditsLabel"),
    plan: t("modePlanLabel"),
    bypassPermissions: t("modeBypassPermissionsLabel"),
  };
  const modeDescriptions: Record<PermissionMode, string> = {
    auto: t("modeAutoDescription"),
    default: t("modeDefaultDescription"),
    acceptEdits: t("modeAcceptEditsDescription"),
    plan: t("modePlanDescription"),
    bypassPermissions: t("modeBypassPermissionsDescription"),
  };
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
  const selectedProviderInfo = providers.find(
    (p) => p.name === selectedProvider,
  );
  const availableModels: ModelInfo[] = selectedProviderInfo?.models ?? [];
  const selectedModelInfo = availableModels.find(
    (model) => model.id === selectedModel,
  );
  const selectedOpenCodeProtocols =
    selectedProvider === "opencode"
      ? (selectedModelInfo?.supportedRequestProtocols ?? [])
      : [];
  const isManagedOpenCodeModel = selectedOpenCodeProtocols.length > 0;
  const codexReasoningEfforts = useMemo(
    () => getModelReasoningEfforts(selectedModelInfo),
    [selectedModelInfo],
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
  const getEffortLabel = useCallback(
    (effort: string): string => {
      return isEffortLevel(effort) ? t(EFFORT_LABEL_KEYS[effort]) : effort;
    },
    [t],
  );
  const selectedThinkingPreset: ThinkingPreset =
    selectedProvider === "codex" &&
    thinkingMode === "on" &&
    effectiveCodexReasoningEffort
      ? `on:${effectiveCodexReasoningEffort}`
      : getThinkingPreset(thinkingMode, thinkingLevel);
  const thinkingOptions = useMemo((): FilterOption<ThinkingPreset>[] => {
    const presets: Array<{
      value: ThinkingPreset;
      description?: string;
    }> = [
      { value: "off" },
      { value: "auto" },
      ...(selectedProvider === "codex" && codexReasoningEfforts.length > 0
        ? codexReasoningEfforts.map((option) => ({
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
  }, [codexReasoningEfforts, getEffortLabel, selectedProvider, t]);
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

  // Default to true for backwards compatibility with providers that don't set these flags
  const supportsPermissionMode =
    selectedProviderInfo?.supportsPermissionMode ?? true;
  const supportsThinkingToggle =
    selectedProviderInfo?.supportsThinkingToggle ?? true;
  const commandButtons = useMemo(() => getStaticAgentCommandConfigs(), []);

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

    setSelectedProvider(initialProvider.name);
    const preferredModel =
      initialProvider.name === "opencode"
        ? getPreferredOpenCodeModelId(
            initialProvider.models ?? [],
            savedDefaults?.opencodeConfig?.model ??
              initialProvider.currentModel,
          )
        : getPreferredModelId(
            initialProvider.models ?? [],
            savedDefaults?.model ?? initialProvider.currentModel,
            initialProvider.name === "codex" ? DEFAULT_CODEX_MODEL : undefined,
          );
    if (initialProvider.name === "opencode") {
      const modelInfo = initialProvider.models?.find(
        (model) => model.id === preferredModel,
      );
      const supportedProtocols = modelInfo?.supportedRequestProtocols ?? [];
      const savedProtocol = savedDefaults?.opencodeConfig?.requestProtocol;
      const initialProtocol =
        savedProtocol && supportedProtocols.includes(savedProtocol)
          ? savedProtocol
          : (supportedProtocols[0] ?? "openai-compatible");
      setSelectedOpenCodeProtocol(initialProtocol);
      setOpencodeCapabilities({
        ...getDefaultOpenCodeCapabilities(initialProtocol),
        ...savedDefaults?.opencodeConfig?.capabilities,
      });
      setSelectedModel(preferredModel);
    } else {
      setSelectedModel(preferredModel);
    }
    setSelectedCodexMcpMode(savedDefaults?.codexMcpMode ?? "standard");
    setOpencodeContextLimit(
      formatOpenCodeLimitInput(savedDefaults?.opencodeConfig?.limits?.context),
    );
    setOpencodeOutputLimit(
      formatOpenCodeLimitInput(savedDefaults?.opencodeConfig?.limits?.output),
    );
    setOpencodeProviderPatch(
      formatOpenCodeAdvancedInput(
        savedDefaults?.opencodeConfig?.advanced?.provider,
      ),
    );
    setOpencodeModelPatch(
      formatOpenCodeAdvancedInput(
        savedDefaults?.opencodeConfig?.advanced?.model,
      ),
    );
    setMode(savedDefaults?.permissionMode ?? DEFAULT_PERMISSION_MODE);
    const savedThinkingPreset = normalizeThinkingOption(
      savedDefaults?.thinking,
    );
    if (initialProvider.name === "codex" && savedDefaults?.reasoningEffort) {
      setCodexReasoningEffort(savedDefaults.reasoningEffort);
      if (savedThinkingPreset) {
        applyThinkingPreset(savedThinkingPreset);
      } else {
        setThinkingMode("on");
      }
    } else if (savedThinkingPreset) {
      if (
        initialProvider.name === "codex" &&
        savedThinkingPreset.startsWith("on:")
      ) {
        const legacyEffort = savedThinkingPreset.slice(3);
        setCodexReasoningEffort(
          legacyEffort === "max" ? "xhigh" : legacyEffort,
        );
      }
      applyThinkingPreset(savedThinkingPreset);
    } else if (initialProvider.currentEffortLevel) {
      setEffortLevel(initialProvider.currentEffortLevel);
    }
  }, [
    applyThinkingPreset,
    availableProviders,
    providers,
    providersLoading,
    setEffortLevel,
    setThinkingMode,
    settings,
    settingsLoading,
  ]);

  // When provider changes, reset model based on user settings
  const handleProviderSelect = (providerName: ProviderName) => {
    setSelectedProvider(providerName);
    const provider = providers.find((p) => p.name === providerName);
    if (provider?.models && provider.models.length > 0) {
      const preferredModel =
        providerName === "opencode"
          ? getPreferredOpenCodeModelId(provider.models, provider.currentModel)
          : getPreferredModelId(provider.models, provider.currentModel);
      const resolvedPreferredModel =
        providerName === "codex"
          ? getPreferredModelId(
              provider.models,
              provider.currentModel,
              DEFAULT_CODEX_MODEL,
            )
          : preferredModel;
      if (providerName === "opencode") {
        const modelInfo = provider.models.find(
          (model) => model.id === preferredModel,
        );
        const protocol =
          modelInfo?.supportedRequestProtocols?.[0] ?? "openai-compatible";
        setSelectedOpenCodeProtocol(protocol);
        setOpencodeCapabilities(getDefaultOpenCodeCapabilities(protocol));
        setSelectedModel(preferredModel);
      } else {
        setSelectedModel(resolvedPreferredModel);
      }
    } else {
      setSelectedModel(null);
    }
    if (provider?.currentEffortLevel) {
      setEffortLevel(provider.currentEffortLevel);
    }
  };

  // Build model options for FilterDropdown
  const modelOptions = useMemo((): FilterOption<string>[] => {
    const options: FilterOption<string>[] = [];

    for (const model of availableModels) {
      const label = model.size
        ? `${model.name} (${(model.size / (1024 * 1024 * 1024)).toFixed(1)} GB)`
        : model.name;

      let description = model.description;
      const parts: string[] = description ? [description] : [];
      if (model.parameterSize) parts.push(model.parameterSize);
      if (model.contextWindow) {
        parts.push(`${Math.round(model.contextWindow / 1024)}K ctx`);
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

      options.push({ value: model.id, label, description });
    }

    return options;
  }, [availableModels]);

  const showOpenCodeEndpointSelector =
    selectedProvider === "opencode" &&
    selectedModel !== null &&
    isManagedOpenCodeModel;

  // Handle model selection from FilterDropdown
  const handleModelSelect = useCallback(
    (selected: string[]) => {
      const nextModel = selected[0] ?? null;
      if (selectedProvider === "opencode") {
        const nextInfo = availableModels.find(
          (model) => model.id === nextModel,
        );
        const supportedProtocols = nextInfo?.supportedRequestProtocols ?? [];
        const nextProtocol = supportedProtocols.includes(
          selectedOpenCodeProtocol,
        )
          ? selectedOpenCodeProtocol
          : (supportedProtocols[0] ?? "openai-compatible");
        setSelectedOpenCodeProtocol(nextProtocol);
        if (nextProtocol !== selectedOpenCodeProtocol) {
          setOpencodeCapabilities(getDefaultOpenCodeCapabilities(nextProtocol));
        }
        setSelectedModel(nextModel);
        return;
      }
      setSelectedModel(nextModel);
    },
    [availableModels, selectedOpenCodeProtocol, selectedProvider],
  );

  const handleOpenCodeProtocolSelect = useCallback(
    (protocol: OpenCodeRequestProtocol) => {
      if (!selectedOpenCodeProtocols.includes(protocol)) return;
      setSelectedOpenCodeProtocol(protocol);
      setOpencodeCapabilities(getDefaultOpenCodeCapabilities(protocol));
    },
    [selectedOpenCodeProtocols],
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

  const opencodeModelLimitResult = useMemo(
    () => getOpenCodeModelLimits(opencodeContextLimit, opencodeOutputLimit),
    [opencodeContextLimit, opencodeOutputLimit],
  );
  const opencodeProviderPatchResult = useMemo(
    () => parseOpenCodeAdvancedInput(opencodeProviderPatch),
    [opencodeProviderPatch],
  );
  const opencodeModelPatchResult = useMemo(
    () => parseOpenCodeAdvancedInput(opencodeModelPatch),
    [opencodeModelPatch],
  );
  const hasOpenCodeConfigError =
    selectedProvider === "opencode" &&
    isManagedOpenCodeModel &&
    (!!opencodeModelLimitResult.error ||
      !!opencodeProviderPatchResult.error ||
      !!opencodeModelPatchResult.error ||
      !selectedOpenCodeProtocols.includes(selectedOpenCodeProtocol));
  const opencodeConfigErrorMessage =
    opencodeModelLimitResult.error === "incomplete"
      ? t("newSessionOpenCodeLimitsIncomplete")
      : opencodeModelLimitResult.error === "invalid"
        ? t("newSessionOpenCodeLimitsInvalid")
        : opencodeProviderPatchResult.error || opencodeModelPatchResult.error
          ? t("newSessionOpenCodeAdvancedInvalid")
          : !selectedOpenCodeProtocols.includes(selectedOpenCodeProtocol)
            ? t("newSessionOpenCodeProtocolUnsupported")
            : "";
  const opencodeConfigForRequest = useMemo(():
    | OpenCodeSessionConfig
    | undefined => {
    if (
      selectedProvider !== "opencode" ||
      !isManagedOpenCodeModel ||
      !selectedModel ||
      hasOpenCodeConfigError
    ) {
      return undefined;
    }
    const providerPatch = opencodeProviderPatchResult.value;
    const modelPatch = opencodeModelPatchResult.value;
    return {
      model: selectedModel,
      requestProtocol: selectedOpenCodeProtocol,
      ...(selectedModelInfo?.name && selectedModelInfo.name !== selectedModel
        ? { name: selectedModelInfo.name }
        : {}),
      ...(opencodeModelLimitResult.limits
        ? { limits: opencodeModelLimitResult.limits }
        : {}),
      capabilities: opencodeCapabilities,
      ...(providerPatch || modelPatch
        ? { advanced: { provider: providerPatch, model: modelPatch } }
        : {}),
    };
  }, [
    hasOpenCodeConfigError,
    isManagedOpenCodeModel,
    opencodeCapabilities,
    opencodeModelLimitResult.limits,
    opencodeModelPatchResult.value,
    opencodeProviderPatchResult.value,
    selectedModel,
    selectedModelInfo?.name,
    selectedOpenCodeProtocol,
    selectedProvider,
  ]);
  const selectedModelForRequest =
    selectedProvider === "opencode" && isManagedOpenCodeModel
      ? undefined
      : (selectedModel ?? undefined);

  const handleSaveDefaults = useCallback(async () => {
    setIsSavingDefaults(true);
    try {
      await updateServerSetting("newSessionDefaults", {
        provider: selectedProvider ?? undefined,
        model: selectedModelForRequest,
        thinking: supportsThinkingToggle
          ? getThinkingOption(thinkingMode, thinkingLevel)
          : undefined,
        reasoningEffort:
          selectedProvider === "codex" && thinkingMode === "on"
            ? effectiveCodexReasoningEffort
            : undefined,
        permissionMode: mode,
        codexMcpMode:
          selectedProvider === "codex" ? selectedCodexMcpMode : undefined,
        opencodeConfig: opencodeConfigForRequest,
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
    mode,
    opencodeConfigForRequest,
    selectedCodexMcpMode,
    effectiveCodexReasoningEffort,
    selectedModelForRequest,
    selectedProvider,
    showToast,
    supportsThinkingToggle,
    t,
    thinkingLevel,
    thinkingMode,
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
    if (!projectId || !hasContent || isStarting || hasOpenCodeConfigError) {
      return;
    }

    const trimmedMessage = finalMessage.trim();

    setInterimTranscript("");
    setIsStarting(true);

    try {
      let sessionId: string;
      let processId: string;
      const uploadedFiles: UploadedFile[] = [];

      // Get model and thinking settings
      const thinking = getThinkingOption(thinkingMode, thinkingLevel);
      const sessionOptions = {
        mode,
        model: selectedModelForRequest,
        thinking,
        reasoningEffort:
          selectedProvider === "codex" && thinkingMode === "on"
            ? effectiveCodexReasoningEffort
            : undefined,
        provider: selectedProvider ?? undefined,
        codexMcpMode:
          selectedProvider === "codex" ? selectedCodexMcpMode : undefined,
        opencodeConfig: opencodeConfigForRequest,
      };

      if (pendingFiles.length > 0) {
        // Two-phase flow: create session first, then upload to real session folder
        // Step 1: Create the session without sending a message
        const createResult = await api.createSession(projectId, sessionOptions);
        sessionId = createResult.sessionId;
        processId = createResult.processId;

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
        const result = await api.startSession(
          projectId,
          trimmedMessage,
          sessionOptions,
        );
        sessionId = result.sessionId;
        processId = result.processId;
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
      navigate(`${basePath}/projects/${projectId}/sessions/${sessionId}`, {
        state: {
          initialStatus: { state: "owned", processId },
          initialTitle: trimmedMessage,
          initialProvider: selectedProvider,
        },
      });
    } catch (err) {
      console.error("Failed to start session:", err);
      draftControls.restoreFromStorage();
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
  const codexMcpDefaultsMatch =
    selectedProvider === "codex"
      ? (savedDefaults?.codexMcpMode ?? "standard") === selectedCodexMcpMode
      : true;
  const thinkingDefaultsMatch = supportsThinkingToggle
    ? (savedDefaults?.thinking ?? undefined) ===
      getThinkingOption(thinkingMode, thinkingLevel)
    : true;
  const reasoningEffortDefaultsMatch =
    selectedProvider === "codex"
      ? (savedDefaults?.reasoningEffort ?? undefined) ===
        (thinkingMode === "on" ? effectiveCodexReasoningEffort : undefined)
      : true;
  const opencodeDefaultsMatch =
    selectedProvider === "opencode"
      ? sameOpenCodeConfig(
          savedDefaults?.opencodeConfig,
          opencodeConfigForRequest,
        )
      : true;
  const defaultsMatchCurrent =
    (savedDefaults?.provider ?? undefined) ===
      (selectedProvider ?? undefined) &&
    (savedDefaults?.model ?? undefined) === selectedModelForRequest &&
    (savedDefaults?.permissionMode ?? DEFAULT_PERMISSION_MODE) === mode &&
    thinkingDefaultsMatch &&
    reasoningEffortDefaultsMatch &&
    codexMcpDefaultsMatch &&
    opencodeDefaultsMatch;

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
        onClick={() => isAvailable && handleProviderSelect(p.name)}
        disabled={isStarting || !isAvailable}
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
          {commandButtons.map((button) => (
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
          disabled={isStarting || !hasContent || hasOpenCodeConfigError}
          className="send-button"
          aria-label={t("newSessionStartAction")}
        >
          {isStarting ? (
            <span className="send-spinner" />
          ) : (
            <span className="send-icon">↑</span>
          )}
        </button>
      </div>
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
      >
        {inputArea}
      </div>
    );
  }

  // Full mode: form with header, input area, and mode selector
  return (
    <div
      className={`new-session-form new-session-container ${interimTranscript ? "voice-recording" : ""}`}
    >
      <div className="new-session-header">
        <h1>{t("newSessionHeaderTitle")}</h1>
        <p className="new-session-subtitle">{t("newSessionHeaderSubtitle")}</p>
      </div>

      <CodexUsageCard />

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
        (modelOptions.length > 0 || supportsThinkingToggle) && (
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
                    multiSelect={false}
                    placeholder={t("newSessionModelPlaceholder")}
                  />
                </div>
              )}
              {showOpenCodeEndpointSelector && (
                <div className="new-session-config-field">
                  <h3>{t("newSessionOpenCodeEndpointTitle")}</h3>
                  <div className="new-session-endpoint-options">
                    <button
                      type="button"
                      className={`new-session-endpoint-option ${selectedOpenCodeProtocol === "openai-compatible" ? "selected" : ""}`}
                      onClick={() =>
                        handleOpenCodeProtocolSelect("openai-compatible")
                      }
                      disabled={
                        isStarting ||
                        !selectedOpenCodeProtocols.includes("openai-compatible")
                      }
                      aria-pressed={
                        selectedOpenCodeProtocol === "openai-compatible"
                      }
                    >
                      {t("newSessionOpenCodeEndpointOpenAI")}
                    </button>
                    <button
                      type="button"
                      className={`new-session-endpoint-option ${selectedOpenCodeProtocol === "anthropic" ? "selected" : ""}`}
                      onClick={() => handleOpenCodeProtocolSelect("anthropic")}
                      disabled={
                        isStarting ||
                        !selectedOpenCodeProtocols.includes("anthropic")
                      }
                      aria-pressed={selectedOpenCodeProtocol === "anthropic"}
                    >
                      {t("newSessionOpenCodeEndpointAnthropic")}
                    </button>
                  </div>
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
                    multiSelect={false}
                    placeholder={t("newSessionThinkingControlTitle")}
                    align="right"
                  />
                </div>
              )}
            </div>
          </div>
        )}

      {selectedProvider === "opencode" && isManagedOpenCodeModel && (
        <div className="new-session-opencode-config-section">
          <div className="new-session-opencode-config-heading">
            <div>
              <h3>{t("newSessionOpenCodeConfigTitle")}</h3>
              <p>{t("newSessionOpenCodeConfigDescription")}</p>
            </div>
            <button
              type="button"
              className="new-session-opencode-advanced-toggle"
              onClick={() => setShowOpenCodeAdvanced((value) => !value)}
              aria-expanded={showOpenCodeAdvanced}
              disabled={isStarting}
            >
              {showOpenCodeAdvanced
                ? t("newSessionOpenCodeAdvancedHide")
                : t("newSessionOpenCodeAdvancedShow")}
            </button>
          </div>

          <h4>{t("newSessionOpenCodeLimitsTitle")}</h4>
          <div className="new-session-opencode-limits-grid">
            <label className="new-session-limit-field">
              <span>{t("newSessionOpenCodeContextLimit")}</span>
              <div className="new-session-limit-input-wrap">
                <input
                  type="text"
                  inputMode="decimal"
                  className="new-session-limit-input"
                  value={opencodeContextLimit}
                  onChange={(event) =>
                    setOpencodeContextLimit(event.target.value)
                  }
                  placeholder={t("newSessionOpenCodeContextPlaceholder")}
                  disabled={isStarting}
                />
                <span className="new-session-limit-unit">K</span>
              </div>
            </label>
            <label className="new-session-limit-field">
              <span>{t("newSessionOpenCodeOutputLimit")}</span>
              <div className="new-session-limit-input-wrap">
                <input
                  type="text"
                  inputMode="decimal"
                  className="new-session-limit-input"
                  value={opencodeOutputLimit}
                  onChange={(event) =>
                    setOpencodeOutputLimit(event.target.value)
                  }
                  placeholder={t("newSessionOpenCodeOutputPlaceholder")}
                  disabled={isStarting}
                />
                <span className="new-session-limit-unit">K</span>
              </div>
            </label>
          </div>

          <h4>{t("newSessionOpenCodeCapabilitiesTitle")}</h4>
          <div className="new-session-opencode-capabilities">
            {(
              [
                ["reasoning", "newSessionOpenCodeCapabilityReasoning"],
                ["toolCall", "newSessionOpenCodeCapabilityTools"],
                ["temperature", "newSessionOpenCodeCapabilityTemperature"],
                ["attachment", "newSessionOpenCodeCapabilityAttachments"],
              ] as const
            ).map(([capability, label]) => (
              <label
                className="new-session-opencode-capability"
                key={capability}
              >
                <input
                  type="checkbox"
                  checked={Boolean(opencodeCapabilities[capability])}
                  onChange={(event) =>
                    setOpencodeCapabilities((current) => ({
                      ...current,
                      [capability]: event.target.checked,
                    }))
                  }
                  disabled={isStarting}
                />
                <span>{t(label)}</span>
              </label>
            ))}
          </div>

          {showOpenCodeAdvanced && (
            <div className="new-session-opencode-advanced">
              <p>{t("newSessionOpenCodeAdvancedDescription")}</p>
              <label className="new-session-opencode-json-field">
                <span>{t("newSessionOpenCodeProviderPatch")}</span>
                <textarea
                  value={opencodeProviderPatch}
                  onChange={(event) =>
                    setOpencodeProviderPatch(event.target.value)
                  }
                  placeholder={'{"options":{"headers":{"X-Trace":"yep"}}}'}
                  spellCheck={false}
                  disabled={isStarting}
                />
              </label>
              <label className="new-session-opencode-json-field">
                <span>{t("newSessionOpenCodeModelPatch")}</span>
                <textarea
                  value={opencodeModelPatch}
                  onChange={(event) =>
                    setOpencodeModelPatch(event.target.value)
                  }
                  placeholder={'{"options":{"thinking":{"type":"disabled"}}}'}
                  spellCheck={false}
                  disabled={isStarting}
                />
              </label>
            </div>
          )}

          {opencodeConfigErrorMessage && (
            <p className="new-session-limit-error">
              {opencodeConfigErrorMessage}
            </p>
          )}
        </div>
      )}

      {/* Codex MCP Profile - matches cf / cf -mcp launch modes */}
      {selectedProvider === "codex" && (
        <div className="new-session-codex-mcp-section">
          <h3>{t("newSessionCodexMcpTitle")}</h3>
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
      {supportsPermissionMode && (
        <div className="new-session-mode-section">
          <h3>{t("newSessionModeTitle")}</h3>
          <div className="mode-options">
            {MODE_ORDER.map((m) => (
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
                hasOpenCodeConfigError ||
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
