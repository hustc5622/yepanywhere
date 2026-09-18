import { act, renderHook } from "@testing-library/react";
import type { UploadedFile } from "@yep-anywhere/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { useDraftAttachments } from "../useDraftAttachments";

const file: UploadedFile = {
  id: "file-1",
  originalName: "shot.png",
  name: "uuid_shot.png",
  path: "/uploads/p/s/uuid_shot.png",
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

  it("ignores malformed stored payloads", () => {
    localStorage.setItem("draft-a", '[{"id":1}]');
    const { result } = renderHook(() => useDraftAttachments("draft-a"));
    expect(result.current[0]).toEqual([]);
  });
});
