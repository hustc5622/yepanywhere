import type {
  UserQuestionAnswer,
  UserQuestionAnswers,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuestionOtherDrafts } from "../hooks/useDrafts";
import { useI18n } from "../i18n";
import type { InputRequest } from "../types";
import type { AskUserQuestionInput, Question } from "./renderers/tools/types";

const OTHER_ANSWER = "__other__";

function getQuestionAnswerKey(question: Question): string {
  return question.id || question.question;
}

function getOptionValue(option: Question["options"][number]): string {
  return option.value ?? option.label;
}

function getDefaultAnswers(questions: Question[]): UserQuestionAnswers {
  const answers: UserQuestionAnswers = {};
  for (const question of questions) {
    if (question.defaultValue === undefined) continue;
    answers[getQuestionAnswerKey(question)] = question.defaultValue;
  }
  return answers;
}

function includesAnswer(
  answer: UserQuestionAnswer | undefined,
  value: string,
): boolean {
  return Array.isArray(answer) ? answer.includes(value) : answer === value;
}

function hasAnswer(
  answer: UserQuestionAnswer | undefined,
  otherText: string | undefined,
): boolean {
  if (Array.isArray(answer)) {
    if (answer.length === 0) return false;
    return !answer.includes(OTHER_ANSWER) || Boolean(otherText?.trim());
  }
  if (!answer) return false;
  return answer !== OTHER_ANSWER || Boolean(otherText?.trim());
}

function canLeaveQuestion(
  question: Question,
  answer: UserQuestionAnswer | undefined,
  otherText: string | undefined,
): boolean {
  return question.required === false || hasAnswer(answer, otherText);
}

interface Props {
  request: InputRequest;
  sessionId: string;
  onSubmit: (answers: UserQuestionAnswers) => Promise<void>;
  onDeny: () => Promise<void>;
  readOnly?: boolean;
  readOnlyNotice?: string;
}

/**
 * Panel for answering AskUserQuestion tool calls.
 * Shows one question at a time with tabs to navigate between them.
 */
export function QuestionAnswerPanel({
  request,
  sessionId,
  onSubmit,
  onDeny,
  readOnly = false,
  readOnlyNotice,
}: Props) {
  const { t } = useI18n();
  const input = request.toolInput as AskUserQuestionInput;
  const questions = input?.questions || [];
  const originRecord =
    input && typeof input === "object"
      ? (input as unknown as Record<string, unknown>)
      : undefined;
  const subagentOriginTitle =
    originRecord && typeof originRecord.originSessionId === "string"
      ? typeof originRecord.originSessionTitle === "string"
        ? originRecord.originSessionTitle
        : typeof originRecord.originAgent === "string"
          ? originRecord.originAgent
          : undefined
      : undefined;

  const [currentTab, setCurrentTab] = useState(0);
  const [answers, setAnswers] = useState<UserQuestionAnswers>(() =>
    getDefaultAnswers(questions),
  );
  // Persist ordinary "Other" drafts, but keep secret values in memory only.
  const [persistedOtherTexts, setPersistedOtherText, clearPersistedOtherTexts] =
    useQuestionOtherDrafts(sessionId, request.id);
  const [secretOtherTexts, setSecretOtherTexts] = useState<
    Record<string, string>
  >({});
  const otherTexts = useMemo(() => {
    const next = { ...persistedOtherTexts, ...secretOtherTexts };
    for (const question of questions) {
      if (question.inputType === "password") {
        const key = getQuestionAnswerKey(question);
        if (!(key in secretOtherTexts)) delete next[key];
      }
    }
    return next;
  }, [persistedOtherTexts, questions, secretOtherTexts]);
  const [submitting, setSubmitting] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const otherTextareaRef = useRef<HTMLTextAreaElement>(null);
  const otherPasswordInputRef = useRef<HTMLInputElement>(null);

  const currentQuestion = questions[currentTab];
  const isLastQuestion = currentTab === questions.length - 1;
  const currentQuestionKey = currentQuestion
    ? getQuestionAnswerKey(currentQuestion)
    : "";
  const currentAnswer = currentQuestion
    ? answers[currentQuestionKey]
    : undefined;
  const isDirectInput = currentQuestion?.options.length === 0;
  const isOtherSelected = includesAnswer(currentAnswer, OTHER_ANSWER);
  const canAdvance = currentQuestion
    ? canLeaveQuestion(
        currentQuestion,
        currentAnswer,
        otherTexts[currentQuestionKey],
      )
    : false;

  const allRequiredAnswered = questions.every((q) => {
    const key = getQuestionAnswerKey(q);
    return canLeaveQuestion(q, answers[key], otherTexts[key]);
  });
  const canSubmit =
    input?.allowPartialSubmission === true || allRequiredAnswered;

  // A new provider request can reuse the mounted panel; reset provider defaults.
  // biome-ignore lint/correctness/useExhaustiveDependencies: request.id identifies the request lifecycle
  useEffect(() => {
    setCurrentTab(0);
    setAnswers(getDefaultAnswers(questions));
    setSecretOtherTexts({});
    for (const question of questions) {
      if (question.inputType === "password") {
        setPersistedOtherText(getQuestionAnswerKey(question), "");
      }
    }
    setCollapsed(false);
  }, [request.id]);

  // Focus the "other" input when it's selected and scroll it into view
  useEffect(() => {
    const otherInput =
      otherTextareaRef.current ?? otherPasswordInputRef.current;
    if (!isDirectInput && isOtherSelected && otherInput) {
      otherInput.focus();
      // Scroll input into view after a short delay to allow keyboard to open
      const timeout = setTimeout(() => {
        const currentOtherInput =
          otherTextareaRef.current ?? otherPasswordInputRef.current;
        currentOtherInput?.scrollIntoView?.({
          behavior: "smooth",
          block: "center",
        });
      }, 100);

      return () => clearTimeout(timeout);
    }
  }, [isDirectInput, isOtherSelected]);

  const handleSelectOption = useCallback(
    (optionLabel: string) => {
      if (readOnly) return;
      if (!currentQuestion) return;
      const key = getQuestionAnswerKey(currentQuestion);
      setAnswers((prev) => {
        if (!currentQuestion.multiSelect) {
          return { ...prev, [key]: optionLabel };
        }

        const previousAnswer = prev[key];
        const selected = Array.isArray(previousAnswer)
          ? previousAnswer
          : previousAnswer
            ? [previousAnswer]
            : [];
        const nextAnswer = selected.includes(optionLabel)
          ? selected.filter((value) => value !== optionLabel)
          : [...selected, optionLabel];

        if (nextAnswer.length === 0) {
          const next = { ...prev };
          delete next[key];
          return next;
        }
        return { ...prev, [key]: nextAnswer };
      });
    },
    [currentQuestion, readOnly],
  );

  const handleOtherTextChange = useCallback(
    (text: string) => {
      if (!currentQuestion) return;
      const key = getQuestionAnswerKey(currentQuestion);
      if (currentQuestion.inputType === "password") {
        setSecretOtherTexts((previous) => {
          const next = { ...previous };
          if (text) next[key] = text;
          else delete next[key];
          return next;
        });
        return;
      }
      setPersistedOtherText(key, text);
    },
    [currentQuestion, setPersistedOtherText],
  );

  const handleDirectInputChange = useCallback(
    (text: string) => {
      if (readOnly || !currentQuestion) return;
      const key = getQuestionAnswerKey(currentQuestion);
      setAnswers((previous) => {
        if (text.length > 0) return { ...previous, [key]: text };
        const next = { ...previous };
        delete next[key];
        return next;
      });
    },
    [currentQuestion, readOnly],
  );

  const advanceToNext = useCallback(() => {
    if (!isLastQuestion) {
      setCurrentTab((prev) => prev + 1);
    }
  }, [isLastQuestion]);

  const handleSubmit = useCallback(async () => {
    if (readOnly || !canSubmit || submitting) return;

    // Build final answers, replacing __other__ with actual text
    const finalAnswers: UserQuestionAnswers = {};
    for (const q of questions) {
      const key = getQuestionAnswerKey(q);
      const answer = answers[key];
      if (Array.isArray(answer)) {
        finalAnswers[key] = answer.map((value) =>
          value === OTHER_ANSWER ? otherTexts[key] || "" : value,
        );
      } else if (answer === OTHER_ANSWER) {
        finalAnswers[key] = otherTexts[key] || "";
      } else if (answer) {
        finalAnswers[key] = answer;
      }
    }

    setSubmitting(true);
    try {
      await onSubmit(finalAnswers);
      // Clear "Other" drafts from localStorage on successful submit
      clearPersistedOtherTexts();
      setSecretOtherTexts({});
    } finally {
      setSubmitting(false);
    }
  }, [
    canSubmit,
    submitting,
    questions,
    answers,
    otherTexts,
    onSubmit,
    clearPersistedOtherTexts,
    readOnly,
  ]);

  const handleDeny = useCallback(async () => {
    if (readOnly) return;
    setSubmitting(true);
    try {
      await onDeny();
    } finally {
      setSubmitting(false);
    }
  }, [onDeny, readOnly]);

  // Keyboard handling
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (submitting) return;
      if (readOnly) return;

      // Escape to deny
      if (e.key === "Escape") {
        e.preventDefault();
        handleDeny();
        return;
      }

      // Enter behavior depends on context
      if (e.key === "Enter" && !e.shiftKey) {
        // Confirming a CJK IME candidate also emits Enter. Android/WebKit may
        // expose that only as legacy keyCode 229, so guard both signals.
        if (e.isComposing || e.keyCode === 229) return;
        // The "Other" free-text area is a multiline textarea: Enter there only
        // inserts a newline and never submits. Free answers are submitted by
        // clicking the submit button, so IME word-picking can never trigger
        // an accidental submission while typing.
        if (e.target === otherTextareaRef.current) return;
        if ((isLastQuestion && canSubmit) || (!isLastQuestion && canAdvance)) {
          e.preventDefault();
          if (isLastQuestion && canSubmit) {
            handleSubmit();
          } else {
            advanceToNext();
          }
        }
      }

      // Tab/Shift+Tab to navigate between question tabs (when not in input)
      if (e.key === "Tab" && !isOtherSelected && !isDirectInput) {
        e.preventDefault();
        if (e.shiftKey) {
          setCurrentTab((prev) => Math.max(0, prev - 1));
        } else {
          setCurrentTab((prev) => Math.min(questions.length - 1, prev + 1));
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    submitting,
    canAdvance,
    isLastQuestion,
    canSubmit,
    isOtherSelected,
    isDirectInput,
    questions.length,
    handleDeny,
    handleSubmit,
    advanceToNext,
    readOnly,
  ]);

  if (!questions.length) {
    return (
      <div className="question-panel-wrapper">
        <div className="question-panel">
          <div className="question-panel-empty">
            {t("questionPanelNoQuestions")}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="question-panel-wrapper">
      {/* Floating toggle button */}
      <button
        type="button"
        className="question-panel-toggle"
        onClick={() => setCollapsed(!collapsed)}
        aria-label={
          collapsed ? t("questionPanelExpand") : t("questionPanelCollapse")
        }
        aria-expanded={!collapsed}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={collapsed ? "chevron-up" : "chevron-down"}
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {!collapsed && (
        <div className="question-panel">
          {subagentOriginTitle && (
            <div className="question-panel-subagent-origin">
              {t("subagentQuestionOrigin", { title: subagentOriginTitle })}
            </div>
          )}
          {/* Tab bar */}
          <div className="question-tabs">
            {questions.map((q, idx) => {
              const isActive = idx === currentTab;
              const key = getQuestionAnswerKey(q);
              const isAnswered = hasAnswer(answers[key], otherTexts[key]);
              return (
                <button
                  key={q.id || `${q.question}-${idx}`}
                  type="button"
                  className={`question-tab ${isActive ? "active" : ""} ${isAnswered ? "answered" : ""}`}
                  onClick={() => setCurrentTab(idx)}
                >
                  {isAnswered && <span className="question-tab-check">✓</span>}
                  {q.header}
                </button>
              );
            })}
          </div>

          {/* Current question */}
          {currentQuestion && (
            <div className="question-content">
              <div className="question-text">{currentQuestion.question}</div>

              <div className="question-options-list">
                {isDirectInput ? (
                  <div className="question-other-input question-direct-input">
                    <input
                      type={currentQuestion.inputType ?? "text"}
                      placeholder={t("questionPanelTypeAnswer")}
                      value={
                        typeof currentAnswer === "string" ? currentAnswer : ""
                      }
                      onChange={(event) =>
                        handleDirectInputChange(event.target.value)
                      }
                      required={currentQuestion.required !== false}
                      disabled={readOnly}
                    />
                  </div>
                ) : (
                  currentQuestion.options.map((option) => {
                    const optionValue = getOptionValue(option);
                    const isSelected = includesAnswer(
                      currentAnswer,
                      optionValue,
                    );
                    return (
                      <button
                        key={optionValue}
                        type="button"
                        className={`question-option-btn ${isSelected ? "selected" : ""}`}
                        onClick={() => handleSelectOption(optionValue)}
                        disabled={readOnly}
                      >
                        <span className="question-option-radio">
                          {currentQuestion.multiSelect
                            ? isSelected
                              ? "☑"
                              : "☐"
                            : isSelected
                              ? "●"
                              : "○"}
                        </span>
                        <div className="question-option-text">
                          <span className="question-option-label">
                            {option.label}
                          </span>
                          {option.description && (
                            <span className="question-option-desc">
                              {option.description}
                            </span>
                          )}
                        </div>
                      </button>
                    );
                  })
                )}

                {/* Other option */}
                {!isDirectInput &&
                  !readOnly &&
                  currentQuestion.custom !== false && (
                    <button
                      type="button"
                      className={`question-option-btn other ${isOtherSelected ? "selected" : ""}`}
                      onClick={() => handleSelectOption(OTHER_ANSWER)}
                    >
                      <span className="question-option-radio">
                        {currentQuestion.multiSelect
                          ? isOtherSelected
                            ? "☑"
                            : "☐"
                          : isOtherSelected
                            ? "●"
                            : "○"}
                      </span>
                      <div className="question-option-text">
                        <span className="question-option-label">
                          {t("questionPanelOther")}
                        </span>
                      </div>
                    </button>
                  )}

                {/* Other text input */}
                {!isDirectInput && isOtherSelected && (
                  <div className="question-other-input">
                    {currentQuestion.inputType === "password" ? (
                      <input
                        ref={otherPasswordInputRef}
                        type="password"
                        placeholder={t("questionPanelTypeAnswer")}
                        value={otherTexts[currentQuestionKey] || ""}
                        onChange={(e) => handleOtherTextChange(e.target.value)}
                      />
                    ) : (
                      <textarea
                        ref={otherTextareaRef}
                        rows={3}
                        placeholder={t("questionPanelTypeAnswer")}
                        value={otherTexts[currentQuestionKey] || ""}
                        onChange={(e) => handleOtherTextChange(e.target.value)}
                      />
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Actions */}
          {readOnly ? (
            <div className="question-panel-readonly">
              {readOnlyNotice ?? t("questionPanelExternalReadonly")}
            </div>
          ) : (
            <div className="question-actions">
              <button
                type="button"
                className="question-btn deny"
                onClick={handleDeny}
                disabled={submitting}
              >
                {t("questionPanelCancel")}
                <kbd>esc</kbd>
              </button>

              {isLastQuestion ? (
                <button
                  type="button"
                  className="question-btn submit"
                  onClick={handleSubmit}
                  disabled={!canSubmit || submitting}
                >
                  {t("questionPanelSubmit")}
                  <kbd>↵</kbd>
                </button>
              ) : (
                <button
                  type="button"
                  className="question-btn next"
                  onClick={advanceToNext}
                  disabled={!canAdvance || submitting}
                >
                  {t("questionPanelNext")}
                  <kbd>↵</kbd>
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
