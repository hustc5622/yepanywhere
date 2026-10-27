import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import type { ClipboardUserInputCopyResult } from "../lib/clipboard";

interface ComposerCopyButtonProps {
  onCopy: () => Promise<ClipboardUserInputCopyResult>;
  disabled?: boolean;
  className?: string;
  iconSize?: number;
}

type Feedback = "copied" | "partial" | "failed" | null;

/** Copies the whole draft (text and every attachment) for another composer. */
export function ComposerCopyButton({
  onCopy,
  disabled,
  className = "toolbar-button",
  iconSize = 16,
}: ComposerCopyButtonProps) {
  const { t } = useI18n();
  const [feedback, setFeedback] = useState<Feedback>(null);

  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(null), 1500);
    return () => clearTimeout(timer);
  }, [feedback]);

  const label =
    feedback === "copied"
      ? t("composerCopied")
      : feedback === "partial"
        ? t("composerCopiedPartial")
        : feedback === "failed"
          ? t("composerCopyFailed")
          : t("composerCopyAll");

  return (
    <button
      type="button"
      className={`${className} composer-copy-button${feedback ? ` ${feedback}` : ""}`}
      disabled={disabled}
      title={label}
      aria-label={label}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        onCopy()
          .then((result) =>
            setFeedback(result.failedNames.length > 0 ? "partial" : "copied"),
          )
          .catch(() => setFeedback("failed"));
      }}
    >
      {feedback === "copied" ? (
        <svg
          width={iconSize}
          height={iconSize}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg
          width={iconSize}
          height={iconSize}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
}
