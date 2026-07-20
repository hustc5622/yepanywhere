/**
 * OpenCode session storage types.
 *
 * OpenCode stores sessions in a directory-based structure:
 * ~/.local/share/opencode/storage/
 *   project/{projectId}.json        - Project metadata
 *   session/{projectId}/{sessionId}.json  - Session metadata
 *   message/{sessionId}/{messageId}.json  - Message metadata
 *   part/{messageId}/{partId}.json        - Message parts
 */

import { z } from "zod";

/**
 * OpenCode project JSON file.
 */
export const OpenCodeProjectSchema = z.object({
  id: z.string(),
  worktree: z.string(),
  vcs: z.string().optional(),
  sandboxes: z.array(z.unknown()).optional(),
  time: z
    .object({
      created: z.number().optional(),
      updated: z.number().optional(),
    })
    .optional(),
});

export type OpenCodeProject = z.infer<typeof OpenCodeProjectSchema>;

/**
 * OpenCode session JSON file.
 */
export const OpenCodeSessionSchema = z.object({
  id: z.string(),
  version: z.string().optional(),
  projectID: z.string(),
  directory: z.string().optional(),
  title: z.string().optional(),
  parentID: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  model: z
    .object({
      id: z.string().optional(),
      providerID: z.string().optional(),
      modelID: z.string().optional(),
      variant: z.string().optional(),
    })
    .optional(),
  permission: z.array(z.unknown()).optional(),
  time: z
    .object({
      created: z.number().optional(),
      updated: z.number().optional(),
    })
    .optional(),
  summary: z
    .object({
      additions: z.number().optional(),
      deletions: z.number().optional(),
      files: z.number().optional(),
    })
    .optional(),
});

export type OpenCodeSession = z.infer<typeof OpenCodeSessionSchema>;

/**
 * OpenCode message JSON file.
 */
export const OpenCodeMessageSchema = z.object({
  id: z.string(),
  sessionID: z.string(),
  role: z.enum(["user", "assistant"]),
  time: z
    .object({
      created: z.number().optional(),
      completed: z.number().optional(),
    })
    .optional(),
  parentID: z.string().optional(),
  modelID: z.string().optional(),
  providerID: z.string().optional(),
  variant: z.string().optional(),
  mode: z.string().optional(),
  agent: z.string().optional(),
  path: z
    .object({
      cwd: z.string().optional(),
      root: z.string().optional(),
    })
    .optional(),
  cost: z.number().optional(),
  tokens: z
    .object({
      input: z.number().optional(),
      output: z.number().optional(),
      reasoning: z.number().optional(),
      cache: z
        .object({
          read: z.number().optional(),
          write: z.number().optional(),
        })
        .optional(),
    })
    .optional(),
  finish: z.string().optional(),
  summary: z
    .object({
      title: z.string().optional(),
      diffs: z.array(z.unknown()).optional(),
    })
    .optional(),
  model: z
    .object({
      id: z.string().optional(),
      providerID: z.string().optional(),
      modelID: z.string().optional(),
      variant: z.string().optional(),
    })
    .optional(),
  tools: z.record(z.string(), z.boolean()).optional(),
});

export type OpenCodeMessage = z.infer<typeof OpenCodeMessageSchema>;

/**
 * OpenCode part JSON file (stored on disk).
 * Similar to OpenCodePart from events.ts but with additional fields from disk storage.
 */
export const OpenCodeStoredPartSchema = z.object({
  id: z.string(),
  sessionID: z.string(),
  messageID: z.string(),
  type: z.string(), // "text", "step-start", "step-finish", "tool", etc.
  text: z.string().optional(),
  // file-specific fields
  mime: z.string().optional(),
  filename: z.string().optional(),
  url: z.string().optional(),
  source: z.unknown().optional(),
  synthetic: z.boolean().optional(),
  time: z
    .object({
      start: z.number().optional(),
      end: z.number().optional(),
    })
    .optional(),
  // tool-specific fields
  callID: z.string().optional(),
  tool: z.string().optional(),
  state: z
    .object({
      status: z.string().optional(),
      input: z.unknown().optional(),
      output: z.unknown().optional(),
      error: z.string().optional(),
      title: z.string().optional(),
      metadata: z.unknown().optional(),
      time: z
        .object({
          start: z.number().optional(),
          end: z.number().optional(),
        })
        .optional(),
    })
    .optional(),
  // step-finish fields
  reason: z.string().optional(),
  snapshot: z.string().optional(),
  cost: z.number().optional(),
  tokens: z
    .object({
      input: z.number().optional(),
      output: z.number().optional(),
      reasoning: z.number().optional(),
      cache: z
        .object({
          read: z.number().optional(),
          write: z.number().optional(),
        })
        .optional(),
    })
    .optional(),
});

export type OpenCodeStoredPart = z.infer<typeof OpenCodeStoredPartSchema>;

/**
 * OpenCode session entry - a message with its parts loaded.
 * This is the combined form used for session display.
 */
export interface OpenCodeSessionEntry {
  message: OpenCodeMessage;
  parts: OpenCodeStoredPart[];
}

/**
 * OpenCode session file content - used in UnifiedSession.
 */
export interface OpenCodeSessionContent {
  messages: OpenCodeSessionEntry[];
}
