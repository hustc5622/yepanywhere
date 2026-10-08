import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ProviderInfo, UploadedFile } from "@yep-anywhere/shared";
import { useRef, useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ServerSettings, api } from "../../api/client";
import { ToastProvider } from "../../contexts/ToastContext";
import { useProviders } from "../../hooks/useProviders";
import { useServerSettings } from "../../hooks/useServerSettings";
import { I18nProvider } from "../../i18n";
import { serializeComposerContent } from "../AttachmentComposer";
import { MessageInput } from "../MessageInput";
import { NewSessionForm } from "../NewSessionForm";

const { upload } = vi.hoisted(() => ({
  upload:
    vi.fn<
      (
        projectId: string,
        sessionId: string,
        file: File,
      ) => Promise<UploadedFile>
    >(),
}));

vi.mock("../../hooks/useConnection", () => ({
  useConnection: () => ({ upload }),
}));
vi.mock("../../hooks/useProviders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useProviders")>()),
  useProviders: vi.fn(),
}));
vi.mock("../../hooks/useServerSettings", () => ({
  useServerSettings: vi.fn(),
}));
vi.mock("../VoiceInputButton", () => ({ VoiceInputButton: () => null }));

const provider: ProviderInfo = {
  name: "claude",
  displayName: "Claude",
  installed: true,
  authenticated: true,
  enabled: true,
  supportsPermissionMode: false,
  supportsThinkingToggle: false,
};

function uploadedFile(file: File): UploadedFile {
  const id = crypto.randomUUID();
  return {
    id,
    name: `${id}_${file.name}`,
    originalName: file.name,
    mimeType: file.type,
    size: file.size,
    path: `/tmp/${id}_${file.name}`,
  };
}

type Entry = "reply" | "new session" | "compact new session";

function setup(entry: Entry) {
  const onSubmit = vi.fn<(text: string, files: File[]) => void>();
  function Reply() {
    const [files, setFiles] = useState<UploadedFile[]>([]);
    const sources = useRef(new Map<string, File>());
    const order = useRef<string[]>([]);
    const sortByOrder = (current: UploadedFile[]) =>
      current.sort(
        (left, right) =>
          order.current.indexOf(left.id) - order.current.indexOf(right.id),
      );
    return (
      <MessageInput
        draftKey="composer-flow-reply"
        projectId="test-project"
        sessionId="test-session"
        attachments={files}
        attachmentOrder={order.current}
        supportsPermissionMode={false}
        supportsThinkingToggle={false}
        onAttach={(selected, beforeId) => {
          const added = selected.map((file) => {
            const metadata = uploadedFile(file);
            sources.current.set(metadata.id, file);
            return metadata;
          });
          const anchor = beforeId ? order.current.indexOf(beforeId) : -1;
          order.current.splice(
            anchor < 0 ? order.current.length : anchor,
            0,
            ...added.map((file) => file.id),
          );
          setFiles((current) => sortByOrder([...current, ...added]));
        }}
        onRemoveAttachment={(id) =>
          setFiles((current) => current.filter((file) => file.id !== id))
        }
        onRestoreAttachment={(file) =>
          setFiles((current) => sortByOrder([...current, file]))
        }
        onSend={(text) =>
          onSubmit(
            text,
            files.map((file) => {
              const source = sources.current.get(file.id);
              if (!source) throw new Error("Missing attachment source");
              return source;
            }),
          )
        }
      />
    );
  }
  render(
    <MemoryRouter>
      <I18nProvider>
        <ToastProvider>
          {entry === "reply" ? (
            <Reply />
          ) : (
            <NewSessionForm
              projectId="test-project"
              compact={entry === "compact new session"}
            />
          )}
        </ToastProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
  return {
    composer: screen.getByRole("textbox"),
    async submit() {
      fireEvent.click(
        screen.getByRole("button", {
          name: entry === "reply" ? "Send" : "Start session",
        }),
      );
      if (entry === "reply") {
        expect(onSubmit).toHaveBeenCalledTimes(1);
        const submitted = onSubmit.mock.calls[0];
        if (!submitted) throw new Error("Missing reply submission");
        return { text: submitted[0], files: submitted[1] };
      }
      await waitFor(() => expect(api.queueMessage).toHaveBeenCalledTimes(1));
      const submitted = vi.mocked(api.queueMessage).mock.calls[0];
      expect(submitted?.[3]).toHaveLength(upload.mock.calls.length);
      return {
        text: submitted?.[1],
        files: upload.mock.calls.map((call) => call[2]),
      };
    },
  };
}

function selectRange(composer: HTMLElement, range: Range) {
  composer.focus();
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  fireEvent.select(composer);
}

function cards(composer: HTMLElement) {
  return Array.from(
    composer.querySelectorAll<HTMLElement>("[data-attachment-id]"),
  );
}

async function chooseFiles(files: File[]) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("Missing file picker");
  await act(async () => {
    fireEvent.change(input, { target: { files } });
  });
}

function image(name: string, content: string) {
  return new File([content], name, { type: "image/png" });
}

async function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

beforeEach(() => {
  localStorage.clear();
  upload.mockReset();
  upload.mockImplementation(async (_project, _session, file) =>
    uploadedFile(file),
  );
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = vi.fn(() => `blob:${crypto.randomUUID()}`);
      static revokeObjectURL = vi.fn();
    },
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    queueMicrotask(() => callback(0));
    return 0;
  });
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.mocked(useProviders).mockReturnValue({
    providers: [provider],
    loading: false,
    error: null,
    refetch: vi.fn(),
  });
  vi.mocked(useServerSettings).mockReturnValue({
    settings: { newSessionDefaults: { provider: "claude" } } as ServerSettings,
    isLoading: false,
    error: null,
    updateSetting: vi.fn(),
    refetch: vi.fn(),
  });
  vi.spyOn(api, "createSession").mockResolvedValue({
    sessionId: "test-session",
    processId: "test-process",
    permissionMode: "default",
    modeVersion: 0,
  });
  vi.spyOn(api, "queueMessage").mockResolvedValue({ queued: true });
});

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each<Entry>(["reply", "new session", "compact new session"])(
  "%s attachment editing",
  (entry) => {
    it("replaces the selected same-name image while preserving the following image and file order", async () => {
      const { composer, submit } = setup(entry);
      const original = image("shot.png", "original");
      const following = image("shot.png", "following");
      const replacement = image("shot.png", "replacement");
      await chooseFiles([original, following]);
      const [first, second] = cards(composer);
      if (!first || !second) throw new Error("Missing initial image cards");
      const firstId = first.dataset.attachmentId;
      const secondId = second.dataset.attachmentId;
      const range = document.createRange();
      range.selectNode(first);
      selectRange(composer, range);

      await chooseFiles([replacement]);

      expect(cards(composer)).toHaveLength(2);
      expect(cards(composer)[0]?.dataset.attachmentId).not.toBe(firstId);
      expect(cards(composer)[1]?.dataset.attachmentId).toBe(secondId);
      const submitted = await submit();
      expect(submitted.text?.match(/@\[shot\.png\]/g)).toHaveLength(2);
      expect(submitted.files).toHaveLength(2);
      expect(submitted.files[0]).toBe(replacement);
      expect(submitted.files[1]).toBe(following);
    });

    it("replaces selected text when pasting an ordinary clipboard image", async () => {
      const { composer, submit } = setup(entry);
      composer.textContent = "before selected after";
      fireEvent.input(composer);
      const text = composer.firstChild;
      if (!text) throw new Error("Missing editable text");
      const range = document.createRange();
      range.setStart(text, 7);
      range.setEnd(text, 15);
      selectRange(composer, range);
      const pasted = image("pasted.png", "clipboard bytes");

      await act(async () => {
        fireEvent.paste(composer, {
          clipboardData: {
            getData: () => "",
            items: [{ kind: "file", getAsFile: () => pasted }],
          },
        });
      });

      expect(serializeComposerContent(composer)).toBe(
        "before  @[pasted.png]  after",
      );
      expect(cards(composer)).toHaveLength(1);
      const submitted = await submit();
      expect(submitted.files).toHaveLength(1);
      expect(submitted.files[0]).toBe(pasted);
      expect(submitted.text).toBe("before  @[pasted.png]  after");
    });

    it("pastes all rich clipboard images once and reuses only tokens carried in the copied text", async () => {
      const { composer, submit } = setup(entry);
      const existing = image("shot.png", "existing");
      await chooseFiles([existing]);
      const before = serializeComposerContent(composer);
      const copied = "@[shot.png] compare @[shot.png]";
      await act(async () => {
        fireEvent.paste(composer, {
          clipboardData: {
            // A system clipboard may expose the same image through both formats.
            items: [
              { kind: "file", getAsFile: () => image("shot.png", "first") },
            ],
            getData: (type: string) =>
              type === "text/plain"
                ? copied
                : type === "text/html"
                  ? `<div data-yep-anywhere-user-input="1">
                      <img src="data:image/png;base64,Zmlyc3Q=" data-yep-anywhere-attachment-name="shot.png">
                      <img src="data:image/png;base64,c2Vjb25k" data-yep-anywhere-attachment-name="shot.png">
                      <img src="data:image/png;base64,dGhpcmQ=" data-yep-anywhere-attachment-name="extra.png">
                    </div>`
                  : "",
          },
        });
      });

      const pastedText = serializeComposerContent(composer);
      expect(pastedText).toContain(`${before}${copied}`);
      expect(pastedText.match(/@\[shot\.png\]/g)).toHaveLength(3);
      expect(pastedText.match(/@\[extra\.png\]/g)).toHaveLength(1);
      expect(cards(composer)).toHaveLength(4);
      const submitted = await submit();
      expect(submitted.text).toBe(pastedText.trim());
      expect(submitted.files.map((file) => file.name)).toEqual([
        "shot.png",
        "shot.png",
        "shot.png",
        "extra.png",
      ]);
      expect(await Promise.all(submitted.files.map(readFile))).toEqual([
        "existing",
        "first",
        "second",
        "third",
      ]);
    });

    it("restores the original file and order when native undo restores a deleted same-name card", async () => {
      const { composer, submit } = setup(entry);
      const firstFile = image("shot.png", "first");
      const secondFile = image("shot.png", "second");
      await chooseFiles([firstFile, secondFile]);
      const originalText = serializeComposerContent(composer);
      const originalCards = cards(composer);
      const firstCard = originalCards[0];
      if (!firstCard) throw new Error("Missing first image card");
      const after = firstCard.nextSibling;

      // jsdom has no native editing history. Apply the browser's atomic DOM
      // deletion/restoration and dispatch the corresponding native input event.
      firstCard.remove();
      fireEvent.input(composer, { inputType: "deleteContentBackward" });
      expect(cards(composer)).toHaveLength(1);
      expect(document.querySelector(".attachment-list")).toBeNull();
      composer.insertBefore(firstCard, after);
      fireEvent.input(composer, { inputType: "historyUndo" });

      expect(serializeComposerContent(composer)).toBe(originalText);
      expect(cards(composer).map((card) => card.dataset.attachmentId)).toEqual(
        originalCards.map((card) => card.dataset.attachmentId),
      );
      const submitted = await submit();
      expect(submitted.files).toHaveLength(2);
      expect(submitted.files[0]).toBe(firstFile);
      expect(submitted.files[1]).toBe(secondFile);
      expect(submitted.text).toBe(originalText.trim());
    });
  },
);
