import { act, renderHook } from "@testing-library/react";
import type { UploadedFile } from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import { useComposerUploads } from "../useComposerUploads";

vi.mock("../useConnection", () => ({
  useConnection: () => ({ upload: vi.fn(), fetchBlob: vi.fn() }),
}));

function existing(id: string, sessionId: string): UploadedFile {
  const name = `${id}_shot.png`;
  return {
    id,
    ref: `/api/projects/cA/sessions/${sessionId}/upload/${name}`,
    originalName: "shot.png",
    name,
    size: 3,
    mimeType: "image/png",
  };
}

describe("useComposerUploads", () => {
  it("adds existing uploads in order, once, and previews them by reference", () => {
    const { result } = renderHook(() =>
      useComposerUploads({ projectId: "cA", sessionId: "current" }),
    );
    const first = existing("11111111-1111-4111-8111-111111111111", "other");
    const second = existing("22222222-2222-4222-8222-222222222222", "current");

    act(() => result.current.attachExisting([second]));
    act(() => result.current.attachExisting([first, second], second.id));

    expect(result.current.attachments.map((file) => file.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(result.current.composerAttachments[0]?.apiPath).toBe(first.ref);
  });
});
