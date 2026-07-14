import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { UserQuestionAnswers } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import type { InputRequest } from "../../types";
import { QuestionAnswerPanel } from "../QuestionAnswerPanel";
import type { Question } from "../renderers/tools/types";

function renderPanel(questions: Question[], requestId = "request-1") {
  const onSubmit = vi.fn(async (_answers: UserQuestionAnswers) => undefined);
  const onDeny = vi.fn(async () => undefined);
  const request: InputRequest = {
    id: requestId,
    sessionId: "session-1",
    type: "question",
    prompt: questions[0]?.question ?? "Question",
    toolName: "AskUserQuestion",
    toolInput: { questions },
    timestamp: "2026-07-14T00:00:00.000Z",
  };

  const view = render(
    <I18nProvider>
      <QuestionAnswerPanel
        request={request}
        sessionId="session-1"
        onSubmit={onSubmit}
        onDeny={onDeny}
      />
    </I18nProvider>,
  );

  return { onSubmit, ...view };
}

describe("QuestionAnswerPanel", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it("submits every toggled option for a multi-select question", async () => {
    const { onSubmit } = renderPanel([
      {
        id: "question-multi",
        question: "Which checks should run?",
        header: "Checks",
        options: [
          { label: "Lint", description: "Run lint" },
          { label: "Test", description: "Run tests" },
        ],
        multiSelect: true,
        custom: false,
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: /Lint/ }));
    fireEvent.click(screen.getByRole("button", { name: /Test/ }));
    fireEvent.click(screen.getByRole("button", { name: /Submit/ }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        "question-multi": ["Lint", "Test"],
      });
    });
  });

  it("keeps answers separate when question text is identical but ids differ", async () => {
    const { onSubmit } = renderPanel([
      {
        id: "question-first",
        question: "Continue?",
        header: "First",
        options: [{ label: "First answer", description: "For the first" }],
        multiSelect: false,
        custom: false,
      },
      {
        id: "question-second",
        question: "Continue?",
        header: "Second",
        options: [{ label: "Second answer", description: "For the second" }],
        multiSelect: false,
        custom: false,
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: /First answer/ }));
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    fireEvent.click(screen.getByRole("button", { name: /Second answer/ }));
    fireEvent.click(screen.getByRole("button", { name: /Submit/ }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        "question-first": "First answer",
        "question-second": "Second answer",
      });
    });
  });

  it("hides the Other choice when custom answers are disabled", () => {
    renderPanel([
      {
        id: "question-closed",
        question: "Choose one",
        header: "Choice",
        options: [{ label: "Only", description: "The only choice" }],
        multiSelect: false,
        custom: false,
      },
    ]);

    expect(screen.queryByText("Other")).toBeNull();
  });

  it("does not reuse an Other draft from a different request", () => {
    const questions: Question[] = [
      {
        id: "question-0",
        question: "Choose one",
        header: "Choice",
        options: [{ label: "Listed", description: "A listed choice" }],
        multiSelect: false,
      },
    ];
    const first = renderPanel(questions, "request-first");

    fireEvent.click(screen.getByRole("button", { name: /Other/ }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "First request draft" },
    });
    first.unmount();

    renderPanel(questions, "request-second");
    fireEvent.click(screen.getByRole("button", { name: /Other/ }));

    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("");
  });
});
