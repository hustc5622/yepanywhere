import type {
  ApiMessageItem,
  ResourceDescriptor,
} from "@larksuiteoapi/node-sdk";
import type { FeishuBotIdentity } from "../transport.js";

export interface FeishuMessageApi {
  fetchMessageItems(messageId: string): Promise<ApiMessageItem[]>;
  /**
   * Resolve the official `thread_id` field for a message. A message/root ID is
   * not itself a valid `thread` container ID.
   */
  resolveThreadId?(messageId: string): Promise<string | undefined>;
  fetchThreadMessageItems?(
    threadId: string,
    maxItems: number,
  ): Promise<{ items: ApiMessageItem[]; hasMore: boolean }>;
  /** Rebuild a receive-event shape without persisting the original body. */
  fetchMessageEvent?(messageId: string): Promise<unknown>;
  getChatMode?(chatId: string): Promise<"p2p" | "group" | "topic">;
  resolveUserNames?(openIds: string[]): Promise<ReadonlyMap<string, string>>;
  downloadMessageResource?(
    messageId: string,
    fileKey: string,
    type: "image" | "file",
  ): Promise<AsyncIterable<Uint8Array>>;
}

export interface FeishuResourceDescriptor extends ResourceDescriptor {
  /** Message that owns this resource; required for forwarded-message media. */
  messageId?: string;
}

export interface FeishuNormalizeInput {
  event: unknown;
  /** Account that received the event. Direct normalizer tests may omit it. */
  accountId?: string;
  botIdentity: FeishuBotIdentity;
  api?: FeishuMessageApi;
}

export type FeishuBodyNode =
  | { kind: "text"; text: string }
  | { kind: "resource"; resource: FeishuResourceDescriptor }
  | { kind: "unsupported"; messageType: string };

export type FeishuContextMode =
  | "current"
  | "current+quoted"
  | "topic"
  | "merge-forward";

export interface FeishuContextManifest {
  /** Context the relation/policy requested. */
  mode: FeishuContextMode;
  /** Context actually present in this dispatch payload. */
  effectiveMode: FeishuContextMode;
  messageCount: number;
  timeRange?: { fromMs: number; toMs: number };
  truncatedItems: number;
  failedItems: number;
  attachmentCount: number;
  operator: { id: string; name?: string };
  complete: boolean;
  warnings: string[];
}

export interface FeishuAttachmentExtractionArtifact {
  kind: string;
  pathRef: string;
  mime: string;
  sizeBytes: number;
}

export interface FeishuAttachmentManifest {
  attachmentId: string;
  source: {
    platform: "feishu";
    messageId: string;
    resourceKey?: string;
    resourceType?: string;
  };
  originalName?: string;
  sanitizedName: string;
  declaredMime?: string;
  detectedMime?: string;
  kind:
    | "image"
    | "audio"
    | "video"
    | "pdf"
    | "word"
    | "excel"
    | "ppt"
    | "text"
    | "archive"
    | "binary"
    | "unknown";
  sizeBytes: number;
  sha256: string;
  /** Opaque server-side reference. Never expose the absolute upload path. */
  localPathRef: string;
  status: "downloaded" | "scanned" | "extracted" | "rejected" | "failed";
  extraction?: {
    extractor: string;
    version: string;
    artifacts: FeishuAttachmentExtractionArtifact[];
    warnings: string[];
    truncated: boolean;
  };
}

export interface CanonicalFeishuMessage {
  accountId: string;
  eventId: string;
  eventType: string;
  chatId: string;
  chatType: "p2p" | "group" | "unknown";
  messageId: string;
  rootId?: string;
  parentId?: string;
  threadId?: string;
  sender: { id?: string; idType?: string; name?: string };
  createdAtMs?: number;
  updatedAtMs?: number;
  messageType: string;
  body: FeishuBodyNode[];
  attachments: FeishuAttachmentManifest[];
  relation: {
    quotedMessageId?: string;
    mergeForwardParentId?: string;
    topicRootId?: string;
  };
  context: FeishuContextManifest;
  normalization: {
    warnings: string[];
    truncated: boolean;
    omittedItems: number;
    omittedResources: number;
    rawRef?: string;
  };
}

export interface FeishuForwardEntry {
  messageId: string;
  parentMessageId: string;
  depth: number;
  messageType: string;
  senderId?: string;
  senderName: string;
  createTime?: number;
  content: string;
  resources: FeishuResourceDescriptor[];
}

export interface FeishuForwardedContent {
  totalItems: number;
  readItems: number;
  truncated: boolean;
  entries: FeishuForwardEntry[];
}

export interface FeishuQuotedContent {
  messageId: string;
  senderId?: string;
  senderName: string;
  messageType: string;
  createTime?: number;
  content: string;
  resources: FeishuResourceDescriptor[];
}

export interface FeishuNormalizedInboundMessage extends CanonicalFeishuMessage {
  tenantKey?: string;
  /** Legacy flat fields retained while downstream consumers migrate. */
  senderId: string;
  senderName?: string;
  content: string;
  resources: FeishuResourceDescriptor[];
  mentionsBot: boolean;
  replyToMessageId?: string;
  createTime?: number;
  quoted?: FeishuQuotedContent;
  forwarded?: FeishuForwardedContent;
  truncated: boolean;
}

export interface FeishuMessageNormalizerOptions {
  maxItems?: number;
  maxDepth?: number;
  maxContentChars?: number;
  maxResources?: number;
}

export class FeishuNormalizationError extends Error {
  readonly code: "INVALID_EVENT" | "NORMALIZATION_FAILED";

  constructor(code: FeishuNormalizationError["code"]) {
    super(code);
    this.name = "FeishuNormalizationError";
    this.code = code;
  }
}
