import {
  type MouseEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { useOptionalI18n } from "../i18n";
import { writeClipboardText } from "../lib/clipboard";

const COPY_CONTROL_ATTRIBUTE = "data-yep-markdown-code-copy";
const COPY_CONTROL_SELECTOR = `[${COPY_CONTROL_ATTRIBUTE}]`;
const COPYABLE_PRE_CLASS = "markdown-code-block-copyable";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const FEEDBACK_DURATION_MS = 1500;

type CopyStatus = "idle" | "copied" | "failed";

interface CopyLabels {
  idle: string;
  copied: string;
  failed: string;
}

function isCopyStatus(value: string | undefined): value is CopyStatus {
  return value === "idle" || value === "copied" || value === "failed";
}

function getDirectCodeElement(pre: Element | null): HTMLElement | null {
  if (!(pre instanceof HTMLElement)) return null;
  for (const child of pre.children) {
    if (child instanceof HTMLElement && child.tagName === "CODE") {
      return child;
    }
  }
  return null;
}

function getDirectCopyButton(pre: HTMLElement): HTMLButtonElement | null {
  for (const child of pre.children) {
    if (
      child instanceof HTMLButtonElement &&
      child.hasAttribute(COPY_CONTROL_ATTRIBUTE)
    ) {
      return child;
    }
  }
  return null;
}

function createIcon(status: CopyStatus): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", status === "idle" ? "2" : "2.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  if (status === "idle") {
    const rect = document.createElementNS(SVG_NAMESPACE, "rect");
    rect.setAttribute("x", "9");
    rect.setAttribute("y", "9");
    rect.setAttribute("width", "13");
    rect.setAttribute("height", "13");
    rect.setAttribute("rx", "2");
    rect.setAttribute("ry", "2");
    svg.appendChild(rect);

    const path = document.createElementNS(SVG_NAMESPACE, "path");
    path.setAttribute(
      "d",
      "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
    );
    svg.appendChild(path);
    return svg;
  }

  if (status === "copied") {
    const polyline = document.createElementNS(SVG_NAMESPACE, "polyline");
    polyline.setAttribute("points", "20 6 9 17 4 12");
    svg.appendChild(polyline);
    return svg;
  }

  const path = document.createElementNS(SVG_NAMESPACE, "path");
  path.setAttribute("d", "M6 6l12 12M18 6 6 18");
  svg.appendChild(path);
  return svg;
}

function updateCopyButton(
  button: HTMLButtonElement,
  status: CopyStatus,
  labels: CopyLabels,
): void {
  const label = labels[status];
  button.setAttribute("aria-label", label);
  button.setAttribute("title", label);
  button.classList.toggle("is-copied", status === "copied");
  button.classList.toggle("is-failed", status === "failed");

  if (button.dataset.copyStatus !== status) {
    button.dataset.copyStatus = status;
    button.replaceChildren(createIcon(status));
  }
}

function decorateCodeBlocks(root: HTMLElement, labels: CopyLabels): void {
  for (const code of root.querySelectorAll("pre > code")) {
    const pre = code.parentElement;
    if (!(pre instanceof HTMLElement)) continue;

    pre.classList.add(COPYABLE_PRE_CLASS);
    let button = getDirectCopyButton(pre);
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "markdown-code-copy";
      button.setAttribute(COPY_CONTROL_ATTRIBUTE, "");
      button.setAttribute("aria-live", "polite");
      pre.appendChild(button);
    }

    const currentStatus = isCopyStatus(button.dataset.copyStatus)
      ? button.dataset.copyStatus
      : "idle";
    updateCopyButton(button, currentStatus, labels);
  }
}

/**
 * Serialize streamed markdown without client-only copy controls. The live DOM
 * is left untouched so a capture cannot disturb a text selection or feedback.
 */
export function serializeMarkdownWithoutCopyControls(
  container: HTMLElement,
): string {
  if (
    !container.querySelector(COPY_CONTROL_SELECTOR) &&
    !container.querySelector(`.${COPYABLE_PRE_CLASS}`)
  ) {
    return container.innerHTML;
  }

  const clone = container.cloneNode(true) as HTMLElement;
  for (const control of clone.querySelectorAll(COPY_CONTROL_SELECTOR)) {
    control.remove();
  }
  for (const pre of clone.querySelectorAll(`.${COPYABLE_PRE_CLASS}`)) {
    pre.classList.remove(COPYABLE_PRE_CLASS);
  }
  return clone.innerHTML;
}

/** Add delegated copy controls to fenced code blocks rendered as `<pre><code>`. */
export function useMarkdownCodeCopy(
  rootRef: RefObject<HTMLElement | null>,
): (event: MouseEvent<Element>) => boolean {
  const i18n = useOptionalI18n();
  const labels = useMemo<CopyLabels>(
    () => ({
      idle: i18n?.t("codeBlockCopy") ?? "Copy code block",
      copied: i18n?.t("codeBlockCopied") ?? "Copied!",
      failed: i18n?.t("codeBlockCopyFailed") ?? "Copy failed",
    }),
    [i18n],
  );
  const labelsRef = useRef(labels);
  labelsRef.current = labels;
  const resetTimersRef = useRef(new Map<HTMLButtonElement, number>());
  const attemptsRef = useRef(new WeakMap<HTMLButtonElement, symbol>());

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    decorateCodeBlocks(root, labels);
    if (typeof MutationObserver === "undefined") return;

    const observer = new MutationObserver(() => {
      decorateCodeBlocks(root, labelsRef.current);
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [labels, rootRef]);

  useEffect(
    () => () => {
      for (const timer of resetTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      resetTimersRef.current.clear();
    },
    [],
  );

  return useCallback(
    (event: MouseEvent<Element>): boolean => {
      const target = event.target;
      if (!(target instanceof Element)) return false;

      const button = target.closest<HTMLButtonElement>(COPY_CONTROL_SELECTOR);
      const root = rootRef.current;
      if (!button || !root?.contains(button)) return false;

      event.preventDefault();
      event.stopPropagation();

      const code = getDirectCodeElement(button.parentElement);
      if (!code) return true;

      const previousTimer = resetTimersRef.current.get(button);
      if (previousTimer !== undefined) window.clearTimeout(previousTimer);

      const attempt = Symbol("markdown-code-copy");
      attemptsRef.current.set(button, attempt);

      void writeClipboardText(code.textContent ?? "")
        .then(() => {
          if (
            !button.isConnected ||
            attemptsRef.current.get(button) !== attempt
          ) {
            return;
          }
          updateCopyButton(button, "copied", labelsRef.current);
        })
        .catch((error: unknown) => {
          if (
            !button.isConnected ||
            attemptsRef.current.get(button) !== attempt
          ) {
            return;
          }
          console.error("Failed to copy markdown code block:", error);
          updateCopyButton(button, "failed", labelsRef.current);
        })
        .finally(() => {
          if (
            !button.isConnected ||
            attemptsRef.current.get(button) !== attempt
          ) {
            return;
          }
          const timer = window.setTimeout(() => {
            resetTimersRef.current.delete(button);
            if (button.isConnected) {
              updateCopyButton(button, "idle", labelsRef.current);
            }
          }, FEEDBACK_DURATION_MS);
          resetTimersRef.current.set(button, timer);
        });

      return true;
    },
    [rootRef],
  );
}
