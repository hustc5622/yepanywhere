import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  type PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { useRemoteTerminal } from "../hooks/useRemoteTerminal";
import { useNavigationLayout } from "../layouts";
import { generateUUID } from "../lib/uuid";

type ModifierName = "ctrl" | "alt";
type ModifierMode = "off" | "armed" | "locked";
type MobileModifiers = Record<ModifierName, ModifierMode>;

interface TerminalInputAction {
  id: string;
  label: string;
  title: string;
  input: string;
  ctrlInput?: string;
  altInput?: string;
  ctrlAltInput?: string;
  className?: string;
  ignoreModifiers?: boolean;
  repeat?: boolean;
}

interface TerminalActionRow {
  id: string;
  actions: TerminalInputAction[];
}

const INITIAL_MODIFIERS: MobileModifiers = {
  ctrl: "off",
  alt: "off",
};

const KEY_REPEAT_DELAY_MS = 360;
const KEY_REPEAT_INTERVAL_MS = 70;

const CONTROL_CHAR_OVERRIDES: Record<string, string> = {
  " ": "\x00",
  "@": "\x00",
  "[": "\x1b",
  "\\": "\x1c",
  "]": "\x1d",
  "^": "\x1e",
  _: "\x1f",
  "?": "\x7f",
};

const TERMINAL_ACTION_ROWS: TerminalActionRow[] = [
  {
    id: "primary",
    actions: [
      { id: "esc", label: "Esc", title: "Escape", input: "\x1b" },
      { id: "tab", label: "Tab", title: "Tab", input: "\t" },
      { id: "slash", label: "/", title: "Slash", input: "/" },
      { id: "dash", label: "-", title: "Dash", input: "-" },
      {
        id: "bksp",
        label: "Bksp",
        title: "Backspace",
        input: "\x7f",
        repeat: true,
      },
      {
        id: "enter",
        label: "Enter",
        title: "Enter",
        input: "\r",
        className: "terminal-key-wide",
      },
    ],
  },
  {
    id: "navigation",
    actions: [
      {
        id: "home",
        label: "Home",
        title: "Home",
        input: "\x1b[H",
        ctrlInput: "\x1b[1;5H",
        altInput: "\x1b[1;3H",
        ctrlAltInput: "\x1b[1;7H",
      },
      {
        id: "left",
        label: "Left",
        title: "Cursor left",
        input: "\x1b[D",
        ctrlInput: "\x1b[1;5D",
        altInput: "\x1b[1;3D",
        ctrlAltInput: "\x1b[1;7D",
        repeat: true,
      },
      {
        id: "up",
        label: "Up",
        title: "Cursor up",
        input: "\x1b[A",
        ctrlInput: "\x1b[1;5A",
        altInput: "\x1b[1;3A",
        ctrlAltInput: "\x1b[1;7A",
        repeat: true,
      },
      {
        id: "down",
        label: "Down",
        title: "Cursor down",
        input: "\x1b[B",
        ctrlInput: "\x1b[1;5B",
        altInput: "\x1b[1;3B",
        ctrlAltInput: "\x1b[1;7B",
        repeat: true,
      },
      {
        id: "right",
        label: "Right",
        title: "Cursor right",
        input: "\x1b[C",
        ctrlInput: "\x1b[1;5C",
        altInput: "\x1b[1;3C",
        ctrlAltInput: "\x1b[1;7C",
        repeat: true,
      },
      {
        id: "end",
        label: "End",
        title: "End",
        input: "\x1b[F",
        ctrlInput: "\x1b[1;5F",
        altInput: "\x1b[1;3F",
        ctrlAltInput: "\x1b[1;7F",
      },
    ],
  },
  {
    id: "editing",
    actions: [
      {
        id: "pgup",
        label: "PgUp",
        title: "Page up",
        input: "\x1b[5~",
        repeat: true,
      },
      {
        id: "pgdn",
        label: "PgDn",
        title: "Page down",
        input: "\x1b[6~",
        repeat: true,
      },
      {
        id: "del",
        label: "Del",
        title: "Delete",
        input: "\x1b[3~",
        repeat: true,
      },
      {
        id: "ctrl-c",
        label: "^C",
        title: "Send Ctrl-C",
        input: "\x03",
        ignoreModifiers: true,
      },
      {
        id: "ctrl-d",
        label: "^D",
        title: "Send Ctrl-D",
        input: "\x04",
        ignoreModifiers: true,
      },
      {
        id: "clear",
        label: "Clear",
        title: "Clear screen",
        input: "\x0c",
        ignoreModifiers: true,
      },
    ],
  },
];

function controlInputFor(input: string): string | null {
  if (input.length !== 1) return null;
  const lower = input.toLowerCase();
  if (lower >= "a" && lower <= "z") {
    return String.fromCharCode(lower.charCodeAt(0) - 96);
  }
  return CONTROL_CHAR_OVERRIDES[input] ?? null;
}

function consumeArmedModifiers(modifiers: MobileModifiers): MobileModifiers {
  if (modifiers.ctrl !== "armed" && modifiers.alt !== "armed") {
    return modifiers;
  }
  return {
    ctrl: modifiers.ctrl === "armed" ? "off" : modifiers.ctrl,
    alt: modifiers.alt === "armed" ? "off" : modifiers.alt,
  };
}

function nextModifierMode(mode: ModifierMode): ModifierMode {
  if (mode === "off") return "armed";
  if (mode === "armed") return "locked";
  return "off";
}

function resolveModifiedInput(
  input: string,
  modifiers: MobileModifiers,
  action?: TerminalInputAction,
): string {
  if (action?.ignoreModifiers) return input;

  const ctrlActive = modifiers.ctrl !== "off";
  const altActive = modifiers.alt !== "off";

  if (ctrlActive && altActive) {
    return (
      action?.ctrlAltInput ??
      (action?.ctrlInput ? `\x1b${action.ctrlInput}` : null) ??
      (controlInputFor(input) ? `\x1b${controlInputFor(input)}` : null) ??
      action?.altInput ??
      `\x1b${input}`
    );
  }

  if (ctrlActive) {
    return action?.ctrlInput ?? controlInputFor(input) ?? input;
  }

  if (altActive) {
    return action?.altInput ?? `\x1b${input}`;
  }

  return input;
}

/**
 * TerminalPage — full-page xterm.js attached to a server-side PTY via the
 * useRemoteTerminal hook.
 *
 * URL shapes:
 *   /terminal                     — opens a fresh terminal (random id)
 *   /terminal/:terminalId         — attaches to a specific terminal id
 *
 * Optional query params:
 *   ?cwd=/abs/path                — initial working directory for fresh terminals
 */
export function TerminalPage() {
  const params = useParams<{ terminalId?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { openSidebar, isWideScreen } = useNavigationLayout();

  // Stable terminal id for the lifetime of this page mount. Either taken
  // from the URL (attach to existing) or freshly generated (new shell).
  const terminalId = useMemo(
    () => params.terminalId ?? generateUUID(),
    [params.terminalId],
  );
  const cwd = searchParams.get("cwd") ?? undefined;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const repeatTimeoutRef = useRef<number | null>(null);
  const repeatIntervalRef = useRef<number | null>(null);
  const modifiersRef = useRef<MobileModifiers>(INITIAL_MODIFIERS);
  const pageRef = useRef<HTMLDivElement | null>(null);

  const [connectionInfo, setConnectionInfo] = useState<{
    pid?: number;
    cwd?: string;
    exitCode?: number;
  }>({});
  const [modifiers, setModifierState] =
    useState<MobileModifiers>(INITIAL_MODIFIERS);

  // Forward declare hook handles so xterm imperative listeners always see
  // the latest closure (sendInput identity changes when terminalId settles).
  const sendInputRef = useRef<(s: string) => void>(() => {});
  const sendResizeRef = useRef<(c: number, r: number) => void>(() => {});

  const setModifiers = useCallback(
    (
      updater:
        | MobileModifiers
        | ((current: MobileModifiers) => MobileModifiers),
    ) => {
      setModifierState((current) => {
        const next = typeof updater === "function" ? updater(current) : updater;
        modifiersRef.current = next;
        return next;
      });
    },
    [],
  );

  const result = useRemoteTerminal({
    terminalId,
    cwd,
    cols: 80,
    rows: 24,
    onOpened: (info) =>
      setConnectionInfo((prev) => ({
        ...prev,
        pid: info.pid,
        cwd: info.cwd,
      })),
    onExit: ({ exitCode }) =>
      setConnectionInfo((prev) => ({ ...prev, exitCode })),
    onOutput: (bytes) => {
      termRef.current?.write(bytes);
    },
  });

  useEffect(() => {
    sendInputRef.current = result.sendInput;
    sendResizeRef.current = result.sendResize;
  }, [result.sendInput, result.sendResize]);

  const fitTerminal = useCallback(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    try {
      fit.fit();
      sendResizeRef.current(term.cols, term.rows);
    } catch {
      // Resize events can fire while xterm is between layouts.
    }
  }, []);

  // Keep the terminal layout inside the visual viewport when the soft keyboard
  // overlays the fixed app shell on mobile WebViews.
  const syncViewportBounds = useCallback(() => {
    const page = pageRef.current;
    if (!page) return;

    const viewport = window.visualViewport;
    const visualBottom =
      (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight);
    const pageTop = page.getBoundingClientRect().top;
    const availableHeight = Math.max(1, Math.round(visualBottom - pageTop));

    page.style.setProperty(
      "--terminal-available-height",
      `${availableHeight}px`,
    );
  }, []);

  const focusTerminal = useCallback(() => {
    requestAnimationFrame(() => termRef.current?.focus());
  }, []);

  const consumeOneShotModifiers = useCallback(() => {
    setModifiers((current) => consumeArmedModifiers(current));
  }, [setModifiers]);

  const sendWithMobileModifiers = useCallback(
    (input: string, action?: TerminalInputAction) => {
      const resolved = resolveModifiedInput(
        input,
        modifiersRef.current,
        action,
      );
      sendInputRef.current(resolved);
      consumeOneShotModifiers();
      focusTerminal();
    },
    [consumeOneShotModifiers, focusTerminal],
  );

  const handleTerminalData = useCallback(
    (data: string) => {
      sendWithMobileModifiers(data);
    },
    [sendWithMobileModifiers],
  );

  const stopRepeatingInput = useCallback(() => {
    if (repeatTimeoutRef.current !== null) {
      window.clearTimeout(repeatTimeoutRef.current);
      repeatTimeoutRef.current = null;
    }
    if (repeatIntervalRef.current !== null) {
      window.clearInterval(repeatIntervalRef.current);
      repeatIntervalRef.current = null;
    }
  }, []);

  useEffect(() => stopRepeatingInput, [stopRepeatingInput]);

  const handleActionPointerDown = useCallback(
    (event: PointerEvent<HTMLButtonElement>, action: TerminalInputAction) => {
      if (event.button !== 0) return;
      event.preventDefault();
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Some embedded mobile WebViews do not support pointer capture.
      }
      stopRepeatingInput();
      sendWithMobileModifiers(action.input, action);
      if (!action.repeat) return;
      repeatTimeoutRef.current = window.setTimeout(() => {
        repeatIntervalRef.current = window.setInterval(() => {
          sendWithMobileModifiers(action.input, action);
        }, KEY_REPEAT_INTERVAL_MS);
      }, KEY_REPEAT_DELAY_MS);
    },
    [sendWithMobileModifiers, stopRepeatingInput],
  );

  const handleModifierPointerDown = useCallback(
    (event: PointerEvent<HTMLButtonElement>, modifier: ModifierName) => {
      if (event.button !== 0) return;
      event.preventDefault();
      setModifiers((current) => ({
        ...current,
        [modifier]: nextModifierMode(current[modifier]),
      }));
      focusTerminal();
    },
    [focusTerminal, setModifiers],
  );

  // Mount xterm + addons exactly once
  useEffect(() => {
    if (!containerRef.current) return;
    const term = new Terminal({
      fontFamily:
        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
      fontSize: 13,
      cursorBlink: true,
      convertEol: false,
      scrollback: 5000,
      allowProposedApi: true,
      scrollOnUserInput: true,
      theme: {
        background: "#0b0b0b",
        foreground: "#e6e6e6",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);

    termRef.current = term;
    fitRef.current = fit;

    requestAnimationFrame(() => {
      fitTerminal();
      term.focus();
    });

    const dataDisposable = term.onData(handleTerminalData);

    const observer = new ResizeObserver(() => {
      fitTerminal();
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      dataDisposable.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [fitTerminal, handleTerminalData]);

  useEffect(() => {
    const syncAndFit = () => {
      syncViewportBounds();
      requestAnimationFrame(fitTerminal);
    };

    syncAndFit();
    window.addEventListener("resize", syncAndFit);
    window.addEventListener("orientationchange", syncAndFit);
    window.visualViewport?.addEventListener("resize", syncAndFit);
    window.visualViewport?.addEventListener("scroll", syncAndFit);

    return () => {
      window.removeEventListener("resize", syncAndFit);
      window.removeEventListener("orientationchange", syncAndFit);
      window.visualViewport?.removeEventListener("resize", syncAndFit);
      window.visualViewport?.removeEventListener("scroll", syncAndFit);
    };
  }, [fitTerminal, syncViewportBounds]);

  const stateColor =
    result.state === "connected"
      ? "#34c759"
      : result.state === "connecting"
        ? "#ffcc00"
        : result.state === "error" || result.state === "exited"
          ? "#ff453a"
          : "#888";

  const subtitle =
    connectionInfo.pid !== undefined
      ? `pid ${connectionInfo.pid}${connectionInfo.cwd ? ` · ${connectionInfo.cwd}` : ""}`
      : null;

  return (
    <div ref={pageRef} className="main-content-wrapper terminal-page-wrapper">
      <div className="main-content-constrained terminal-page">
        <PageHeader
          title="Terminal"
          onOpenSidebar={openSidebar}
          isWideScreen={isWideScreen}
        />
        <div className="terminal-status-bar">
          <span
            aria-label="connection state"
            className="terminal-status-dot"
            style={{ background: stateColor }}
          />
          <span>{result.state}</span>
          {subtitle ? (
            <span className="terminal-status-subtitle">· {subtitle}</span>
          ) : null}
          {result.error ? (
            <span className="terminal-status-error">· {result.error}</span>
          ) : null}
          <span className="terminal-status-spacer" />
          {result.state === "exited" ? (
            <button
              type="button"
              onClick={() => {
                // Navigating to /terminal forces a fresh id (no :terminalId).
                navigate("/terminal");
              }}
              className="terminal-status-action"
            >
              New terminal
            </button>
          ) : null}
        </div>
        <div ref={containerRef} className="terminal-surface" />
        <div
          className="terminal-mobile-controls"
          aria-label="Terminal helper keyboard"
        >
          <div className="terminal-key-row terminal-modifier-row">
            <button
              type="button"
              className={`terminal-key terminal-key-modifier terminal-key-${modifiers.ctrl}`}
              data-mode={modifiers.ctrl}
              aria-pressed={modifiers.ctrl !== "off"}
              title="Ctrl: tap once for next key, twice to lock"
              onPointerDown={(event) =>
                handleModifierPointerDown(event, "ctrl")
              }
            >
              Ctrl
            </button>
            <button
              type="button"
              className={`terminal-key terminal-key-modifier terminal-key-${modifiers.alt}`}
              data-mode={modifiers.alt}
              aria-pressed={modifiers.alt !== "off"}
              title="Alt: tap once for next key, twice to lock"
              onPointerDown={(event) => handleModifierPointerDown(event, "alt")}
            >
              Alt
            </button>
            <span className="terminal-modifier-hint">
              tap once for next key, twice to lock
            </span>
          </div>
          {TERMINAL_ACTION_ROWS.map((row) => (
            <div className="terminal-key-row" key={row.id}>
              {row.actions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  className={`terminal-key ${action.className ?? ""}`}
                  title={action.title}
                  aria-label={action.title}
                  onPointerDown={(event) =>
                    handleActionPointerDown(event, action)
                  }
                  onPointerUp={stopRepeatingInput}
                  onPointerCancel={stopRepeatingInput}
                  onPointerLeave={stopRepeatingInput}
                  onContextMenu={(event) => event.preventDefault()}
                >
                  {action.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
