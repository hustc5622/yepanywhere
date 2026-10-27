import type { ReactNode, RefObject } from "react";
import type { AgentCommandConfig } from "../lib/agentCommands";
import type { ClipboardUserInputCopyResult } from "../lib/clipboard";
import { ComposerCopyButton } from "./ComposerCopyButton";
import { SlashCommandButton } from "./SlashCommandButton";
import { VoiceInputButton, type VoiceInputButtonRef } from "./VoiceInputButton";

/**
 * Visual density of the hosting composer. The reply composer sits in a
 * compact footer; the new-session form uses larger touch targets.
 */
export type ComposerToolbarVariant = "session" | "new-session";

const VARIANTS: Record<
  ComposerToolbarVariant,
  { root: string; left: string; button: string; iconSize: number }
> = {
  session: {
    root: "message-input-toolbar",
    left: "message-input-left",
    button: "attach-button",
    iconSize: 16,
  },
  "new-session": {
    root: "new-session-form-toolbar",
    left: "new-session-form-toolbar-left",
    button: "toolbar-button",
    iconSize: 18,
  },
};

export function composerToolbarButtonClass(
  variant: ComposerToolbarVariant,
): string {
  return VARIANTS[variant].button;
}

export function composerToolbarIconSize(
  variant: ComposerToolbarVariant,
): number {
  return VARIANTS[variant].iconSize;
}

export interface ComposerToolbarProps {
  variant?: ComposerToolbarVariant;
  /** Extra root classes (e.g. send-option layout). */
  className?: string;
  /** Before the shared tools (e.g. permission mode selector). */
  leading?: ReactNode;
  attach?: {
    onClick: () => void;
    disabled?: boolean;
    title: string;
    count?: number;
  } | null;
  copy?: {
    onCopy: () => Promise<ClipboardUserInputCopyResult>;
    disabled?: boolean;
  } | null;
  /** Rendered in the thinking slot (usually a ThinkingToggleButton). */
  thinking?: ReactNode;
  voice?: {
    ref: RefObject<VoiceInputButtonRef | null>;
    onTranscript: (transcript: string) => void;
    onInterimTranscript: (transcript: string) => void;
    onListeningStart?: () => void;
    disabled?: boolean;
  } | null;
  commands?: {
    buttons: AgentCommandConfig[];
    onSelect: (command: string) => void;
    disabled?: boolean;
  } | null;
  /** After the shared tools (side conversation, context usage, ...). */
  trailing?: ReactNode;
  /** Right side: submit/stop controls. */
  actions?: ReactNode;
  /** Wraps `actions` in a container with this class when given. */
  actionsClassName?: string;
  /** Rendered after the toolbar row (dialogs owned by toolbar items). */
  children?: ReactNode;
}

/**
 * The one composer toolbar: attachment, copy, thinking, voice and command
 * tools in a fixed order, with slots for entry-specific controls. Each
 * composer passes only the capabilities it has.
 */
export function ComposerToolbar({
  variant = "session",
  className,
  leading,
  attach,
  copy,
  thinking,
  voice,
  commands,
  trailing,
  actions,
  actionsClassName,
  children,
}: ComposerToolbarProps) {
  const styles = VARIANTS[variant];
  const buttonClass = styles.button;
  return (
    <div className={className ? `${styles.root} ${className}` : styles.root}>
      <div className={styles.left}>
        {leading}
        {attach && (
          <button
            type="button"
            className={buttonClass}
            onClick={attach.onClick}
            disabled={attach.disabled}
            title={attach.title}
            aria-label={attach.title}
          >
            <svg
              width={styles.iconSize}
              height={styles.iconSize}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
            {!!attach.count && (
              <span className="attach-count">{attach.count}</span>
            )}
          </button>
        )}
        {copy && (
          <ComposerCopyButton
            onCopy={copy.onCopy}
            disabled={copy.disabled}
            className={buttonClass}
            iconSize={styles.iconSize}
          />
        )}
        {thinking}
        {voice && (
          <VoiceInputButton
            ref={voice.ref}
            onTranscript={voice.onTranscript}
            onInterimTranscript={voice.onInterimTranscript}
            onListeningStart={voice.onListeningStart}
            disabled={voice.disabled}
            className={variant === "new-session" ? buttonClass : undefined}
          />
        )}
        {/* `showButton` alone decides, so a loading list keeps its slot. */}
        {commands?.buttons
          .filter((button) => button.showButton)
          .map((button) => (
            <SlashCommandButton
              key={button.prefix}
              commands={button.commands}
              details={button.details}
              onSelectCommand={commands.onSelect}
              disabled={commands.disabled}
              prefix={button.prefix}
              label={button.label}
            />
          ))}
        {trailing}
      </div>
      {actionsClassName ? (
        <div className={actionsClassName}>{actions}</div>
      ) : (
        actions
      )}
      {children}
    </div>
  );
}
