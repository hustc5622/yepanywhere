import {
  type CodexAsyncMessage,
  getMediaPreviewKind,
  isPreviewLinkablePath,
} from "@yep-anywhere/shared";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useOptionalSessionMetadata } from "../../contexts/SessionMetadataContext";
import { useStreamingMarkdownContext } from "../../contexts/StreamingMarkdownContext";
import { useMarkdownCodeCopy } from "../../hooks/useMarkdownCodeCopy";
import { useStreamingMarkdown } from "../../hooks/useStreamingMarkdown";
import { useOptionalI18n } from "../../i18n";
import { splitTextWithFilePaths } from "../../lib/filePathDetection";
import {
  extractFileLinkTarget,
  filePageUrl,
  fileRefFromPath,
} from "../../lib/fileRef";
import { useFilePreview } from "../FilePreviewPanel";
import {
  BenchmarkEvalResult,
  parseBenchmarkEvalResultBlock,
} from "./BenchmarkEvalResult";

interface Props {
  text: string;
  isStreaming?: boolean;
  streamingMessageId?: string;
  phase?: "commentary" | "final_answer";
  asyncMessage?: CodexAsyncMessage;
  /** Pre-rendered HTML from server (for completed messages) */
  augmentHtml?: string;
}

function isModifiedClick(e: React.MouseEvent): boolean {
  return e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
}

/**
 * A drag that selects text inside a link ends with a click on that link.
 * Treat it as a selection gesture so the user can copy the text instead of
 * being navigated away.
 */
function isSelectingWithin(element: Element): boolean {
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return false;
  }
  if (!selection.toString().trim()) return false;
  for (let i = 0; i < selection.rangeCount; i++) {
    if (selection.getRangeAt(i).intersectsNode(element)) return true;
  }
  return false;
}

/**
 * Plain-text fallback (no server augment): link the same paths the server
 * markdown renderer links, using the same classes so one click handler
 * serves both.
 */
function renderPlainTextWithFileLinks(text: string): React.ReactNode {
  return splitTextWithFilePaths(text).map((segment) => {
    if (segment.type === "text") {
      return segment.content;
    }

    const { filePath: path, match, startIndex, lineNumber } = segment.detected;
    if (!isPreviewLinkablePath(path)) return match;
    const mediaType = path.startsWith("/") ? getMediaPreviewKind(path) : null;
    if (mediaType) {
      return (
        <a
          key={`${path}-${startIndex}`}
          href={`/api/local-image?path=${encodeURIComponent(path)}`}
          className="local-media-link"
          data-media-type={mediaType}
        >
          {match}
          <span className="local-media-type">({mediaType})</span>
        </a>
      );
    }
    return (
      <a
        key={`${path}-${startIndex}`}
        href={`/api/local-file?path=${encodeURIComponent(path)}`}
        className="local-file-link"
        data-file-path={path}
        data-line={lineNumber}
        title={match}
      >
        {match}
      </a>
    );
  });
}

export const TextBlock = memo(function TextBlock({
  text,
  isStreaming = false,
  streamingMessageId,
  phase,
  asyncMessage,
  augmentHtml,
}: Props) {
  const i18n = useOptionalI18n();
  const { openFile, filePreview } = useFilePreview();
  const blockRef = useRef<HTMLDivElement | null>(null);
  const handleCodeBlockCopyClick = useMarkdownCodeCopy(blockRef);
  const sessionMetadata = useOptionalSessionMetadata();
  const benchmarkEval = useMemo(
    () => parseBenchmarkEvalResultBlock(text),
    [text],
  );

  // Streaming markdown hook for server-rendered content
  const streamingMarkdown = useStreamingMarkdown();
  const streamingContext = useStreamingMarkdownContext();

  // Track whether we're actively using streaming markdown (received at least one augment)
  const [useStreamingContent, setUseStreamingContent] = useState(false);

  // Register with context when streaming and context is available
  useEffect(() => {
    if (!isStreaming || !streamingContext) {
      // Reset streaming state when not streaming
      // (HTML is captured to markdownAugments before component remounts)
      if (!isStreaming) {
        setUseStreamingContent(false);
        streamingMarkdown.reset();
      }
      return;
    }

    // Register handlers with the context
    const unregister = streamingContext.registerStreamingHandler(
      {
        onAugment: (augment) => {
          // Mark that we're using streaming content on first augment
          setUseStreamingContent(true);
          streamingMarkdown.onAugment(augment);
        },
        onPending: streamingMarkdown.onPending,
        onStreamEnd: streamingMarkdown.onStreamEnd,
        captureHtml: streamingMarkdown.captureHtml,
      },
      streamingMessageId,
    );

    return unregister;
  }, [isStreaming, streamingContext, streamingMarkdown, streamingMessageId]);

  // Firefox ignores `-webkit-user-drag`; mark links non-draggable on press so
  // a drag starting on link text extends a selection there too.
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const anchor = (e.target as HTMLElement).closest?.("a[href]");
    if (anchor && anchor.getAttribute("draggable") !== "false") {
      anchor.setAttribute("draggable", "false");
    }
  }, []);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (handleCodeBlockCopyClick(e)) return;

      const anchor = (e.target as HTMLElement).closest?.("a[href]");
      if (anchor && isSelectingWithin(anchor)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      if (!(anchor instanceof HTMLAnchorElement)) return;
      const linkTarget = extractFileLinkTarget(anchor);
      if (!linkTarget) return;
      e.preventDefault();
      e.stopPropagation();

      const ref = fileRefFromPath(linkTarget.path, sessionMetadata, {
        lineNumber: linkTarget.lineNumber,
      });
      if (isModifiedClick(e)) {
        window.open(filePageUrl(ref), "_blank");
        return;
      }
      openFile(ref);
    },
    [handleCodeBlockCopyClick, openFile, sessionMetadata],
  );

  const showStreamingContent = isStreaming && useStreamingContent;

  // Server-rendered markdown is applied imperatively instead of through
  // `dangerouslySetInnerHTML` so identical HTML is never re-applied. React
  // re-runs that prop on some commits (a load-older prepend applies the exact
  // same string twice), and every re-application recreates every node inside —
  // which silently destroys a text selection the user is making inside it.
  const augmentHostRef = useRef<HTMLDivElement | null>(null);
  const appliedAugmentRef = useRef<{ host: HTMLElement; html: string } | null>(
    null,
  );
  const showAugmentHost =
    !showStreamingContent && !benchmarkEval && augmentHtml;
  // biome-ignore lint/correctness/useExhaustiveDependencies: showAugmentHost re-runs this when the branch (and therefore the host node) changes
  useLayoutEffect(() => {
    const host = augmentHostRef.current;
    if (!host || !augmentHtml) return;
    const applied = appliedAugmentRef.current;
    if (applied && applied.host === host && applied.html === augmentHtml)
      return;
    host.innerHTML = augmentHtml;
    appliedAugmentRef.current = { host, html: augmentHtml };
  }, [augmentHtml, showAugmentHost]);

  // Anchor to the actual prose tail, including nested lists/code, rather than
  // the outer HTML host (whose ::after creates a separate empty line).
  useLayoutEffect(() => {
    if (!isStreaming || benchmarkEval) return;
    const host = blockRef.current?.querySelector(
      showStreamingContent
        ? ".text-block-live"
        : showAugmentHost
          ? ".text-block-markdown"
          : ".text-block-plain",
    );
    if (!host) return;
    let tail: Element | null = null;
    const update = () => {
      const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
      let next: Element | null = null;
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (
          node.textContent?.trim() &&
          !node.parentElement?.closest("button, [aria-hidden='true']")
        )
          next = node.parentElement;
      }
      if (next === tail) return;
      tail?.classList.remove("text-streaming-tail");
      tail = next;
      tail?.classList.add("text-streaming-tail");
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(host, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    return () => {
      observer.disconnect();
      tail?.classList.remove("text-streaming-tail");
    };
  }, [isStreaming, showStreamingContent, showAugmentHost, benchmarkEval]);

  // Always render streaming container when isStreaming so refs are attached
  // before first augment arrives. Hidden until useStreamingContent becomes true.
  const renderStreamingContainer = isStreaming;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: click handler intercepts local media links only
    <div
      ref={blockRef}
      className={`text-block timeline-item${isStreaming ? " streaming" : ""}${asyncMessage ? " text-block-async" : phase === "commentary" ? " text-block-commentary" : ""}`}
      onClick={handleClick}
      onMouseDown={handleMouseDown}
    >
      {asyncMessage && (
        <div className="text-block-async-header">
          <div className="text-block-phase">
            {asyncMessage.questions?.length
              ? (i18n?.t("messageAsyncQuestion") ?? "Question for you")
              : (i18n?.t("messageAsyncUpdate") ?? "Async update")}
          </div>
          <div className="text-block-async-hint">
            {i18n?.t("messageAsyncHint") ??
              "The task keeps running. Type your answer in the message box and choose Reply & continue."}
          </div>
        </div>
      )}
      {!asyncMessage && phase === "commentary" && (
        <div className="text-block-phase">
          {i18n?.t("messagePhaseProgress") ?? "Progress"}
        </div>
      )}
      {/* Always render streaming elements when streaming so refs are ready for augments */}
      {renderStreamingContainer && (
        <div
          className="text-block-live"
          style={showStreamingContent ? undefined : { display: "none" }}
        >
          <div
            ref={streamingMarkdown.containerRef}
            className="streaming-blocks"
          />
          <span
            ref={streamingMarkdown.pendingRef}
            className="streaming-pending"
          />
        </div>
      )}

      {/* Show fallback content when not actively streaming */}
      {!showStreamingContent &&
        (benchmarkEval ? (
          <BenchmarkEvalResult block={benchmarkEval} />
        ) : augmentHtml ? (
          // Content is written by the layout effect above (see why there).
          <div ref={augmentHostRef} className="text-block-markdown" />
        ) : (
          // Plain text fallback (no server augment available)
          <p className="text-block-plain">
            {renderPlainTextWithFileLinks(text)}
          </p>
        ))}
      {filePreview}
    </div>
  );
});
