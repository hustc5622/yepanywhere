import type { UploadedFile } from "@yep-anywhere/shared";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useRef,
  useState,
} from "react";
import type { ComposerAttachment } from "../components/AttachmentComposer";
import type { UploadProgress } from "../components/MessageInput";
import { generateUUID } from "../lib/uuid";
import { useConnection } from "./useConnection";

/** Managed download path of an upload, as the composer and clipboard use it. */
export function uploadedFileApiPath(
  projectId: string,
  sessionId: string,
  file: Pick<UploadedFile, "name">,
): string {
  return `/api/projects/${projectId}/sessions/${sessionId}/upload/${encodeURIComponent(file.name)}`;
}

function sortByOrder(files: UploadedFile[], order: string[]): UploadedFile[] {
  return files.sort(
    (left, right) => order.indexOf(left.id) - order.indexOf(right.id),
  );
}

type AttachmentState = [
  UploadedFile[],
  Dispatch<SetStateAction<UploadedFile[]>>,
];

interface Options {
  projectId?: string;
  sessionId?: string;
  onError?: (file: File, error: unknown) => void;
  /**
   * Completed uploads owned by the caller (e.g. persisted with the draft).
   * Omitted: kept in memory by this hook.
   */
  state?: AttachmentState;
}

/**
 * Upload-on-attach state for a composer bound to an existing session:
 * files upload immediately, keep their selection order (including uploads
 * still in flight), can be removed or restored by native undo, and senders
 * can wait for in-flight uploads. Used by replies and side chats.
 */
export function useComposerUploads({
  projectId,
  sessionId,
  onError,
  state,
}: Options) {
  const connection = useConnection();
  const localState = useState<UploadedFile[]>([]);
  const [attachments, setAttachments] = state ?? localState;
  const [uploadProgress, setUploadProgress] = useState<UploadProgress[]>([]);
  const orderRef = useRef<string[]>([]);
  const removedRef = useRef(new Map<string, UploadedFile>());
  const cancelledRef = useRef(new Set<string>());
  const pendingRef = useRef(new Map<string, Promise<UploadedFile | null>>());

  // Restored drafts bring attachments the order has not seen yet.
  for (const file of attachments) {
    if (!orderRef.current.includes(file.id)) orderRef.current.push(file.id);
  }

  const attach = useCallback(
    (files: File[], beforeAttachmentId?: string) => {
      if (!projectId || !sessionId) return;
      for (const file of files) {
        const tempId = generateUUID();
        const order = orderRef.current;
        const anchor = beforeAttachmentId
          ? order.indexOf(beforeAttachmentId)
          : -1;
        order.splice(anchor < 0 ? order.length : anchor, 0, tempId);
        setUploadProgress((prev) => [
          ...prev,
          {
            fileId: tempId,
            fileName: file.name,
            mimeType: file.type,
            bytesUploaded: 0,
            totalBytes: file.size,
            percent: 0,
          },
        ]);
        const upload = connection
          .upload(projectId, sessionId, file, {
            onProgress: (bytesUploaded) =>
              setUploadProgress((prev) =>
                prev.map((progress) =>
                  progress.fileId === tempId
                    ? {
                        ...progress,
                        bytesUploaded,
                        percent: Math.round(
                          (bytesUploaded / Math.max(file.size, 1)) * 100,
                        ),
                      }
                    : progress,
                ),
              ),
          })
          .then(
            (uploaded) => {
              if (cancelledRef.current.has(tempId)) return null;
              const index = orderRef.current.indexOf(tempId);
              if (index >= 0) orderRef.current[index] = uploaded.id;
              else orderRef.current.push(uploaded.id);
              setAttachments((prev) =>
                sortByOrder([...prev, uploaded], orderRef.current),
              );
              return uploaded;
            },
            (error) => {
              if (!cancelledRef.current.has(tempId)) onError?.(file, error);
              return null;
            },
          )
          .finally(() => {
            setUploadProgress((prev) =>
              prev.filter((progress) => progress.fileId !== tempId),
            );
            pendingRef.current.delete(tempId);
            cancelledRef.current.delete(tempId);
          });
        pendingRef.current.set(tempId, upload);
      }
    },
    [connection, onError, projectId, sessionId, setAttachments],
  );

  const remove = useCallback(
    (ids: string[]) => {
      for (const id of ids) {
        if (pendingRef.current.has(id)) {
          cancelledRef.current.add(id);
          // A sender must not wait for an upload the user removed.
          pendingRef.current.delete(id);
        }
      }
      setAttachments((prev) => {
        for (const file of prev) {
          if (ids.includes(file.id)) removedRef.current.set(file.id, file);
        }
        return prev.filter((file) => !ids.includes(file.id));
      });
      setUploadProgress((prev) =>
        prev.filter((progress) => !ids.includes(progress.fileId)),
      );
    },
    [setAttachments],
  );

  /** Put back a completed upload (native undo after removal). */
  const restoreFile = useCallback(
    (file: UploadedFile) => {
      removedRef.current.delete(file.id);
      setAttachments((prev) =>
        sortByOrder(
          [...prev.filter((item) => item.id !== file.id), file],
          orderRef.current,
        ),
      );
    },
    [setAttachments],
  );

  const restore = useCallback(
    (ids: string[]) => {
      for (const id of ids) {
        const file = removedRef.current.get(id);
        if (file) restoreFile(file);
      }
    },
    [restoreFile],
  );

  /** Ignore every in-flight upload (their completions will not enter the draft). */
  const cancelPending = useCallback(() => {
    for (const id of pendingRef.current.keys()) cancelledRef.current.add(id);
    pendingRef.current.clear();
    setUploadProgress([]);
  }, []);

  const clear = useCallback(() => {
    cancelPending();
    orderRef.current = [];
    removedRef.current.clear();
    setAttachments([]);
  }, [cancelPending, setAttachments]);

  /** Replace the selection order (e.g. when a historical edit restores files). */
  const setOrder = useCallback((ids: string[]) => {
    orderRef.current = [...ids];
  }, []);

  /** Uploaded and in-flight attachments, in selection order. */
  const composerAttachments: ComposerAttachment[] = [
    ...attachments.map((file) => ({
      id: file.id,
      name: file.originalName,
      mimeType: file.mimeType,
      apiPath:
        projectId && sessionId
          ? uploadedFileApiPath(projectId, sessionId, file)
          : undefined,
    })),
    ...uploadProgress.map((progress) => ({
      id: progress.fileId,
      name: progress.fileName,
      mimeType: progress.mimeType,
      pending: true,
      progress: progress.percent,
    })),
  ].sort(
    (left, right) =>
      orderRef.current.indexOf(left.id) - orderRef.current.indexOf(right.id),
  );

  return {
    attachments,
    setAttachments,
    uploadProgress,
    composerAttachments,
    orderRef,
    hasPendingUploads: uploadProgress.length > 0,
    /** In-flight uploads now; each resolves to the upload or null. */
    pendingUploads: () => [...pendingRef.current.values()],
    attach,
    remove,
    restore,
    restoreFile,
    cancelPending,
    clear,
    setOrder,
  };
}
