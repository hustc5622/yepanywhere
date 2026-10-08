import { useState } from "react";

/** Decorative preview; the enclosing attachment button supplies its name. */
export function AttachmentThumbnail({
  src,
  className = "",
}: {
  src?: string | null;
  className?: string;
}) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  return (
    <span className={`attachment-thumbnail ${className}`} aria-hidden="true">
      {src && src !== failedSource && (
        <img
          key={src}
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={(event) => {
            event.currentTarget.dataset.loaded = "true";
          }}
          onError={() => setFailedSource(src)}
        />
      )}
    </span>
  );
}
