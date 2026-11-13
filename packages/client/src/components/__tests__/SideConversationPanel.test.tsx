import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { useSideConversation } from "../../hooks/useSideConversation";
import { I18nProvider } from "../../i18n";
import { UI_KEYS } from "../../lib/storageKeys";
import { serializeComposerContent } from "../AttachmentComposer";
import { SideConversationPanel } from "../SideConversationPanel";

const { upload } = vi.hoisted(() => ({
  upload: vi.fn(),
}));
vi.mock("../../hooks/useConnection", () => ({
  useConnection: () => ({ upload, fetchBlob: vi.fn() }),
}));
vi.mock("../VoiceInputButton", () => ({ VoiceInputButton: () => null }));

function typeInto(editor: HTMLElement, value: string) {
  editor.focus();
  editor.textContent = value;
  fireEvent.input(editor, { inputType: "insertText", data: value });
}

vi.mock("../blocks/TextBlock", () => ({
  TextBlock: ({ text }: { text: string }) => <p>{text}</p>,
}));
beforeEach(() => {
  upload.mockReset();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    queueMicrotask(() => callback(0));
    return 0;
  });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

function fixture(
  overrides: Partial<ReturnType<typeof useSideConversation>> = {},
  {
    mobile = true,
    provider = "pi",
  }: { mobile?: boolean; provider?: string } = {},
) {
  localStorage.setItem(UI_KEYS.locale, "en");
  const side: ReturnType<typeof useSideConversation> = {
    supported: true,
    capabilities: { images: false },
    availability: "ready",
    error: undefined,
    busy: false,
    conversation: {
      id: "side",
      parentSessionId: "main",
      capturedAt: "2026-10-10T00:00:00Z",
      context: "snapshot",
      status: "idle",
      version: 1,
      messages: [{ id: "a", role: "assistant", text: "A side answer" }],
    },
    send: vi.fn(async () => true),
    close: vi.fn(async () => {}),
    startNew: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => undefined),
    ...overrides,
  };
  const onClose = vi.fn();
  const onBringBack = vi.fn();
  const view = render(
    <I18nProvider>
      <SideConversationPanel
        side={side}
        projectId="project"
        sessionId="main"
        provider={provider}
        parentStatus="Running"
        visible
        mobile={mobile}
        onClose={onClose}
        onBringBack={onBringBack}
      />
    </I18nProvider>,
  );
  return { side, view, onClose, onBringBack };
}

it("keeps return/hide separate from stop and makes handoff a draft-only action", () => {
  const { side, onClose, onBringBack } = fixture();
  fireEvent.click(screen.getByRole("button", { name: "Back to main task" }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(side.interrupt).not.toHaveBeenCalled();
  expect(side.close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Bring to main input" }));
  expect(onBringBack).toHaveBeenCalledWith("A side answer");
  expect(side.send).not.toHaveBeenCalled();
});

it("preserves the question after failure and never submits while composing with IME", async () => {
  const { side } = fixture();
  vi.mocked(side.send).mockResolvedValue(false);
  const input = screen.getByRole("textbox");
  typeInto(input, "side question");
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(side.send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(side.send).toHaveBeenCalled());
  await waitFor(() =>
    expect(serializeComposerContent(input)).toBe("side question"),
  );
  expect(side.send).toHaveBeenCalledWith("side question", "snapshot", []);
});

it("keeps a writable independent draft when the runtime has no side endpoint", () => {
  const { side } = fixture({
    supported: false,
    availability: "unsupported",
    conversation: undefined,
  });
  expect(screen.getByRole("status").textContent).toContain(
    "server needs an update",
  );
  const input = screen.getByRole("textbox");
  expect(input.getAttribute("aria-disabled")).toBe("false");
  typeInto(input, "parallel question");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(serializeComposerContent(input)).toBe("parallel question");
  expect(side.send).not.toHaveBeenCalled();
  expect(
    (screen.getByRole("button", { name: "Send" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

it("renders side steps with the main transcript rows instead of one empty entry per step", () => {
  const { onBringBack } = fixture({
    conversation: {
      id: "side",
      parentSessionId: "main",
      capturedAt: "2026-10-10T00:00:00Z",
      context: "snapshot",
      status: "idle",
      version: 3,
      messages: [
        { id: "q", role: "user", text: "what is deepswe?" },
        {
          id: "step-1",
          role: "assistant",
          text: "Let me look.",
          blocks: [
            { type: "thinking", thinking: "Need the README" },
            { type: "text", text: "Let me look." },
            {
              type: "tool_use",
              id: "call-1",
              name: "Grep",
              input: { pattern: "deepswe" },
              result: { content: "README.md:1:deepswe" },
            },
          ],
        },
        {
          id: "step-2",
          role: "assistant",
          text: "A benchmark.",
          blocks: [{ type: "text", text: "A benchmark." }],
        },
      ],
    },
  });
  expect(screen.queryByText("Assistant")).toBeNull();
  expect(
    document.querySelectorAll('[data-render-type="user_prompt"]'),
  ).toHaveLength(1);
  expect(
    document.querySelectorAll('[data-render-type="thinking"]'),
  ).toHaveLength(1);
  expect(
    document.querySelectorAll('[data-render-type="tool_call"]'),
  ).toHaveLength(1);
  // One turn, one handoff: interim narration before the tool stays behind.
  const handoffs = screen.getAllByRole("button", {
    name: "Bring to main input",
  });
  expect(handoffs).toHaveLength(1);
  fireEvent.click(handoffs[0] as HTMLElement);
  expect(onBringBack).toHaveBeenCalledWith("A benchmark.");
});

it.each([true, false])(
  "excludes explicit progress from handoff, including turns without a final answer (answer: %s)",
  (hasAnswer) => {
    const { onBringBack } = fixture(
      {
        conversation: {
          id: "side",
          parentSessionId: "main",
          capturedAt: "2026-10-10T00:00:00Z",
          context: "snapshot",
          status: hasAnswer ? "idle" : "failed",
          version: 3,
          messages: [
            { id: "q", role: "user", text: "Explain this" },
            {
              id: "progress",
              role: "assistant",
              text: "Checking the context.",
              phase: "commentary",
              blocks: [{ type: "text", text: "Checking the context." }],
            },
            ...(hasAnswer
              ? [
                  {
                    id: "answer",
                    role: "assistant" as const,
                    text: "The answer.",
                    phase: "final_answer" as const,
                    blocks: [{ type: "text" as const, text: "The answer." }],
                  },
                ]
              : []),
          ],
        },
      },
      { provider: "codex" },
    );
    expect(screen.getByText("Checking the context.")).toBeTruthy();
    const handoffs = screen.queryAllByRole("button", {
      name: "Bring to main input",
    });
    expect(handoffs).toHaveLength(hasAnswer ? 1 : 0);
    if (hasAnswer) {
      fireEvent.click(handoffs[0] as HTMLElement);
      expect(onBringBack).toHaveBeenCalledWith("The answer.");
    }
  },
);

it("hides the handoff while the side reply is still running", () => {
  fixture({
    conversation: {
      id: "side",
      parentSessionId: "main",
      capturedAt: "2026-10-10T00:00:00Z",
      context: "snapshot",
      status: "running",
      version: 2,
      messages: [
        { id: "q", role: "user", text: "why?" },
        {
          id: "a",
          role: "assistant",
          text: "Partial",
          blocks: [{ type: "text", text: "Partial" }],
        },
      ],
    },
  });
  expect(
    screen.queryByRole("button", { name: "Bring to main input" }),
  ).toBeNull();
  expect(screen.getByRole("button", { name: "Stop side reply" })).toBeDefined();
});

it("hides image attachment when the side provider cannot read images", () => {
  fixture();
  expect(screen.queryByRole("button", { name: "Attach images" })).toBeNull();
});

it("uploads only images and sends them with the side question", async () => {
  upload.mockImplementation(
    async (_project: string, _session: string, file: File) => ({
      id: "upload-1",
      name: `123e4567-e89b-12d3-a456-426614174000_${file.name}`,
      originalName: file.name,
      mimeType: file.type,
      size: file.size,
      ref: `/api/projects/cA/sessions/main/upload/123e4567-e89b-12d3-a456-426614174000_${file.name}`,
    }),
  );
  const { side } = fixture({ capabilities: { images: true } });
  expect(screen.getByRole("button", { name: "Attach images" })).toBeDefined();
  const picker = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!picker) throw new Error("Missing file picker");
  fireEvent.change(picker, {
    target: {
      files: [
        new File(["png"], "shot.png", { type: "image/png" }),
        new File(["%PDF"], "notes.pdf", { type: "application/pdf" }),
      ],
    },
  });
  await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
  expect(upload.mock.calls[0]?.[2].name).toBe("shot.png");
  const input = screen.getByRole("textbox");
  await waitFor(() =>
    expect(serializeComposerContent(input)).toContain("@[shot.png]"),
  );
  input.appendChild(document.createTextNode("what is this?"));
  fireEvent.input(input, { inputType: "insertText", data: "what is this?" });
  expect(serializeComposerContent(input)).not.toContain("notes.pdf");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(side.send).toHaveBeenCalled());
  expect(side.send).toHaveBeenCalledWith(
    expect.stringContaining("what is this?"),
    "snapshot",
    [
      {
        ref: "/api/projects/cA/sessions/main/upload/123e4567-e89b-12d3-a456-426614174000_shot.png",
        name: "shot.png",
        mimeType: "image/png",
      },
    ],
  );
});

it("resizes the desktop split from its left edge and remembers the width", () => {
  vi.stubGlobal("innerWidth", 1600);
  vi.stubGlobal("PointerEvent", MouseEvent);
  localStorage.removeItem(UI_KEYS.sideConversationWidthRatio);
  fixture({}, { mobile: false });
  const panel = document.getElementById("side-conversation-panel");
  const handle = screen.getByRole("separator", { name: "Resize side chat" });
  // Default split until the user drags: clamp(360px, 34vw, 480px).
  expect(panel?.style.getPropertyValue("--side-conversation-width")).toBe(
    "480px",
  );
  fireEvent.pointerDown(handle, {
    pointerId: 1,
    pointerType: "mouse",
    button: 0,
    clientX: 1120,
  });
  fireEvent.pointerMove(handle, {
    pointerId: 1,
    pointerType: "mouse",
    clientX: 1000,
  });
  fireEvent.pointerUp(handle, { pointerId: 1, pointerType: "mouse" });
  expect(panel?.style.getPropertyValue("--side-conversation-width")).toBe(
    "600px",
  );
  expect(localStorage.getItem(UI_KEYS.sideConversationWidthRatio)).toBe(
    "0.3750",
  );
  fireEvent.keyDown(handle, { key: "ArrowRight" });
  expect(panel?.style.getPropertyValue("--side-conversation-width")).toBe(
    "576px",
  );
  fireEvent.doubleClick(handle);
  expect(panel?.style.getPropertyValue("--side-conversation-width")).toBe(
    "480px",
  );
  expect(localStorage.getItem(UI_KEYS.sideConversationWidthRatio)).toBeNull();
});

it("keeps the full-screen mobile panel without a resize handle", () => {
  fixture();
  expect(screen.queryByRole("separator")).toBeNull();
  expect(
    document
      .getElementById("side-conversation-panel")
      ?.style.getPropertyValue("--side-conversation-width"),
  ).toBe("");
});
