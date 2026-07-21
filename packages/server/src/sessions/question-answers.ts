import type {
  InputRequest,
  UserQuestionAnswer,
  UserQuestionAnswers,
} from "@yep-anywhere/shared";

interface QuestionRecord {
  id?: unknown;
  question?: unknown;
  required?: unknown;
}

export interface QuestionAnswerValidation {
  valid: boolean;
  missingAnswerCount: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function hasAnswer(value: UserQuestionAnswer | undefined): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  return (
    Array.isArray(value) &&
    value.some((item) => typeof item === "string" && item.trim().length > 0)
  );
}

function getQuestionAnswer(
  question: QuestionRecord,
  answers: UserQuestionAnswers | undefined,
): UserQuestionAnswer | undefined {
  if (!answers) return undefined;
  const id = readNonEmptyString(question.id);
  const text = readNonEmptyString(question.question);
  return (id ? answers[id] : undefined) ?? (text ? answers[text] : undefined);
}

/**
 * Validate an approved interactive question without consuming the pending
 * request. Providers that explicitly allow partial submission keep their
 * provider-defined behavior; all other requests require every non-optional
 * question to have an answer.
 */
export function validateQuestionAnswers(
  request: InputRequest,
  answers: UserQuestionAnswers | undefined,
): QuestionAnswerValidation {
  if (request.type !== "question" && request.toolName !== "AskUserQuestion") {
    return { valid: true, missingAnswerCount: 0 };
  }

  const input = asRecord(request.toolInput);
  if (input?.allowPartialSubmission === true) {
    return { valid: true, missingAnswerCount: 0 };
  }

  const questions = Array.isArray(input?.questions)
    ? input.questions
        .map((question) => asRecord(question))
        .filter((question): question is Record<string, unknown> => !!question)
    : [];

  if (questions.length === 0) {
    const hasAnyAnswer = Object.values(answers ?? {}).some(hasAnswer);
    return {
      valid: hasAnyAnswer,
      missingAnswerCount: hasAnyAnswer ? 0 : 1,
    };
  }

  const missingAnswerCount = questions.filter(
    (question) =>
      question.required !== false &&
      !hasAnswer(getQuestionAnswer(question, answers)),
  ).length;

  return {
    valid: missingAnswerCount === 0,
    missingAnswerCount,
  };
}
