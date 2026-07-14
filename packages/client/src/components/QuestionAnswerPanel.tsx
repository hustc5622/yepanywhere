import type {
  UserQuestionAnswer,
  UserQuestionAnswers,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuestionOtherDrafts } from "../hooks/useDrafts";
import { useI18n } from "../i18n";
import type { InputRequest } from "../types";
import type { AskUserQuestionInput, Question } from "./renderers/tools/types";

const OTHER_ANSWER = "__other__";

function getQuestionAnswerKey(question: Question): string {
  return question.id || question.question;
}

function includesAnswer(
  answer: UserQuestionAnswer | undefined,
  value: string,
): boolean {
  return Array.isArray(answer) ? answer.includes(value) : answer === value;
}

function hasCompleteAnswer(
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

  const [currentTab, setCurrentTab] = useState(0);
  const [answers, setAnswers] = useState<UserQuestionAnswers>({});
  // Persist "Other" text inputs to localStorage for this question request.
  const [otherTexts, setOtherText, clearOtherTexts] = useQuestionOtherDrafts(
    sessionId,
    request.id,
  );
  const [submitting, setSubmitting] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const otherInputRef = useRef<HTMLInputElement>(null);

  const currentQuestion = questions[currentTab];
  const isLastQuestion = currentTab === questions.length - 1;
  const currentQuestionKey = currentQuestion
    ? getQuestionAnswerKey(currentQuestion)
    : "";
  const currentAnswer = currentQuestion
    ? answers[currentQuestionKey]
    : undefined;
  const isOtherSelected = includesAnswer(currentAnswer, OTHER_ANSWER);
  const currentAnswered = hasCompleteAnswer(
    currentAnswer,
    otherTexts[currentQuestionKey],
  );

  // Check if all questions are answered
  const allAnswered = questions.every((q) => {
    const key = getQuestionAnswerKey(q);
    return hasCompleteAnswer(answers[key], otherTexts[key]);
  });

  // Focus the "other" input when it's selected and scroll it into view
  useEffect(() => {
    if (isOtherSelected && otherInputRef.current) {
      otherInputRef.current.focus();
      // Scroll input into view after a short delay to allow keyboard to open
      setTimeout(() => {
        otherInputRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
      }, 100);
    }
  }, [isOtherSelected]);

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
      setOtherText(getQuestionAnswerKey(currentQuestion), text);
    },
    [currentQuestion, setOtherText],
  );

  const advanceToNext = useCallback(() => {
    if (!isLastQuestion) {
      setCurrentTab((prev) => prev + 1);
    }
  }, [isLastQuestion]);

  const handleSubmit = useCallback(async () => {
    if (readOnly || !allAnswered || submitting) return;

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
      clearOtherTexts();
    } finally {
      setSubmitting(false);
    }
  }, [
    allAnswered,
    submitting,
    questions,
    answers,
    otherTexts,
    onSubmit,
    clearOtherTexts,
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
        // If "other" is selected and has text, or a regular option is selected
        if (currentAnswered) {
          e.preventDefault();
          if (isLastQuestion && allAnswered) {
            handleSubmit();
          } else {
            advanceToNext();
          }
        }
      }

      // Tab/Shift+Tab to navigate between question tabs (when not in input)
      if (e.key === "Tab" && !isOtherSelected) {
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
    currentAnswered,
    isLastQuestion,
    allAnswered,
    isOtherSelected,
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
          {/* Tab bar */}
          <div className="question-tabs">
            {questions.map((q, idx) => {
              const isActive = idx === currentTab;
              const key = getQuestionAnswerKey(q);
              const isAnswered = hasCompleteAnswer(
                answers[key],
                otherTexts[key],
              );
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
                {currentQuestion.options.map((option) => {
                  const isSelected = includesAnswer(
                    currentAnswer,
                    option.label,
                  );
                  return (
                    <button
                      key={option.label}
                      type="button"
                      className={`question-option-btn ${isSelected ? "selected" : ""}`}
                      onClick={() => handleSelectOption(option.label)}
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
                })}

                {/* Other option */}
                {!readOnly && currentQuestion.custom !== false && (
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
                {isOtherSelected && (
                  <div className="question-other-input">
                    <input
                      ref={otherInputRef}
                      type="text"
                      placeholder={t("questionPanelTypeAnswer")}
                      value={otherTexts[currentQuestionKey] || ""}
                      onChange={(e) => handleOtherTextChange(e.target.value)}
                    />
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
                  disabled={!allAnswered || submitting}
                >
                  {t("questionPanelSubmit")}
                  <kbd>↵</kbd>
                </button>
              ) : (
                <button
                  type="button"
                  className="question-btn next"
                  onClick={advanceToNext}
                  disabled={!currentAnswered || submitting}
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
