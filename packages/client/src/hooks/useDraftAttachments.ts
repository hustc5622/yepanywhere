import type { UploadedFile } from "@yep-anywhere/shared";
import {
  type Dispatch,
  type SetStateAction,
  useEffect,
  useRef,
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
  const [files, setFiles] = useState<UploadedFile[]>(() => readStored(key));
  const keyRef = useRef(key);

  // Reload when the draft (session) changes.
  useEffect(() => {
    keyRef.current = key;
    setFiles(readStored(key));
  }, [key]);

  useEffect(() => {
    writeStored(keyRef.current, files);
  }, [files]);

  return [files, setFiles];
}
