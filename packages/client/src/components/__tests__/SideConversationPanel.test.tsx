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
        parentStatus="Running"
        visible
        mobile
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
      path: `/data/uploads/project/main/${file.name}`,
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
        path: "/data/uploads/project/main/shot.png",
        name: "shot.png",
        mimeType: "image/png",
      },
    ],
  );
});
