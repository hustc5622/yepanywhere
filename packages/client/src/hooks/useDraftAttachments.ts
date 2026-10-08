import type { UploadedFile } from "@yep-anywhere/shared";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useState,
} from "react";

/**
 * Persists the attachments of an unsent draft next to the draft text.
 *
 * Uploads already live on the server, so only the metadata needs to survive a
 * navigation: without this, switching sessions away and back left the inline
 * `@[name]` tokens in the restored draft text with no attachment behind them.
 */
function readStored(key: string): UploadedFile[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isUploadedFile);
  } catch {
    return [];
  }
}

function isUploadedFile(value: unknown): value is UploadedFile {
  if (!value || typeof value !== "object") return false;
  const file = value as Partial<UploadedFile>;
  return (
    typeof file.id === "string" &&
    typeof file.originalName === "string" &&
    typeof file.name === "string" &&
    typeof file.path === "string" &&
    typeof file.size === "number" &&
    typeof file.mimeType === "string"
  );
}

function writeStored(key: string, files: UploadedFile[]): void {
  try {
    if (files.length === 0) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify(files));
    }
  } catch {
    // localStorage might be full or unavailable
  }
}

export function useDraftAttachments(
  key: string,
): [UploadedFile[], Dispatch<SetStateAction<UploadedFile[]>>] {
  const [draft, setDraft] = useState(() => ({ key, files: readStored(key) }));

  // Reload when the draft (session) changes.
  useEffect(() => {
    setDraft((current) =>
      current.key === key ? current : { key, files: readStored(key) },
    );
  }, [key]);

  useEffect(() => {
    // Persist the key that owns these files, including a final state update
    // batched with navigation to another draft.
    writeStored(draft.key, draft.files);
  }, [draft]);

  const setFiles = useCallback<Dispatch<SetStateAction<UploadedFile[]>>>(
    (next) => {
      setDraft((current) => {
        if (current.key !== key) return current;
        return {
          key,
          files: typeof next === "function" ? next(current.files) : next,
        };
      });
    },
    [key],
  );

  return [draft.files, setFiles];
}
