import { z } from "zod";

/**
 * Helper to create a tool result schema that accepts either the structured
 * object format OR a string error message.
 *
 * The SDK writes toolUseResult as a string for errors/interrupts, e.g.:
 * - "Error: Exit code 1\n..."
 * - "Error: [Request interrupted by user for tool use]"
 *
 * This is the actual format persisted in session JSONL files.
 */
function withStringError<T extends z.ZodTypeAny>(schema: T) {
  return z.union([schema, z.string()]);
}

/**
 * ContentBlock schema for Task result content
 * Matches the ContentBlock interface in client/src/components/renderers/types.ts
 */
const ContentBlockSchema = z.object({
  type: z.enum(["text", "thinking", "tool_use", "tool_result"]),
  text: z.string().optional(),
  thinking: z.string().optional(),
  signature: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  input: z.unknown().optional(),
  tool_use_id: z.string().optional(),
  content: z.string().optional(),
  is_error: z.boolean().optional(),
});

/**
 * Task tool structured result (success case)
 */
const TaskResultObjectSchema = z.object({
  status: z
    .enum(["completed", "failed", "timeout", "async_launched"])
    .optional(),
  prompt: z.string().optional(),
  agentId: z.string().optional(),
  content: z.array(ContentBlockSchema).optional(),
  totalDurationMs: z.number().optional(),
  totalTokens: z.number().optional(),
  totalToolUseCount: z.number().optional(),
  isAsync: z.boolean().optional(),
  description: z.string().optional(),
  outputFile: z.string().optional(),
});

/**
 * Task tool result schema
 * Accepts either structured object OR string error message from SDK
 */
export const TaskResultSchema = withStringError(TaskResultObjectSchema);

export type TaskResultValidated = z.infer<typeof TaskResultSchema>;

/**
 * Bash tool structured result (success case)
 */
const BashResultObjectSchema = z.object({
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  interrupted: z.boolean().optional(),
  isImage: z.boolean().optional(),
  backgroundTaskId: z.string().optional(),
});

/**
 * Bash tool result schema
 * Accepts either structured object OR string error message from SDK
 */
export const BashResultSchema = withStringError(BashResultObjectSchema);

export type BashResultValidated = z.infer<typeof BashResultSchema>;

/**
 * Read tool result schemas
 * Matches the ReadResult, TextFile, and ImageFile interfaces
 */
const TextFileSchema = z.object({
  filePath: z.string().optional(),
  content: z.string().optional(),
  numLines: z.number().optional(),
  startLine: z.number().optional(),
  totalLines: z.number().optional(),
});

const ImageFileDimensionsSchema = z.object({
  originalWidth: z.number().optional(),
  originalHeight: z.number().optional(),
  displayWidth: z.number().optional(),
  displayHeight: z.number().optional(),
});

const ImageFileSchema = z.object({
  base64: z.string().optional(),
  type: z.string().optional(),
  originalSize: z.number().optional(),
  dimensions: ImageFileDimensionsSchema.optional(),
});

const ReadResultObjectSchema = z.object({
  type: z.enum(["text", "image", "pdf"]).optional(),
  file: z.union([TextFileSchema, ImageFileSchema]).optional(),
});

/**
 * Read tool result schema
 * Accepts either structured object OR string error message from SDK
 */
export const ReadResultSchema = withStringError(ReadResultObjectSchema);

export type ReadResultValidated = z.infer<typeof ReadResultSchema>;

/**
 * Edit tool result schema
 * Matches the EditResult and PatchHunk interfaces
 *
 * Note: The SDK provides `type` field ("create" for new files, "edit" for modifications)
 * and `originalFile` can be null for new file creation.
 */
const PatchHunkSchema = z.object({
  oldStart: z.number().optional(),
  oldLines: z.number().optional(),
  newStart: z.number().optional(),
  newLines: z.number().optional(),
  lines: z.array(z.string()).optional(),
});

const EditResultObjectSchema = z.object({
  type: z.enum(["create", "edit", "update"]).optional(),
  filePath: z.string().optional(),
  oldString: z.string().optional(),
  newString: z.string().optional(),
  originalFile: z.string().nullable().optional(),
  replaceAll: z.boolean().optional(),
  userModified: z.boolean().optional(),
  structuredPatch: z.array(PatchHunkSchema).optional(),
});

/**
 * Edit tool result schema
 * Accepts either structured object OR string error message from SDK
 */
export const EditResultSchema = withStringError(EditResultObjectSchema);

export type EditResultValidated = z.infer<typeof EditResultSchema>;

const WriteResultObjectSchema = z.object({
  type: z.literal("text").optional(),
  file: z
    .object({
      filePath: z.string().optional(),
      content: z.string().optional(),
      numLines: z.number().optional(),
      startLine: z.number().optional(),
      totalLines: z.number().optional(),
    })
    .optional(),
});

/**
 * Write tool result schema
 * Accepts either structured object OR string error message from SDK
 */
export const WriteResultSchema = withStringError(WriteResultObjectSchema);

export type WriteResultValidated = z.infer<typeof WriteResultSchema>;

const GlobResultObjectSchema = z.object({
  filenames: z.array(z.string()).optional(),
  durationMs: z.number().optional(),
  numFiles: z.number().optional(),
  truncated: z.boolean().optional(),
});

/**
 * Glob tool result schema
 * Accepts either structured object OR string error message from SDK
 */
export const GlobResultSchema = withStringError(GlobResultObjectSchema);

export type GlobResultValidated = z.infer<typeof GlobResultSchema>;

const GrepResultObjectSchema = z.object({
  mode: z.enum(["files_with_matches", "content", "count"]).optional(),
  filenames: z.array(z.string()).optional(),
  numFiles: z.number().optional(),
  content: z.string().optional(),
  numLines: z.number().optional(),
  appliedLimit: z.number().optional(),
});

/**
 * Grep tool result schema
 * Accepts either structured object OR string error message from SDK
 */
export const GrepResultSchema = withStringError(GrepResultObjectSchema);

export type GrepResultValidated = z.infer<typeof GrepResultSchema>;

const TodoSchema = z.object({
  content: z.string().optional(),
  status: z.enum(["pending", "in_progress", "completed"]).optional(),
  activeForm: z.string().optional(),
});

const TodoWriteResultObjectSchema = z.object({
  oldTodos: z.array(TodoSchema).optional(),
  newTodos: z.array(TodoSchema).optional(),
});

/**
 * TodoWrite tool result schema
 * Accepts either structured object OR string error message from SDK
 */
export const TodoWriteResultSchema = withStringError(
  TodoWriteResultObjectSchema,
);

export type TodoWriteResultValidated = z.infer<typeof TodoWriteResultSchema>;

/**
 * WebSearch result item - can be an object with search results or a string summary
 */
const WebSearchResultItemSchema = z.object({
  tool_use_id: z.string().optional(),
  content: z
    .array(
      z.object({
        title: z.string().optional(),
        url: z.string().optional(),
      }),
    )
    .optional(),
});

const WebSearchResultObjectSchema = z.object({
  query: z.string().optional(),
  results: z.array(z.union([WebSearchResultItemSchema, z.string()])).optional(),
  durationSeconds: z.number().optional(),
});

/**
 * WebSearch tool result schema
 * Accepts either structured object OR string error message from SDK
 */
export const WebSearchResultSchema = withStringError(
  WebSearchResultObjectSchema,
);

export type WebSearchResultValidated = z.infer<typeof WebSearchResultSchema>;

const WebFetchResultObjectSchema = z.object({
  bytes: z.number().optional(),
  code: z.number().optional(),
  codeText: z.string().optional(),
  result: z.string().optional(),
  durationMs: z.number().optional(),
  url: z.string().optional(),
});

/**
 * WebFetch tool result schema
 * Accepts either structured object OR string error message from SDK
 */
export const WebFetchResultSchema = withStringError(WebFetchResultObjectSchema);

export type WebFetchResultValidated = z.infer<typeof WebFetchResultSchema>;

const QuestionOptionSchema = z.object({
  label: z.string().optional(),
  description: z.string().optional(),
});

const QuestionSchema = z.object({
  id: z.string().optional(),
  question: z.string().optional(),
  header: z.string().optional(),
  options: z.array(QuestionOptionSchema).optional(),
  multiSelect: z.boolean().optional(),
  custom: z.boolean().optional(),
});

const AskUserQuestionResultObjectSchema = z.object({
  questions: z.array(QuestionSchema).optional(),
  answers: z
    .record(z.string(), z.union([z.string(), z.array(z.string())]))
    .optional(),
});

/**
 * AskUserQuestion tool result schema
 * Accepts either structured object OR string error message from SDK
 */
export const AskUserQuestionResultSchema = withStringError(
  AskUserQuestionResultObjectSchema,
);

export type AskUserQuestionResultValidated = z.infer<
  typeof AskUserQuestionResultSchema
>;

const BashOutputResultObjectSchema = z.object({
  shellId: z.string().optional(),
  command: z.string().optional(),
  status: z.enum(["running", "completed", "failed"]).optional(),
  exitCode: z.number().nullable().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  stdoutLines: z.number().optional(),
  stderrLines: z.number().optional(),
  timestamp: z.string().optional(),
});

/**
 * BashOutput tool result schema
 * Accepts either structured object OR string error message from SDK
 */
export const BashOutputResultSchema = withStringError(
  BashOutputResultObjectSchema,
);

export type BashOutputResultValidated = z.infer<typeof BashOutputResultSchema>;

const TaskOutputResultObjectSchema = z.object({
  retrieval_status: z
    .enum(["completed", "success", "not_ready", "timeout", "running"])
    .optional(),
  task: z
    .object({
      task_id: z.string().optional(),
      task_type: z.enum(["local_bash", "local_agent", "agent"]).optional(),
      status: z.enum(["running", "completed", "failed"]).optional(),
      description: z.string().optional(),
      output: z.string().optional(),
      exitCode: z.number().nullable().optional(),
    })
    .optional(),
});

/**
 * TaskOutput tool result schema
 * Accepts either structured object OR string error message from SDK
 */
export const TaskOutputResultSchema = withStringError(
  TaskOutputResultObjectSchema,
);

export type TaskOutputResultValidated = z.infer<typeof TaskOutputResultSchema>;

const KillShellResultObjectSchema = z.object({
  message: z.string().optional(),
  shell_id: z.string().optional(),
});

/**
 * KillShell tool result schema
 * Accepts either structured object OR string error message from SDK
 */
export const KillShellResultSchema = withStringError(
  KillShellResultObjectSchema,
);

export type KillShellResultValidated = z.infer<typeof KillShellResultSchema>;

const TaskStopResultObjectSchema = z.object({
  message: z.string().optional(),
  task_id: z.string().optional(),
  task_type: z.string().optional(),
  command: z.string().optional(),
});

/**
 * TaskStop tool result schema
 * Accepts either structured object OR string error message from SDK
 */
export const TaskStopResultSchema = withStringError(TaskStopResultObjectSchema);

export type TaskStopResultValidated = z.infer<typeof TaskStopResultSchema>;

const ToolSearchResultObjectSchema = z.object({
  matches: z.array(z.string()).optional(),
  query: z.string().optional(),
  total_deferred_tools: z.number().optional(),
  pending_mcp_servers: z.array(z.string()).optional(),
});

/**
 * ToolSearch tool result schema
 * Accepts either structured object OR string error message from SDK
 */
export const ToolSearchResultSchema = withStringError(
  ToolSearchResultObjectSchema,
);

export type ToolSearchResultValidated = z.infer<typeof ToolSearchResultSchema>;

const EnterPlanModeResultObjectSchema = z.object({
  message: z.string().optional(),
});

/**
 * EnterPlanMode tool result schema
 * Accepts either structured object OR string error message from SDK
 */
export const EnterPlanModeResultSchema = withStringError(
  EnterPlanModeResultObjectSchema,
);

export type EnterPlanModeResultValidated = z.infer<
  typeof EnterPlanModeResultSchema
>;

const ExitPlanModeResultObjectSchema = z.object({
  message: z.string().optional(),
  plan: z.string().nullable().optional(),
  isAgent: z.boolean().optional(),
  filePath: z.string().optional(),
});

/**
 * ExitPlanMode tool result schema
 * Accepts either structured object OR string error message from SDK
 */
export const ExitPlanModeResultSchema = withStringError(
  ExitPlanModeResultObjectSchema,
);

export type ExitPlanModeResultValidated = z.infer<
  typeof ExitPlanModeResultSchema
>;
