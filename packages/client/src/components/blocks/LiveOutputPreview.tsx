import { useLayoutEffect, useMemo, useRef } from "react";

const LIVE_OUTPUT_MAX_LINES = 12;

/** Bounded tail, so new terminal output stays visible without scrolling. */
export function LiveOutputPreview({ output }: { output: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tail = useMemo(() => {
    const lines = output.replace(/\r\n?/g, "\n").split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-LIVE_OUTPUT_MAX_LINES).join("\n");
  }, [output]);

  // Wrapped lines can exceed the viewport even with a bounded line count.
  // Keep the newest output visible when that tail changes.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (tail && container) container.scrollTop = container.scrollHeight;
  }, [tail]);

  if (!tail.trim()) return null;

  return (
    <div ref={containerRef} className="tool-live-output" aria-live="polite">
      <pre>{tail}</pre>
    </div>
  );
}
