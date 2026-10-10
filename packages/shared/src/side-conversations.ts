import { z } from "zod";

export const SIDE_CONVERSATION_MAX_PROMPT = 32_000;
const identity = z.string().min(1).max(128);

/** This control plane must never fall through to the parent message queue. */
export const SideConversationRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("get"),
      version: z.number().int().nonnegative().optional(),
      id: identity.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("create"),
      requestId: identity,
      context: z.enum(["snapshot", "empty"]).default("snapshot"),
    })
    .strict(),
  z
    .object({
      action: z.literal("send"),
      id: identity,
      requestId: identity,
      text: z.string().trim().min(1).max(SIDE_CONVERSATION_MAX_PROMPT),
    })
    .strict(),
  z.object({ action: z.literal("interrupt"), id: identity }).strict(),
  z.object({ action: z.literal("close"), id: identity }).strict(),
]);

export type SideConversationRequest = z.infer<
  typeof SideConversationRequestSchema
>;
export type SideConversationStatus =
  | "creating"
  | "idle"
  | "running"
  | "stopping"
  | "failed"
  | "closed";
export interface SideConversationMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Sanitized server-rendered Markdown, present after completion. */
  html?: string;
}
export interface SideConversationSnapshot {
  id: string;
  parentSessionId: string;
  context: "snapshot" | "empty";
  capturedAt: string;
  model?: string;
  reasoningEffort?: string;
  status: SideConversationStatus;
  version: number;
  messages: SideConversationMessage[];
  activity?: string;
  error?: string;
  usage?: { inputTokens: number; outputTokens: number };
}
export interface SideConversationResponse {
  supported: boolean;
  reason?: "not_ready" | "unsupported";
  conversation?: SideConversationSnapshot;
  unchanged?: boolean;
  error?: string;
}

/** Only exact command tokens, never `/sidebar` or a quoted code example. */
export function parseSideConversationCommand(
  text: string,
): { text: string } | null {
  const match = /^\/(?:side|btw)(?:\s+([\s\S]*))?$/u.exec(text.trim());
  return match ? { text: match[1]?.trim() ?? "" } : null;
}
