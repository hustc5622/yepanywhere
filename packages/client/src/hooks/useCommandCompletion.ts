import {
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { AttachmentComposerHandle } from "../components/AttachmentComposer";
import type {
  AgentCommandConfig,
  AgentCommandPrefix,
} from "../lib/agentCommands";

interface ActiveCommandToken {
  start: number;
  end: number;
  query: string;
}

export function findActiveCommandToken(
  text: string,
  cursorPosition: number,
  prefix: AgentCommandPrefix,
): ActiveCommandToken | null {
  if (cursorPosition < 0 || cursorPosition > text.length) return null;

  const beforeCursor = text.slice(0, cursorPosition);
  const tokenStart = Math.max(
    beforeCursor.lastIndexOf(" "),
    beforeCursor.lastIndexOf("\n"),
    beforeCursor.lastIndexOf("\t"),
  );
  const start = tokenStart + 1;
  const token = beforeCursor.slice(start);

  if (!token.startsWith(prefix)) return null;
  if (token.length > 1 && token.includes(prefix, 1)) return null;

  return {
    start,
    end: cursorPosition,
    query: token.slice(prefix.length),
  };
}

export function filterCommands(commands: string[], query: string): string[] {
  const normalizedQuery = query.toLowerCase();
  const deduped = Array.from(new Set(commands)).filter(Boolean);

  if (!normalizedQuery) return deduped;

  return deduped
    .filter((command) => command.toLowerCase().includes(normalizedQuery))
    .sort((a, b) => {
      const aStarts = a.toLowerCase().startsWith(normalizedQuery);
      const bStarts = b.toLowerCase().startsWith(normalizedQuery);
      if (aStarts !== bStarts) return aStarts ? -1 : 1;
      return a.localeCompare(b);
    });
}

interface Options {
  text: string;
  setText: (value: string) => void;
  editorRef: RefObject<AttachmentComposerHandle | null>;
  configs: AgentCommandConfig[];
  /** Client-side `/` commands (e.g. "model"). Return true when handled. */
  onCustomCommand?: (command: string) => boolean;
  /**
   * The caret entered a `/` or `$` token of a group with commands (even if
   * nothing matches yet); callers refresh their command lists here.
   */
  onActivate?: () => void;
}

export interface CommandCompletionState {
  isOpen: boolean;
  config: AgentCommandConfig | null;
  items: string[];
  activeIndex: number;
}

/**
 * Inline `/` and `$` completion shared by every composer: tracks the token at
 * the caret, filters the active command group, handles arrow/Tab/Enter/Escape
 * and inserts the chosen command.
 */
export function useCommandCompletion({
  text,
  setText,
  editorRef,
  configs,
  onCustomCommand,
  onActivate,
}: Options) {
  const [cursorPosition, setCursorPosition] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  const updateCursorPosition = useCallback(() => {
    setCursorPosition(editorRef.current?.selectionStart ?? text.length);
  }, [editorRef, text.length]);

  /** Call from the editor's change handler with the new caret position. */
  const handleTextChange = useCallback((cursor: number) => {
    setDismissedKey(null);
    setCursorPosition(cursor);
  }, []);

  const active = useMemo(() => {
    for (const config of configs) {
      if (config.commands.length === 0) continue;
      const token = findActiveCommandToken(text, cursorPosition, config.prefix);
      if (token) return { config, token };
    }
    return null;
  }, [configs, cursorPosition, text]);

  const activeToken = active?.token ?? null;
  const activeConfig = active?.config ?? null;

  const items = useMemo(
    () =>
      activeToken && activeConfig
        ? filterCommands(activeConfig.commands, activeToken.query)
        : [],
    [activeConfig, activeToken],
  );

  const completionKey =
    activeToken && activeConfig
      ? `${activeConfig.prefix}:${activeToken.start}:${activeToken.end}:${activeToken.query}`
      : null;
  const isOpen =
    !!completionKey && dismissedKey !== completionKey && items.length > 0;

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset selection when the active command token changes.
  useEffect(() => {
    setActiveIndex(0);
  }, [completionKey]);

  const tokenStart =
    activeToken && activeConfig
      ? `${activeConfig.prefix}:${activeToken.start}`
      : null;
  const onActivateRef = useRef(onActivate);
  onActivateRef.current = onActivate;
  useEffect(() => {
    if (tokenStart) onActivateRef.current?.();
  }, [tokenStart]);

  const focusAt = useCallback(
    (position: number) => {
      setTimeout(() => {
        const editor = editorRef.current;
        editor?.focus();
        editor?.setSelectionRange(position, position);
      }, 0);
    },
    [editorRef],
  );

  /** Insert `{prefix}{command}` at the active token or the caret. */
  const insertCommand = useCallback(
    (command: string) => {
      const prefix: AgentCommandPrefix = command.startsWith("$") ? "$" : "/";
      const bare =
        command.startsWith("/") || command.startsWith("$")
          ? command.slice(1)
          : command;
      const token = findActiveCommandToken(
        text,
        editorRef.current?.selectionStart ?? cursorPosition,
        prefix,
      );

      if (prefix === "/" && onCustomCommand?.(bare)) {
        if (token) {
          setText(text.slice(0, token.start) + text.slice(token.end));
          setCursorPosition(token.start);
          focusAt(token.start);
        }
        setDismissedKey(null);
        editorRef.current?.focus();
        return;
      }

      const fullCommand = `${prefix}${bare}`;
      let nextText: string;
      let nextCursor: number;

      if (token) {
        nextText = `${text.slice(0, token.start)}${fullCommand} ${text.slice(token.end)}`;
        nextCursor = token.start + fullCommand.length + 1;
      } else {
        const editor = editorRef.current;
        const cursor = editor?.selectionStart ?? text.length;
        const before = text.slice(0, cursor);
        const after = text.slice(cursor);
        const leading = before.length > 0 && !/\s$/.test(before) ? " " : "";
        nextText = `${before}${leading}${fullCommand} ${after}`;
        nextCursor = before.length + leading.length + fullCommand.length + 1;
      }

      setText(nextText);
      setCursorPosition(nextCursor);
      setDismissedKey(null);
      focusAt(nextCursor);
    },
    [cursorPosition, editorRef, focusAt, onCustomCommand, setText, text],
  );

  const selectItem = useCallback(
    (command: string) =>
      insertCommand(`${activeConfig?.prefix ?? "/"}${command}`),
    [activeConfig?.prefix, insertCommand],
  );

  /** Returns true when the key was consumed by the completion menu. */
  const handleKeyDown = useCallback(
    (event: KeyboardEvent): boolean => {
      if (!isOpen) return false;
      const selected = items[activeIndex];
      const hasExactMatch =
        activeToken !== null &&
        items.some(
          (command) =>
            command.toLowerCase() === activeToken.query.toLowerCase(),
        );

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((index) => (index + 1) % items.length);
        return true;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((index) => (index - 1 + items.length) % items.length);
        return true;
      }
      if (event.key === "Tab" && selected) {
        event.preventDefault();
        selectItem(selected);
        return true;
      }
      if (
        event.key === "Enter" &&
        !hasExactMatch &&
        !event.shiftKey &&
        !event.ctrlKey &&
        selected
      ) {
        event.preventDefault();
        selectItem(selected);
        return true;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedKey(completionKey);
        return true;
      }
      return false;
    },
    [activeIndex, activeToken, completionKey, isOpen, items, selectItem],
  );

  const state: CommandCompletionState = {
    isOpen,
    config: activeConfig,
    items,
    activeIndex,
  };

  return {
    state,
    handleKeyDown,
    handleTextChange,
    updateCursorPosition,
    insertCommand,
    selectItem,
  };
}
