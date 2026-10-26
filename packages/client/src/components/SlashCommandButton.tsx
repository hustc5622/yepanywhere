import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentCommandDetail } from "../lib/agentCommands";
import { CommandMenuItemContent } from "./CommandMenuItemContent";

interface SlashCommandButtonProps {
  /** Available commands (without the prefix) */
  commands: string[];
  /** Optional description/source per command name */
  details?: Record<string, AgentCommandDetail>;
  /** Callback when a command is selected */
  onSelectCommand: (command: string) => void;
  /** Optional fallback when only the prefix is available to insert. */
  onInsertPrefix?: () => void;
  /** Whether the button should be disabled */
  disabled?: boolean;
  /** Prefix to display and insert before commands */
  prefix?: "/" | "$";
  /** Accessible label for the command menu */
  label?: string;
}

/**
 * Button that shows available agent commands in a dropdown menu.
 * Selecting a command inserts "{prefix}{command}" into the message input.
 */
export function SlashCommandButton({
  commands,
  details,
  onSelectCommand,
  onInsertPrefix,
  disabled,
  prefix = "/",
  label = "Commands",
}: SlashCommandButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const hasCommands = commands.length > 0;
  const canActivate = hasCommands || !!onInsertPrefix;

  useEffect(() => {
    if (!hasCommands) {
      setIsOpen(false);
    }
  }, [hasCommands]);

  // Close menu when clicking outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  // Close menu on Escape
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsOpen(false);
        buttonRef.current?.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  const handleCommandClick = useCallback(
    (command: string) => {
      onSelectCommand(`${prefix}${command}`);
      setIsOpen(false);
    },
    [onSelectCommand, prefix],
  );

  return (
    <div className="slash-command-container">
      <button
        ref={buttonRef}
        type="button"
        className={`slash-command-button ${isOpen ? "active" : ""}`}
        onClick={() => {
          if (hasCommands) {
            setIsOpen(!isOpen);
          } else {
            onInsertPrefix?.();
          }
        }}
        disabled={disabled || !canActivate}
        title={label}
        aria-label={
          hasCommands || !onInsertPrefix
            ? `Show ${label.toLowerCase()}`
            : `Insert ${label.toLowerCase()} prefix`
        }
        aria-expanded={hasCommands ? isOpen : undefined}
        aria-haspopup={hasCommands ? "menu" : undefined}
      >
        <span className="slash-icon">{prefix}</span>
      </button>
      {isOpen && (
        <div
          ref={menuRef}
          className="slash-command-menu"
          role="menu"
          aria-label={label}
        >
          {commands.map((command) => (
            <button
              key={command}
              type="button"
              className="slash-command-item"
              onClick={() => handleCommandClick(command)}
              role="menuitem"
            >
              <CommandMenuItemContent
                prefix={prefix}
                command={command}
                detail={details?.[command]}
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
