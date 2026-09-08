import { z } from "zod";

/** Async delivery is independent of phase: Codex also uses final_answer for questions. */
export const CodexAsyncMessageSchema = z
  .object({
    delivery: z.literal("async"),
    questions: z
      .array(
        z
          .object({
            title: z.string(),
            options: z.array(z.string()).nullable().optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export type CodexAsyncMessage = z.infer<typeof CodexAsyncMessageSchema>;

/** Accept native ThreadItems and rollout items, including older CLIs without questions. */
export function readCodexAsyncMessage(
  item: unknown,
): CodexAsyncMessage | undefined {
  if (!item || typeof item !== "object") return undefined;
  const value = item as Record<string, unknown>;
  if (value.delivery !== "async") return undefined;
  const parsed = CodexAsyncMessageSchema.safeParse({
    delivery: "async",
    ...(Array.isArray(value.questions) ? { questions: value.questions } : {}),
  });
  return parsed.success ? parsed.data : { delivery: "async" };
}
