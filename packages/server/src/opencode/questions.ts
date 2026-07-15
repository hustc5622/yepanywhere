import type { UserQuestionAnswers } from "@yep-anywhere/shared";
import { asRecord } from "../bridge-common/util.js";

/**
 * Normalization of OpenCode AskUserQuestion payloads, shared by the SDK
 * provider (question events on owned sessions) and the bridge sidecar
 * (question requests observed on external sessions).
 */

export interface OpenCodeQuestionOption {
  label: string;
  description: string;
}

export interface OpenCodeQuestion {
  id: string;
  question: string;
  header: string;
  options: OpenCodeQuestionOption[];
  multiSelect: boolean;
  custom?: boolean;
}

function readNonEmptyString(
  record: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function normalizeOpenCodeQuestions(raw: unknown): OpenCodeQuestion[] {
  if (!Array.isArray(raw)) return [];
  const questions: OpenCodeQuestion[] = [];
  for (const [index, item] of raw.entries()) {
    const record = asRecord(item);
    const question = readNonEmptyString(record, "question");
    if (!question) continue;

    const options = Array.isArray(record?.options)
      ? record.options
          .map((option) => {
            const optionRecord = asRecord(option);
            const label = readNonEmptyString(optionRecord, "label");
            if (!label) return null;
            return {
              label,
              description:
                readNonEmptyString(optionRecord, "description") ?? "",
            };
          })
          .filter((option): option is OpenCodeQuestionOption => option !== null)
      : [];

    questions.push({
      id: `question-${index}`,
      question,
      header: readNonEmptyString(record, "header") ?? "Question",
      options,
      multiSelect: Boolean(record?.multiSelect ?? record?.multiple),
      ...(typeof record?.custom === "boolean" ? { custom: record.custom } : {}),
    });
  }
  return questions;
}

/**
 * Order the user's answers to match the normalized question list. Answers are
 * keyed either by question id ("question-N") or by the question text.
 */
export function buildOpenCodeQuestionAnswers(
  questions: OpenCodeQuestion[],
  answers: UserQuestionAnswers | undefined,
): string[][] {
  return questions.map((question) => {
    const answer = answers?.[question.id] ?? answers?.[question.question];
    if (typeof answer === "string") return answer ? [answer] : [];
    if (Array.isArray(answer)) {
      return answer.filter(
        (value): value is string => typeof value === "string" && !!value,
      );
    }
    return [];
  });
}
