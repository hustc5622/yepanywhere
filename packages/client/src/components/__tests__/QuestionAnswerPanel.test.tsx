import {
  cleanup,
  createEvent,
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
import type { AskUserQuestionInput, Question } from "../renderers/tools/types";

function renderPanel(
  questions: Question[],
  requestId = "request-1",
  inputOverrides: Partial<AskUserQuestionInput> = {},
) {
  const onSubmit = vi.fn(async (_answers: UserQuestionAnswers) => undefined);
  const onDeny = vi.fn(async () => undefined);
  const request: InputRequest = {
    id: requestId,
    sessionId: "session-1",
    type: "question",
    prompt: questions[0]?.question ?? "Question",
    toolName: "AskUserQuestion",
    toolInput: { questions, ...inputOverrides },
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

function replaceScrollIntoView(
  value: typeof Element.prototype.scrollIntoView | undefined,
): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "scrollIntoView",
  );
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value,
  });

  return () => {
    if (descriptor) {
      Object.defineProperty(Element.prototype, "scrollIntoView", descriptor);
    } else {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
  };
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

  it("does not require scrollIntoView to be implemented", () => {
    vi.useFakeTimers();
    const restoreScrollIntoView = replaceScrollIntoView(undefined);

    try {
      renderPanel([
        {
          id: "question-no-scroll",
          question: "Choose one",
          header: "Choice",
          options: [{ label: "Listed", description: "A listed choice" }],
          multiSelect: false,
        },
      ]);

      fireEvent.click(screen.getByRole("button", { name: /Other/ }));

      expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    } finally {
      cleanup();
      restoreScrollIntoView();
      vi.useRealTimers();
    }
  });

  it("cancels pending Other scrolling when the panel unmounts", () => {
    vi.useFakeTimers();
    const scrollIntoView = vi.fn();
    const restoreScrollIntoView = replaceScrollIntoView(scrollIntoView);

    try {
      const { unmount } = renderPanel([
        {
          id: "question-unmounted-scroll",
          question: "Choose one",
          header: "Choice",
          options: [{ label: "Listed", description: "A listed choice" }],
          multiSelect: false,
        },
      ]);

      fireEvent.click(screen.getByRole("button", { name: /Other/ }));
      unmount();
      vi.advanceTimersByTime(100);

      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      cleanup();
      restoreScrollIntoView();
      vi.useRealTimers();
    }
  });

  it("submits provider values and typed MCP form fields", async () => {
    const { onSubmit } = renderPanel([
      {
        id: "environment",
        question: "Choose the target",
        header: "Environment",
        options: [
          { label: "Staging", description: "Preview", value: "staging" },
          {
            label: "Production",
            description: "Live traffic",
            value: "production",
          },
        ],
        multiSelect: false,
        custom: false,
        required: true,
      },
      {
        id: "replicas",
        question: "Number of replicas",
        header: "Replicas",
        options: [],
        multiSelect: false,
        custom: true,
        required: true,
        inputType: "number",
        defaultValue: "2",
      },
      {
        id: "note",
        question: "Optional note",
        header: "Note",
        options: [],
        multiSelect: false,
        custom: true,
        required: false,
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: /Production/ }));
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    const replicas = screen.getByRole("spinbutton") as HTMLInputElement;
    expect(replicas.value).toBe("2");
    fireEvent.change(replicas, { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    fireEvent.click(screen.getByRole("button", { name: /Submit/ }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        environment: "production",
        replicas: "3",
      });
    });
  });

  it("allows Codex to submit unanswered questions when partial answers are enabled", async () => {
    const { onSubmit } = renderPanel(
      [
        {
          id: "secret",
          question: "Enter a token or skip",
          header: "Token",
          options: [],
          multiSelect: false,
          custom: true,
          required: true,
          inputType: "password",
        },
      ],
      "request-partial",
      { allowPartialSubmission: true },
    );

    const input = screen.getByPlaceholderText(/answer/i) as HTMLInputElement;
    expect(input.type).toBe("text");
    fireEvent.click(screen.getByRole("button", { name: /Submit/ }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({}));
  });

  it("never persists secret Other answers to localStorage", () => {
    renderPanel(
      [
        {
          id: "secret-choice",
          question: "Choose or enter a secret",
          header: "Secret",
          options: [
            { label: "Use stored token", description: "From keychain" },
          ],
          multiSelect: false,
          custom: true,
          required: true,
          inputType: "password",
        },
      ],
      "request-secret-other",
    );

    fireEvent.click(screen.getByRole("button", { name: /Other/ }));
    const input = screen.getByPlaceholderText(/answer/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "do-not-store-me" } });

    expect(input.value).toBe("do-not-store-me");
    expect(input.type).toBe("text");
    expect(
      Array.from({ length: localStorage.length }, (_, index) =>
        localStorage.getItem(localStorage.key(index) ?? ""),
      ).some((value) => value?.includes("do-not-store-me")),
    ).toBe(false);
  });

  it("does not submit when Enter is confirming an IME candidate", async () => {
    const { onSubmit } = renderPanel([
      {
        id: "question-ime",
        question: "Describe the change",
        header: "Details",
        options: [{ label: "Listed", description: "Use the listed answer" }],
        multiSelect: false,
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: /Other/ }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "还在输入" },
    });

    fireEvent.keyDown(window, { key: "Enter", isComposing: true });
    fireEvent.keyDown(window, { key: "Enter", keyCode: 229 });
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Enter" });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  });

  it("lets plain Enter insert a newline in the Other textarea instead of submitting", () => {
    const { onSubmit } = renderPanel([
      {
        id: "question-multiline",
        question: "Describe the change",
        header: "Details",
        options: [{ label: "Listed", description: "Use the listed answer" }],
        multiSelect: false,
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: /Other/ }));
    const textarea = screen.getByRole("textbox");
    expect(textarea.tagName).toBe("TEXTAREA");
    fireEvent.change(textarea, { target: { value: "第一行" } });

    const enter = createEvent.keyDown(textarea, { key: "Enter" });
    fireEvent(textarea, enter);

    // Not prevented => the browser default (inserting a newline) proceeds.
    expect(enter.defaultPrevented).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not submit on IME candidate Enter targeted at the Other textarea", () => {
    const { onSubmit } = renderPanel([
      {
        id: "question-ime-target",
        question: "Describe the change",
        header: "Details",
        options: [{ label: "Listed", description: "Use the listed answer" }],
        multiSelect: false,
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: /Other/ }));
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "还在输入" } });

    fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });
    fireEvent.keyDown(textarea, { key: "Enter", keyCode: 229 });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits the complete multi-line Other answer only via the submit button", async () => {
    const { onSubmit } = renderPanel([
      {
        id: "question-multiline-submit",
        question: "Describe the change",
        header: "Details",
        options: [{ label: "Listed", description: "Use the listed answer" }],
        multiSelect: false,
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: /Other/ }));
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "第一行\n第二行" } });

    // Enter inside the textarea must not submit, even without IME flags.
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Submit/ }));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        "question-multiline-submit": "第一行\n第二行",
      });
    });
  });
});
