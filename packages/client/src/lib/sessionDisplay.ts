import type {
  SessionBranchState,
  SessionDisplayPage,
  SessionDisplaySegment,
  SessionDisplayUserContent,
} from "@yep-anywhere/shared";
import type { ContentBlock, Message } from "../types";
import type { RenderItem } from "../types/renderItems";

type DisplayNotice = Extract<SessionDisplaySegment, { type: "notice" }>;

export interface BuildSessionDisplayRenderItemsOptions {
  projectId: string;
  branchId?: string;
  branchState?: SessionBranchState;
  /** Raw self-owned live tail already rendered from in-memory messages. */
  omitToolGroupDetailRef?: string | null;
  formatNotice: (notice: DisplayNotice) => string;
}

/**
 * Keep the persisted, body-free Inspector index while layering the bounded
 * live tail on top. Exact message replays are removed here; duplicate tool ids
 * from source-native live/persisted shapes are reconciled by preprocessMessages.
 */
export function mergeSessionInspectorMessages(
  indexed: readonly Message[] | null,
  live: readonly Message[],
): Message[] {
  if (!indexed) return [...live];
  const indexedIds = new Set(
    indexed.map((message) => message.uuid ?? message.id).filter(Boolean),
  );
  const indexedCorrelations = new Set(
    indexed
      .map((message) => message.codexCorrelationKey)
      .filter((value): value is string => Boolean(value)),
  );
  return [
    ...indexed,
    ...live.filter((message) => {
      const id = message.uuid ?? message.id;
      const correlation =
        typeof message.codexCorrelationKey === "string"
          ? message.codexCorrelationKey
          : undefined;
      return (
        (!id || !indexedIds.has(id)) &&
        (!correlation || !indexedCorrelations.has(correlation))
      );
    }),
  ];
}

/**
 * Reconnect safe index rows split across transport pages to their owning user
 * prompt, then remove the internal boundary markers before preprocessing.
 */
export function resolveSessionInspectorNavigation(
  messages: readonly Message[],
): Message[] {
  let currentQuestionId: string | undefined;
  const resolved: Message[] = [];
  for (const message of messages) {
    if (message.inspectorQuestionBoundary) {
      currentQuestionId =
        message.inspectorNavigationMessageId ?? message.uuid ?? message.id;
      continue;
    }
    if (currentQuestionId && !message.inspectorNavigationMessageId) {
      resolved.push({
        ...message,
        inspectorNavigationMessageId: currentQuestionId,
      });
    } else {
      resolved.push(message);
    }
  }
  return resolved;
}

export function buildSessionDisplayRenderItems(
  page: SessionDisplayPage,
  options: BuildSessionDisplayRenderItemsOptions,
): RenderItem[] {
  const items: RenderItem[] = [];

  for (const turn of page.turns) {
    if (turn.question) {
      const source = questionSourceMessage(
        page,
        turn.id,
        turn.question,
        options,
      );
      items.push({
        type: "user_prompt",
        id: turn.question.messageId,
        content: projectUserContent(turn.question.content),
        sourceMessages: [source],
      });
    }

    for (const segment of turn.segments) {
      const source = segmentSourceMessage(
        turn.id,
        segment.id,
        segment.timestamp,
        segment.type === "assistant_text"
          ? segment.codexCorrelationKey
          : undefined,
      );
      switch (segment.type) {
        case "assistant_text":
          items.push({
            type: "text",
            id: segment.id,
            text: segment.content,
            ...(segment.phase === "progress"
              ? { phase: "commentary" as const }
              : segment.phase === "final"
                ? { phase: "final_answer" as const }
                : {}),
            sourceMessages: [source],
          });
          break;
        case "tool_group":
        case "action_required":
          if (
            segment.type === "tool_group" &&
            segment.detailRef === options.omitToolGroupDetailRef
          ) {
            break;
          }
          items.push({
            type: "display_tool_group",
            id: segment.id,
            group: segment,
            projectId: options.projectId,
            sessionId: page.sessionId,
            revision: page.revision,
            ...(options.branchId ? { branchId: options.branchId } : {}),
            sourceMessages: [source],
          });
          break;
        case "error":
          items.push({
            type: "system",
            id: segment.id,
            subtype: "error",
            content: segment.message,
            sourceMessages: [source],
          });
          break;
        case "notice":
          items.push({
            type: "system",
            id: segment.id,
            subtype:
              segment.kind === "warning"
                ? "warning"
                : segment.kind === "compaction"
                  ? "compact_boundary"
                  : segment.kind === "turn_aborted"
                    ? "turn_aborted"
                    : `display_${segment.kind}`,
            content: options.formatNotice(segment),
            sourceMessages: [source],
          });
          break;
      }
    }
  }

  return items;
}

function questionSourceMessage(
  page: SessionDisplayPage,
  turnId: string,
  question: NonNullable<SessionDisplayPage["turns"][number]["question"]>,
  options: BuildSessionDisplayRenderItemsOptions,
): Message {
  const branch = question.branch;
  const siblingBranches = branch
    ? (options.branchState?.branches.filter(
        (candidate) => candidate.parentId === branch.parentId,
      ) ?? [])
    : [];
  const branchMetadata = branch
    ? {
        sessionId: page.sessionId,
        branchId: branch.branchId,
        activeBranchId: options.branchState?.activeBranchId ?? null,
        selectedBranchId: options.branchState?.selectedBranchId ?? null,
        parentId: branch.parentId,
        siblingIndex: branch.siblingIndex,
        siblingCount: branch.siblingCount,
        alternatives: siblingBranches,
      }
    : undefined;
  const content = projectUserContent(question.content);
  return {
    uuid: question.messageId,
    id: question.messageId,
    type: "user",
    role: "user",
    content,
    message: { role: "user", content },
    parentUuid: question.parentMessageId ?? null,
    timestamp: question.timestamp,
    _source: "jsonl",
    ...(question.clientUserMessageId
      ? { clientUserMessageId: question.clientUserMessageId }
      : {}),
    ...(question.codexCorrelationKey
      ? { codexCorrelationKey: question.codexCorrelationKey }
      : {}),
    codexTurnId: turnId.startsWith("turn:")
      ? turnId.slice("turn:".length)
      : turnId,
    ...(branchMetadata ? { branch: branchMetadata } : {}),
  };
}

function segmentSourceMessage(
  turnId: string,
  id: string,
  timestamp: string | undefined,
  codexCorrelationKey?: string,
): Message {
  return {
    uuid: id,
    id,
    type: "assistant",
    role: "assistant",
    timestamp,
    ...(codexCorrelationKey ? { codexCorrelationKey } : {}),
    codexTurnId: turnId.startsWith("turn:")
      ? turnId.slice("turn:".length)
      : turnId,
    _source: "jsonl",
  };
}

function projectUserContent(
  content: SessionDisplayUserContent,
): string | ContentBlock[] {
  if (typeof content === "string") return content;
  return content.map((block): ContentBlock => {
    if (block.type === "text") return block;
    switch (block.kind) {
      case "image":
        return {
          type: "input_image",
          deferred: true,
          ...(block.mimeType ? { mime_type: block.mimeType } : {}),
        };
      case "audio":
        return {
          type: "input_audio",
          deferred: true,
          ...(block.mimeType ? { mime_type: block.mimeType } : {}),
        };
      case "document":
      case "file":
        return {
          type: "document",
          deferred: true,
          ...(block.mimeType ? { mime_type: block.mimeType } : {}),
        };
    }
  });
}
