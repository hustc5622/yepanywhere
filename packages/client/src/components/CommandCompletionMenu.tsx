import type { CommandCompletionState } from "../hooks/useCommandCompletion";
import { CommandMenuItemContent } from "./CommandMenuItemContent";

interface CommandCompletionMenuProps {
  state: CommandCompletionState;
  onSelect: (command: string) => void;
  /** Open above the editor (reply composer) or below it (new session). */
  placement?: "above" | "below";
  fallbackLabel?: string;
}

/** Inline `/` and `$` completion list shared by every composer. */
export function CommandCompletionMenu({
  state,
  onSelect,
  placement = "above",
  fallbackLabel = "Commands",
}: CommandCompletionMenuProps) {
  if (!state.isOpen || !state.config) return null;
  const { config, items, activeIndex } = state;
  return (
    <div
      className={`command-completion-menu${placement === "below" ? " command-completion-menu-below" : ""}`}
      role="listbox"
      tabIndex={-1}
      aria-label={config.label || fallbackLabel}
    >
      {items.map((command, index) => (
        <button
          key={command}
          type="button"
          className={`command-completion-item ${index === activeIndex ? "active" : ""}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelect(command)}
          role="option"
          aria-selected={index === activeIndex}
        >
          <CommandMenuItemContent
            prefix={config.prefix}
            command={command}
            detail={config.details?.[command]}
          />
        </button>
      ))}
    </div>
  );
}
