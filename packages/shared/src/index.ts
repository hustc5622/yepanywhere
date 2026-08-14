export {
  isIdeMetadata,
  stripIdeMetadata,
  stripBridgeMetadata,
  extractOpenedFilePath,
  parseOpenedFiles,
  getFilename,
} from "./ideMetadata.js";

export {
  FeishuAccountConfigSchema,
  FeishuAccountsFileSchema,
  FeishuBindingsFileSchema,
  FeishuConnectionStateSchema,
  FeishuDomainSchema,
  FeishuGroupSessionModeSchema,
  FeishuPermissionModeSchema,
  FeishuReplyModeSchema,
  FeishuSecretRefSchema,
  FeishuSessionBindingSchema,
} from "./feishu-channel.js";
export type {
  FeishuAccountConfig,
  FeishuAccountMetrics,
  FeishuAccountPublicView,
  FeishuAccountStatus,
  FeishuAccountsFile,
  FeishuBindingsFile,
  FeishuConnectionState,
  FeishuDomain,
  FeishuGroupSessionMode,
  FeishuPermissionMode,
  FeishuReplyMode,
  FeishuSecretRef,
  FeishuSecretSource,
  FeishuSecretStatus,
  FeishuSessionBinding,
} from "./feishu-channel.js";

export {
  CODEX_THREAD_ITEM_RENDER_POLICY,
  CODEX_THREAD_ITEM_TYPES,
  NATIVE_RENDER_ITEM_TYPES,
  isNativeRenderItemType,
} from "./render-items.js";
export type {
  GeneratedArtifactBlockReason,
  GeneratedArtifactKind,
  GeneratedArtifactManifest,
  GeneratedArtifactRetention,
  GeneratedArtifactSource,
  GeneratedArtifactSourceType,
  GeneratedArtifactWarning,
} from "./generated-artifact.js";
export { isGeneratedArtifactDownloadUrl } from "./generated-artifact.js";
export type {
  CodexThreadItemRenderPolicy,
  CodexThreadItemType,
  CodexRetryStatus,
  CommandRenderItem,
  CompactionRenderItem,
  DynamicToolContentItem,
  DynamicToolRenderItem,
  FileChangeRenderEntry,
  FileChangeRenderItem,
  HookRenderItem,
  ImageRenderItem,
  InteractionActorPolicy,
  InteractionOperation,
  InteractionOperationKind,
  InteractionOperationState,
  InteractionRenderItem,
  LegacyRenderItem,
  McpToolRenderItem,
  NativeDecisionDescriptor,
  NativeRenderItem,
  NativeRenderItemType,
  PlanRenderItem,
  PlanStep,
  ReasoningRenderItem,
  RenderItem,
  RenderItemBase,
  RenderItemLifecycleStatus,
  RenderItemRedaction,
  ReviewRenderItem,
  SafeInteractionPayload,
  SafeInteractionQuestion,
  SessionSetupItem,
  SleepRenderItem,
  SubAgentRenderItem,
  SystemItem,
  TextItem,
  ThinkingItem,
  ToolCallItem,
  ToolResultData,
  UnknownRenderItem,
  UserPromptItem,
  WarningRenderItem,
  WebSearchRenderItem,
} from "./render-items.js";

// File path detection (shared between server and client)
export type { DetectedFilePath, TextSegment } from "./filePathDetection.js";
export {
  isLikelyFilePath,
  parseLineColumn,
  detectFilePaths,
  splitTextWithFilePaths,
  transformFilePathsToHtml,
} from "./filePathDetection.js";

export type {
  ProviderName,
  ProviderInfo,
  CodexModelSourceInfo,
  RemoteExecutorConfig,
  RemoteSessionStorageConfig,
  RemoteSessionStorageMode,
  ReasoningEffortInfo,
  ModelInfo,
  OpenCodeRequestProtocol,
  OpenCodeModelLimits,
  OpenCodeJsonValue,
  OpenCodeJsonObject,
  OpenCodeModelCapabilities,
  OpenCodeSessionConfig,
  SlashCommand,
  PermissionMode,
  CodexMcpMode,
  NewSessionDefaults,
  NewSessionProviderDefaults,
  ModelOption,
  ThinkingMode,
  ThinkingOption,
  ThinkingConfig,
  EffortLevel,
  FileMetadata,
  FileContentResponse,
  ReportDocument,
  ReportDocumentKind,
  ReportComment,
  ReportCommentAnchor,
  ReportCommentMutationResponse,
  ReportsListResponse,
  ReportDocumentResponse,
  ReportImageUploadResponse,
  ReportUploadResponse,
  PatchHunk,
  EditAugment,
  MarkdownAugment,
  PermissionRules,
  UserQuestionAnswer,
  UserQuestionAnswers,
  ProviderMcpServerStatus,
  ProviderGoalAction,
  ProviderGoalState,
  ZCodeBridgeExternalSession,
  ZCodeBridgePendingInput,
  ZCodeBridgeDecision,
} from "./types.js";
export {
  ALL_PROVIDERS,
  DEFAULT_PERMISSION_MODE,
  ALL_PERMISSION_MODES,
  ALL_CODEX_MCP_MODES,
  ALL_OPENCODE_REQUEST_PROTOCOLS,
  getNewSessionProviderDefaults,
  mergeNewSessionDefaults,
  normalizeNewSessionDefaults,
  thinkingOptionToConfig,
  resolveModel,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
} from "./types.js";

export type { SessionKind } from "./session-kind.js";
export {
  COMMAND_MESSAGE_SESSION_TITLE,
  SLASH_COMMAND_SESSION_KIND,
  isSessionKind,
  isSlashCommandSession,
  isSlashCommandSessionTitle,
  sessionMatchesKind,
} from "./session-kind.js";

export type {
  GitStatusInfo,
  GitFileChange,
  ProjectGitStatusSummary,
} from "./git-status.js";

export {
  orderByParentChain,
  needsReorder,
  type DagOrderable,
} from "./dag.js";

export {
  type UrlProjectId,
  type DirProjectId,
  isUrlProjectId,
  isDirProjectId,
  toUrlProjectId,
  fromUrlProjectId,
  assertUrlProjectId,
  asDirProjectId,
} from "./projectId.js";

export type {
  UploadedFile,
  UploadStartMessage,
  UploadEndMessage,
  UploadCancelMessage,
  UploadProgressMessage,
  UploadCompleteMessage,
  UploadErrorMessage,
  UploadClientMessage,
  UploadServerMessage,
} from "./upload.js";
export { isManagedUploadDownloadUrl } from "./upload.js";

// SDK schema types (type-only, no Zod runtime)
export type {
  // Entry types (JSONL line types)
  AssistantEntry,
  UserEntry,
  SystemEntry,
  SummaryEntry,
  FileHistorySnapshotEntry,
  QueueOperationEntry,
  SessionEntry,
  SidechainEntry,
  ClaudeSessionEntry,
  ClaudeSidechainEntry,
  BaseEntry,
  // Message types
  AssistantMessage,
  AssistantMessageContent,
  UserMessage,
  UserMessageContent,
  // Content block types
  TextContent,
  ThinkingContent,
  ToolUseContent,
  ToolResultContent,
  ImageContent,
  DocumentContent,
  // Tool types
  StructuredPatch,
  ToolUseResult,
} from "./claude-sdk-schema/types.js";

// SDK schema guards (type guards for session entries)
export {
  isCompactBoundary,
  getLogicalParentUuid,
  isConversationEntry,
  getMessageContent,
} from "./claude-sdk-schema/guards.js";

// App-specific types (extend SDK types with runtime fields)
export type {
  // Content block
  AppContentBlock,
  // Message extensions
  AppMessageExtensions,
  CodexPersistedInteraction,
  AppUserMessage,
  AppAssistantMessage,
  AppSystemMessage,
  AppSummaryMessage,
  AppMessage,
  AppConversationMessage,
  // Session types
  PendingInputType,
  AgentActivity,
  SessionArchiveBlockCode,
  SessionRuntime,
  ContextUsage,
  SessionQuestion,
  SessionCreatedBy,
  SessionOriginChannel,
  SessionOwnership,
  SessionSandboxPolicy,
  OpenCodeModelDefaultLimits,
  SessionBranchOption,
  SessionBranchState,
  SessionBranchMetadata,
  CodexBranchOption,
  CodexBranchState,
  SessionLastTurnStatus,
  SessionRetryStatus,
  AppSessionSummary,
  AppSession,
  // Agent session types
  AgentStatus,
  AgentSession,
  AgentMapping,
  SubagentStatus,
  SubagentUsage,
  SubagentMetrics,
  SubagentDescriptor,
  // Input request types
  InputRequest,
  // Recents types
  EnrichedRecentEntry,
  // Connected browser types
  ConnectionInfo,
  ConnectionsResponse,
  // Browser profile types
  BrowserProfileOrigin,
  BrowserProfileInfo,
  BrowserProfilesResponse,
} from "./app-types.js";
export {
  isUserMessage,
  isAssistantMessage,
  isSystemMessage,
  isSummaryMessage,
  isConversationMessage,
  // Context window utilities
  DEFAULT_CONTEXT_WINDOW,
  CODEX_DEFAULT_CONTEXT_WINDOW,
  escalateContextWindow,
  getModelContextWindow,
  getOpenCodeModelDefaultLimits,
  resolveModelDisplayLabel,
  resolveClaudeModelLabel,
} from "./app-types.js";

// Session utilities
export {
  SessionView,
  getSessionDisplayTitle,
  SESSION_TITLE_MAX_LENGTH,
} from "./session/index.js";

export type {
  UnifiedSession,
  ClaudeSessionFile,
  CodexSessionContent,
  SessionLocation,
  SessionLocationSource,
  SessionLocateResponse,
} from "./session/index.js";

// Context status (full SDK breakdown + fallback estimate)
export type {
  ContextStatusResponse,
  ContextStatusSdkPayload,
  ContextStatusEstimatePayload,
  ContextCategoryEntry,
  ContextCumulativeUsage,
  ContextCompactEvent,
  ContextMcpToolEntry,
  ContextMemoryFileEntry,
  ContextSkillFrontmatterEntry,
  ContextSkillsSummary,
  ContextSlashCommandsSummary,
  ContextAgentEntry,
  ContextSystemPromptSection,
  ContextSystemTool,
  ContextDeferredBuiltinTool,
} from "./context-status.js";

// Tool result schemas (for runtime validation)
export {
  TaskResultSchema,
  BashResultSchema,
  ReadResultSchema,
  EditResultSchema,
  WriteResultSchema,
  GlobResultSchema,
  GrepResultSchema,
  TodoWriteResultSchema,
  WebSearchResultSchema,
  WebFetchResultSchema,
  AskUserQuestionResultSchema,
  BashOutputResultSchema,
  TaskOutputResultSchema,
  KillShellResultSchema,
} from "./claude-sdk-schema/tool/ToolResultSchemas.js";

// Codex session file types (for reading ~/.codex/sessions/)
// Note: Streaming events are handled by @openai/codex-sdk directly
export type {
  // Content types
  CodexTextContent,
  CodexToolUseContent,
  CodexToolResultContent,
  CodexReasoningContent,
  CodexContentBlock,
  CodexMessageContent,
  // Session file entry types
  CodexSessionMetaPayload,
  CodexSessionMetaEntry,
  CodexMessagePhase,
  CodexMessagePayload,
  CodexReasoningPayload,
  CodexFunctionCallPayload,
  CodexFunctionCallOutputPayload,
  CodexCustomToolCallPayload,
  CodexCustomToolCallOutputPayload,
  CodexWebSearchCallPayload,
  CodexImageGenerationPayload,
  CodexGhostSnapshotPayload,
  CodexResponseItemPayload,
  CodexResponseItemEntry,
  CodexEventMsgPayload,
  CodexFileChange,
  CodexPatchApplyStatus,
  CodexPatchApplyBeginEvent,
  CodexPatchApplyUpdatedEvent,
  CodexPatchApplyEndEvent,
  CodexTurnAbortedEvent,
  CodexThreadRolledBackEvent,
  CodexEventMsgEntry,
  CodexCompactedPayload,
  CodexCompactedEntry,
  CodexTurnContextPayload,
  CodexTurnContextEntry,
  CodexSessionEntry,
} from "./codex-schema/types.js";
export { parseCodexSessionEntry } from "./codex-schema/session.js";

// Gemini SDK schema types
export type {
  GeminiStats,
  GeminiInitEvent,
  GeminiMessageEvent,
  GeminiToolUseEvent,
  GeminiToolResultEvent,
  GeminiResultEvent,
  GeminiErrorEvent,
  GeminiEvent,
} from "./gemini-schema/types.js";
export { parseGeminiEvent } from "./gemini-schema/events.js";

// Gemini session file types (for reading ~/.gemini/tmp/<hash>/chats/)
export type {
  GeminiFunctionResponse,
  GeminiToolCallResult,
  GeminiToolCall,
  GeminiThought,
  GeminiTokens,
  GeminiUserMessage,
  GeminiAssistantMessage,
  GeminiSessionMessage,
  GeminiSessionFile,
} from "./gemini-schema/session.js";
export {
  getGeminiUserMessageText,
  parseGeminiSessionFile,
} from "./gemini-schema/session.js";

// OpenCode SDK schema types (for opencode serve SSE events and session storage)
export type {
  // SSE event types
  OpenCodeSessionStatus,
  OpenCodeTokens,
  OpenCodeTime,
  OpenCodePart,
  OpenCodeMessageInfo,
  OpenCodeSessionInfo,
  OpenCodeServerConnectedEvent,
  OpenCodeSessionCreatedEvent,
  OpenCodeSessionStatusEvent,
  OpenCodeSessionUpdatedEvent,
  OpenCodeSessionIdleEvent,
  OpenCodeSessionDiffEvent,
  OpenCodeMessageUpdatedEvent,
  OpenCodeMessagePartUpdatedEvent,
  OpenCodeMessagePartDeltaEvent,
  OpenCodeSSEEvent,
  // Session storage types
  OpenCodeProject,
  OpenCodeSession,
  OpenCodeMessage,
  OpenCodeStoredPart,
  OpenCodeSessionEntry,
  OpenCodeSessionContent,
} from "./opencode-schema/types.js";
export { parseOpenCodeSSEEvent } from "./opencode-schema/events.js";

// Kimi Code CLI session schema (for reading ~/.kimi-code/sessions wire.jsonl)
export type {
  KimiContentPartValue,
  KimiLoopEvent,
  KimiContentPartEvent,
  KimiToolCallEvent,
  KimiToolResultEvent,
  KimiStepEndEvent,
  KimiStepUsage,
  KimiTurnEndedRecord,
  KimiWireRecord,
  KimiSessionContent,
  KimiSessionState,
  KimiImagePart,
  KimiBlobRef,
  KimiPromptImage,
  KimiSubagentStatus,
  KimiSubagentUsage,
  KimiSubagentMetrics,
  KimiGoalBudgetLimits,
  KimiGoalSnapshot,
} from "./kimi-schema/types.js";
export {
  parseKimiWireJsonl,
  parseKimiSessionState,
  getKimiPromptText,
  getKimiPromptImages,
  parseKimiBlobRef,
  isKimiTurnPromptRecord,
  isKimiLoopEventRecord,
  isKimiTurnEndedRecord,
  isKimiModelConfigRecord,
  isKimiProfileConfigRecord,
  isKimiProfileBindRecord,
  isKimiGoalCreateRecord,
  isKimiGoalUpdateRecord,
  isKimiGoalClearRecord,
  isKimiForkedRecord,
  isKimiSwarmEnterRecord,
  isKimiSwarmExitRecord,
  isKimiTaskStartedRecord,
  isKimiTaskTerminatedRecord,
  isKimiInteractionRequestRecord,
  isKimiInteractionResolvedRecord,
  isKimiTurnCancelRecord,
  isKimiFullCompactionBeginRecord,
  isKimiContextApplyCompactionRecord,
  isKimiToolsUpdateStoreRecord,
  getKimiSubagentType,
  getKimiGoalTimeline,
  deriveKimiSubagentMetrics,
  inferKimiSubagentStatus,
} from "./kimi-schema/types.js";

// ZCode app-server protocol schema (compatibility contract for stdio JSON-RPC)
export type {
  ZCodeJsonRpcId,
  ZCodeJsonRpcError,
  ZCodeJsonRpcRequest,
  ZCodeJsonRpcResponse,
  ZCodeJsonRpcNotification,
  ZCodeJsonRpcServerRequest,
  ZCodeMethod,
  ZCodeEventName,
  ZCodeDeliveryKind,
  ZCodeMode,
  ZCodeStreamingKind,
  ZCodeErrorCode,
  ZCodeWorkspaceState,
  ZCodeRegistryModel,
  ZCodeProviderRegistryEntry,
  ZCodeRegistry,
  ZCodeWorkspaceIdentity,
  ZCodeRuntimeModel,
  ZCodeModelRef,
  ZCodeSessionListItem,
  ZCodeSessionListResult,
  ZCodeSession,
  ZCodeSessionSnapshot,
  ZCodeForkTarget,
  ZCodeSessionForkResult,
  ZCodeMcpServerStatus,
  ZCodeMcpListResult,
  ZCodeGoalAction,
  ZCodeSessionGoalResult,
  ZCodeEventEnvelope,
} from "./zcode-schema/protocol.js";
export {
  ZCodeJsonRpcIdSchema,
  ZCodeJsonRpcErrorSchema,
  ZCodeJsonRpcRequestSchema,
  ZCodeJsonRpcResponseSchema,
  ZCodeJsonRpcNotificationSchema,
  ZCodeJsonRpcServerRequestSchema,
  ZCodeMethodSchema,
  ZCodeEventNameSchema,
  ZCodeDeliveryKindSchema,
  ZCODE_PREFERRED_DELIVERY_KIND,
  ZCodeModeSchema,
  ZCODE_SELECTABLE_MODES,
  YEP_TO_ZCODE_MODE_MAP,
  ZCodeStreamingKindSchema,
  ZCodeErrorCodeSchema,
  ZCodeWorkspaceIdentitySchema,
  ZCodeRuntimeModelSchema,
  ZCodeModelRefSchema,
  ZCodeWorkspaceReadStateParamsSchema,
  ZCodeWorkspaceStateSchema,
  ZCodeRegistryModelSchema,
  ZCodeProviderRegistryEntrySchema,
  ZCodeRegistrySchema,
  ZCodeUpdateProviderRegistryParamsSchema,
  ZCodeSessionListParamsSchema,
  ZCodeSessionListItemSchema,
  ZCodeSessionListResultSchema,
  ZCodeSessionCreateParamsSchema,
  ZCodeSessionResumeParamsSchema,
  ZCodeSessionSendParamsSchema,
  ZCodeSessionSetModelParamsSchema,
  ZCodeSessionSetModeParamsSchema,
  ZCodeSessionSetThoughtLevelParamsSchema,
  ZCodeSessionStopParamsSchema,
  ZCodeSessionCompactParamsSchema,
  ZCodeSessionSubscribeParamsSchema,
  ZCodeSessionSchema,
  ZCodeSessionSnapshotSchema,
  ZCodeSessionMessagesParamsSchema,
  ZCodeForkTargetSchema,
  ZCodeSessionForkParamsSchema,
  ZCodeSessionForkResultSchema,
  ZCodeSessionCloseParamsSchema,
  ZCodeMcpListParamsSchema,
  ZCodeMcpServerStatusSchema,
  ZCodeMcpListResultSchema,
  ZCodeGoalActionSchema,
  ZCodeSessionGoalParamsSchema,
  ZCodeSessionGoalResultSchema,
  ZCodeEventEnvelopeSchema,
  ZCODE_COMPATIBILITY_BASELINE,
  parseZCodeVersion,
  isZCodeVersionGte,
} from "./zcode-schema/protocol.js";
export type {
  ZCodeSessionContent,
  ZCodeStoredMessage,
  ZCodeStoredPart,
} from "./zcode-schema/session.js";

// Device bridge streaming types (for device bridge remote control)
export type {
  DeviceAction,
  DeviceInfo,
  DeviceState,
  DeviceType,
  DeviceStreamStart,
  DeviceStreamStop,
  DeviceWebRTCAnswer,
  DeviceICECandidate,
  DeviceClientMessage,
  DeviceWebRTCOffer,
  DeviceICECandidateEvent,
  DeviceSessionState,
  DeviceStreamProfileEvent,
  DeviceServerMessage,
  RTCIceCandidateInit,
} from "./devices.js";

// Remote terminal types (for remote shell sessions)
export type {
  TerminalOpen,
  TerminalInput,
  TerminalResize,
  TerminalClose,
  TerminalClientMessage,
  TerminalOpened,
  TerminalOutput,
  TerminalExit,
  TerminalError,
  TerminalServerMessage,
} from "./terminal.js";

// Wire protocol types (for the local WebSocket connection)
export type {
  WireHttpMethod,
  WireRequest,
  WireResponse,
  WireSubscriptionChannel,
  WireSubscribe,
  WireUnsubscribe,
  WireEvent,
  WireUploadStart,
  WireUploadChunk,
  WireUploadEnd,
  WireUploadProgress,
  WireUploadComplete,
  WireUploadError,
  RemoteClientMessage,
  YepMessage,
  WireMessage,
  // Connection metadata types
  OriginMetadata,
  // Client capabilities (Phase 3)
  ClientCapabilities,
  // Keepalive ping/pong
  ClientPing,
  ServerPong,
} from "./wire-protocol.js";

export {
  // Client capabilities type guard
  isClientCapabilities,
} from "./wire-protocol.js";

// Binary framing utilities (Phase 0/1/2/3 of binary WebSocket protocol)
export {
  // Phase 0: Unencrypted binary frames
  BinaryFormat,
  type BinaryFormatValue,
  BinaryFrameError,
  encodeJsonFrame,
  decodeBinaryFrame,
  decodeJsonFrame,
  isBinaryData,
  // Phase 1: Binary encrypted envelope
  BinaryEnvelopeVersion,
  type BinaryEnvelopeVersionValue,
  BinaryEnvelopeError,
  type BinaryEnvelopeComponents,
  NONCE_LENGTH,
  VERSION_LENGTH,
  MIN_BINARY_ENVELOPE_LENGTH,
  parseBinaryEnvelope,
  createBinaryEnvelope,
  prependFormatByte,
  extractFormatAndPayload,
  // Phase 2: Binary upload chunks
  UUID_BYTE_LENGTH,
  OFFSET_BYTE_LENGTH,
  UPLOAD_CHUNK_HEADER_SIZE,
  UploadChunkError,
  type UploadChunkData,
  uuidToBytes,
  bytesToUuid,
  offsetToBytes,
  bytesToOffset,
  encodeUploadChunkFrame,
  decodeUploadChunkFrame,
  encodeUploadChunkPayload,
  decodeUploadChunkPayload,
  // Phase 3: Compressed JSON
  encodeCompressedJsonFrame,
  decodeCompressedJsonFrame,
} from "./binary-framing.js";

// Compression utilities (Phase 3)
export {
  COMPRESSION_THRESHOLD,
  isCompressionSupported,
  shouldCompress,
  isGzipCompressed,
  compressString,
  compressBytes,
  decompressToString,
  decompressBytes,
  compressJsonIfBeneficial,
} from "./compression.js";
