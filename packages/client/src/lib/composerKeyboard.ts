import type { KeyboardEvent } from "react";
import { ENTER_SENDS_MESSAGE } from "../constants";
import { hasCoarsePointer } from "./deviceDetection";

export function isComposerComposing(event: KeyboardEvent): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

/** Shared Enter policy, after any command completion has handled the key. */
export function handleComposerSubmitKey(
  event: KeyboardEvent,
  {
    onSubmit,
    onQueue,
    isListening,
  }: {
    onSubmit: () => void;
    onQueue?: () => void;
    isListening?: boolean;
  },
): void {
  if (event.key !== "Enter" || isComposerComposing(event)) return;
  if (onQueue && event.ctrlKey && !event.shiftKey) {
    event.preventDefault();
    onQueue();
    return;
  }
  if (
    isListening ||
    (!hasCoarsePointer() &&
      (ENTER_SENDS_MESSAGE
        ? !event.ctrlKey && !event.shiftKey
        : event.ctrlKey || event.shiftKey))
  ) {
    event.preventDefault();
    onSubmit();
  }
}
