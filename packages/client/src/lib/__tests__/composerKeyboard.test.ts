import type { KeyboardEvent } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleComposerSubmitKey } from "../composerKeyboard";
import { hasCoarsePointer } from "../deviceDetection";

vi.mock("../deviceDetection", () => ({ hasCoarsePointer: vi.fn(() => false) }));

function key(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key: "Enter",
    ctrlKey: false,
    shiftKey: false,
    keyCode: 13,
    nativeEvent: { isComposing: false },
    preventDefault: vi.fn(),
    ...overrides,
  } as unknown as KeyboardEvent;
}

describe("shared composer submit keyboard", () => {
  beforeEach(() => vi.mocked(hasCoarsePointer).mockReturnValue(false));

  it("submits desktop Enter and preserves modified newlines", () => {
    const onSubmit = vi.fn();
    handleComposerSubmitKey(key(), { onSubmit });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    for (const event of [key({ ctrlKey: true }), key({ shiftKey: true })]) {
      handleComposerSubmitKey(event, { onSubmit });
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("keeps mobile Enter as a newline unless finalizing voice", () => {
    vi.mocked(hasCoarsePointer).mockReturnValue(true);
    const onSubmit = vi.fn();
    const event = key();
    handleComposerSubmitKey(event, { onSubmit });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    handleComposerSubmitKey(event, { onSubmit, isListening: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("queues Ctrl+Enter only when the caller enables queueing", () => {
    const onSubmit = vi.fn();
    const onQueue = vi.fn();
    handleComposerSubmitKey(key({ ctrlKey: true }), { onSubmit, onQueue });
    expect(onQueue).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each([{ nativeEvent: { isComposing: true } }, { keyCode: 229 }])(
    "never submits or queues an IME confirmation (%j)",
    (overrides) => {
      const onSubmit = vi.fn();
      const onQueue = vi.fn();
      const event = key({
        ctrlKey: true,
        ...overrides,
      } as Partial<KeyboardEvent>);
      handleComposerSubmitKey(event, { onSubmit, onQueue, isListening: true });
      expect(onSubmit).not.toHaveBeenCalled();
      expect(onQueue).not.toHaveBeenCalled();
      expect(event.preventDefault).not.toHaveBeenCalled();
    },
  );
});
