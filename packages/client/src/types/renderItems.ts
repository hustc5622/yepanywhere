import type {
  CommandRenderItem as SharedCommandRenderItem,
  CompactionRenderItem as SharedCompactionRenderItem,
  DynamicToolRenderItem as SharedDynamicToolRenderItem,
  FileChangeRenderItem as SharedFileChangeRenderItem,
  HookRenderItem as SharedHookRenderItem,
  ImageRenderItem as SharedImageRenderItem,
  InteractionRenderItem as SharedInteractionRenderItem,
  McpToolRenderItem as SharedMcpToolRenderItem,
  NativeRenderItem as SharedNativeRenderItem,
  PlanRenderItem as SharedPlanRenderItem,
  ReasoningRenderItem as SharedReasoningRenderItem,
  ReviewRenderItem as SharedReviewRenderItem,
  SessionSetupItem as SharedSessionSetupItem,
  SleepRenderItem as SharedSleepRenderItem,
  SubAgentRenderItem as SharedSubAgentRenderItem,
  SystemItem as SharedSystemItem,
  TextItem as SharedTextItem,
  ThinkingItem as SharedThinkingItem,
  ToolCallItem as SharedToolCallItem,
  UnknownRenderItem as SharedUnknownRenderItem,
  UserPromptItem as SharedUserPromptItem,
  WarningRenderItem as SharedWarningRenderItem,
  WebSearchRenderItem as SharedWebSearchRenderItem,
  ToolResultData,
} from "@yep-anywhere/shared";
import type { ContentBlock, Message } from "../types";

/** Client specialization of the shared provider-neutral render model. */
export type NativeRenderItem = SharedNativeRenderItem<Message>;
export type TextItem = SharedTextItem<Message>;
export type ThinkingItem = SharedThinkingItem<Message>;
export type ToolCallItem = SharedToolCallItem<Message>;
export type UserPromptItem = Omit<SharedUserPromptItem<Message>, "content"> & {
  content: string | ContentBlock[];
};
export type SessionSetupItem = Omit<
  SharedSessionSetupItem<Message>,
  "prompts"
> & {
  prompts: Array<string | ContentBlock[]>;
};
export type SystemItem = SharedSystemItem<Message>;
export type PlanRenderItem = SharedPlanRenderItem<Message>;
export type ReasoningRenderItem = SharedReasoningRenderItem<Message>;
export type CommandRenderItem = SharedCommandRenderItem<Message>;
export type FileChangeRenderItem = SharedFileChangeRenderItem<Message>;
export type McpToolRenderItem = SharedMcpToolRenderItem<Message>;
export type DynamicToolRenderItem = SharedDynamicToolRenderItem<Message>;
export type WebSearchRenderItem = SharedWebSearchRenderItem<Message>;
export type ImageRenderItem = SharedImageRenderItem<Message>;
export type HookRenderItem = SharedHookRenderItem<Message>;
export type ReviewRenderItem = SharedReviewRenderItem<Message>;
export type SleepRenderItem = SharedSleepRenderItem<Message>;
export type SubAgentRenderItem = SharedSubAgentRenderItem<Message>;
export type CompactionRenderItem = SharedCompactionRenderItem<Message>;
export type InteractionRenderItem = SharedInteractionRenderItem<Message>;
export type WarningRenderItem = SharedWarningRenderItem<Message>;
export type UnknownRenderItem = SharedUnknownRenderItem<Message>;
export type RenderItem =
  | TextItem
  | ThinkingItem
  | ToolCallItem
  | UserPromptItem
  | SessionSetupItem
  | SystemItem
  | NativeRenderItem;
export type { ToolResultData };
