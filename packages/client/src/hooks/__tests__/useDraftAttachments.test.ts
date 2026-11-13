import { act, renderHook } from "@testing-library/react";
import type { UploadedFile } from "@yep-anywhere/shared";
import { useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { useDraftAttachments } from "../useDraftAttachments";

const storedName = "123e4567-e89b-12d3-a456-426614174000_shot.png";
const file: UploadedFile = {
  id: "file-1",
  ref: `/api/projects/cA/sessions/s/upload/${storedName}`,
  originalName: "shot.png",
  name: storedName,
  size: 10,
  mimeType: "image/png",
};

describe("useDraftAttachments", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("restores attachments saved under the same key", () => {
    const first = renderHook(() => useDraftAttachments("draft-a"));
    act(() => first.result.current[1]([file]));
    first.unmount();

    const second = renderHook(() => useDraftAttachments("draft-a"));
    expect(second.result.current[0]).toEqual([file]);
  });

  it("keeps drafts separate per key and clears when emptied", () => {
    const { result, rerender } = renderHook(
      ({ key }) => useDraftAttachments(key),
      { initialProps: { key: "draft-a" } },
    );
    act(() => result.current[1]([file]));

    rerender({ key: "draft-b" });
    expect(result.current[0]).toEqual([]);

    rerender({ key: "draft-a" });
    expect(result.current[0]).toEqual([file]);

    act(() => result.current[1]([]));
    expect(localStorage.getItem("draft-a")).toBeNull();
  });

  it("migrates drafts saved with a server path to a managed reference", () => {
    const { ref: _ref, ...legacy } = file;
    localStorage.setItem(
      "draft-a",
      JSON.stringify([
        { ...legacy, path: `/home/u/.yep-anywhere/uploads/cA/s/${storedName}` },
      ]),
    );
    const { result } = renderHook(() => useDraftAttachments("draft-a"));
    expect(result.current[0]).toEqual([file]);
  });

  it("ignores malformed stored payloads", () => {
    localStorage.setItem("draft-a", '[{"id":1}]');
    const { result } = renderHook(() => useDraftAttachments("draft-a"));
    expect(result.current[0]).toEqual([]);
  });

  it("keeps a final attachment update with its source draft when navigation is batched", () => {
    const otherFile = { ...file, id: "file-b", originalName: "other.png" };
    localStorage.setItem("draft-b", JSON.stringify([otherFile]));
    const { result } = renderHook(() => {
      const [key, setKey] = useState("draft-a");
      const [files, setFiles] = useDraftAttachments(key);
      return { files, setFiles, setKey };
    });

    act(() => {
      result.current.setFiles([file]);
      result.current.setKey("draft-b");
    });

    expect(result.current.files).toEqual([otherFile]);
    expect(JSON.parse(localStorage.getItem("draft-a") ?? "null")).toEqual([
      file,
    ]);
    expect(JSON.parse(localStorage.getItem("draft-b") ?? "null")).toEqual([
      otherFile,
    ]);
  });

  it("ignores a completed upload callback captured for another session", () => {
    const { result, rerender } = renderHook(
      ({ key }) => useDraftAttachments(key),
      { initialProps: { key: "draft-a" } },
    );
    const completeOldUpload = result.current[1];
    rerender({ key: "draft-b" });
    act(() => completeOldUpload((files) => [...files, file]));

    expect(result.current[0]).toEqual([]);
    expect(localStorage.getItem("draft-b")).toBeNull();
  });
});
