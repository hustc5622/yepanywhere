export const FEISHU_STREAM_STATUS_ELEMENT_ID = "yep_stream_status";
export const FEISHU_STREAM_PROGRESS_ELEMENT_ID = "yep_stream_progress";
export const FEISHU_STREAM_TOOLS_ELEMENT_ID = "yep_stream_tools";
export const FEISHU_STREAM_ARTIFACTS_ELEMENT_ID = "yep_stream_artifacts";
export const FEISHU_STREAM_ANSWER_ELEMENT_ID = "yep_stream_answer";
export const FEISHU_STREAM_PROGRESS_ELEMENT_IDS = [
  "yep_stream_prog_01",
  "yep_stream_prog_02",
  "yep_stream_prog_03",
  "yep_stream_prog_04",
  "yep_stream_prog_05",
  "yep_stream_prog_06",
  "yep_stream_prog_07",
  "yep_stream_prog_08",
  "yep_stream_prog_09",
  "yep_stream_prog_10",
  "yep_stream_prog_11",
  "yep_stream_prog_12",
  "yep_stream_prog_13",
  "yep_stream_prog_14",
  "yep_stream_prog_15",
  "yep_stream_prog_16",
] as const;
export const FEISHU_STREAM_ACTIVITY_ELEMENT_IDS = [
  "yep_stream_act_01",
  "yep_stream_act_02",
  "yep_stream_act_03",
  "yep_stream_act_04",
  "yep_stream_act_05",
  "yep_stream_act_06",
  "yep_stream_act_07",
  "yep_stream_act_08",
  "yep_stream_act_09",
  "yep_stream_act_10",
  "yep_stream_act_11",
  "yep_stream_act_12",
  "yep_stream_act_13",
  "yep_stream_act_14",
  "yep_stream_act_15",
  "yep_stream_act_16",
] as const;
export type FeishuStreamingActivityElementId =
  (typeof FEISHU_STREAM_ACTIVITY_ELEMENT_IDS)[number];
export type FeishuStreamingProgressElementId =
  (typeof FEISHU_STREAM_PROGRESS_ELEMENT_IDS)[number];
/** Legacy/default content target retained for older custom transports. */
export const FEISHU_STREAM_ELEMENT_ID = FEISHU_STREAM_ANSWER_ELEMENT_ID;

export type FeishuStreamingSectionElementId =
  | typeof FEISHU_STREAM_STATUS_ELEMENT_ID
  | typeof FEISHU_STREAM_PROGRESS_ELEMENT_ID
  | typeof FEISHU_STREAM_TOOLS_ELEMENT_ID
  | typeof FEISHU_STREAM_ARTIFACTS_ELEMENT_ID
  | typeof FEISHU_STREAM_ANSWER_ELEMENT_ID
  | FeishuStreamingProgressElementId
  | FeishuStreamingActivityElementId;

export interface FeishuStreamingSectionPlacement {
  type: "insert_after";
  targetElementId: FeishuStreamingSectionElementId;
}

export interface FeishuStreamingReplyTarget {
  chatId: string;
  replyToMessageId: string;
  replyInThread: boolean;
}

export interface FeishuStreamingReply {
  cardId: string;
  messageId: string;
}

export interface FeishuNativeArtifactUpload {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
  sizeBytes: number;
  /** Digest verified again immediately before the Feishu SDK upload call. */
  sha256: string;
  source: "codex_image_generation" | "codex_generated_file";
  retention: "feishu_managed";
  /**
   * Path-free identity used only to derive a bounded delivery idempotency key.
   * The Lark transport hashes these fields before durable persistence.
   */
  deliveryIdentity?: FeishuArtifactDeliveryIdentity;
}

export interface FeishuArtifactDeliveryIdentity {
  accountId: string;
  sessionId: string;
  threadId: string;
  turnId: string;
  itemId: string;
  artifactId: string;
}

export interface FeishuInteractionApi {
  createInputCard(
    target: FeishuStreamingReplyTarget,
    card: object,
  ): Promise<FeishuStreamingReply>;
  updateInputCard(
    cardId: string,
    card: object,
    sequence: number,
  ): Promise<void>;
}

export interface FeishuOutboundApi {
  createStreamingReply(
    target: FeishuStreamingReplyTarget,
    initialText: string,
  ): Promise<FeishuStreamingReply>;
  updateStreamingReply(
    cardId: string,
    content: string,
    sequence: number,
  ): Promise<void>;
  /**
   * Optional CardKit v2 section update. When available, rich replies keep
   * status/progress/tools/artifacts/answer in stable elements so a status
   * change cannot replay or replace the entire streaming transcript.
   */
  updateStreamingReplySection?(
    cardId: string,
    elementId: FeishuStreamingSectionElementId,
    content: string,
    sequence: number,
  ): Promise<void>;
  /** Create a stable CardKit v2 markdown element only when it becomes visible. */
  createStreamingReplySection?(
    cardId: string,
    elementId: FeishuStreamingSectionElementId,
    content: string,
    placement: FeishuStreamingSectionPlacement,
    sequence: number,
  ): Promise<void>;
  /** Remove a no-longer-visible stable element without leaving a blank row. */
  deleteStreamingReplySection?(
    cardId: string,
    elementId: FeishuStreamingSectionElementId,
    sequence: number,
  ): Promise<void>;
  finishStreamingReply(
    cardId: string,
    sequence: number,
    summary: string,
  ): Promise<void>;
  sendTextReply(
    target: FeishuStreamingReplyTarget,
    text: string,
  ): Promise<{ messageId: string }>;
  /** Optional native upload surface; older/custom transports degrade safely. */
  sendImageReply?(
    target: FeishuStreamingReplyTarget,
    image: FeishuNativeArtifactUpload,
  ): Promise<{ messageId: string; imageKey: string }>;
  /** Optional native file upload surface; fixed safe fallback is used if absent. */
  sendFileReply?(
    target: FeishuStreamingReplyTarget,
    file: FeishuNativeArtifactUpload,
  ): Promise<{ messageId: string; fileKey: string }>;
  /** Optional native MP4 upload surface; fixed safe fallback is used if absent. */
  sendVideoReply?(
    target: FeishuStreamingReplyTarget,
    video: FeishuNativeArtifactUpload,
  ): Promise<{ messageId: string; fileKey: string }>;
}

export function hasFeishuOutboundApi(
  value: unknown,
): value is FeishuOutboundApi {
  if (!value || typeof value !== "object") return false;
  const api = value as Partial<FeishuOutboundApi>;
  return (
    typeof api.createStreamingReply === "function" &&
    typeof api.updateStreamingReply === "function" &&
    typeof api.finishStreamingReply === "function" &&
    typeof api.sendTextReply === "function"
  );
}

export function hasFeishuInteractionApi(
  value: unknown,
): value is FeishuInteractionApi {
  if (!value || typeof value !== "object") return false;
  const api = value as Partial<FeishuInteractionApi>;
  return (
    typeof api.createInputCard === "function" &&
    typeof api.updateInputCard === "function"
  );
}
