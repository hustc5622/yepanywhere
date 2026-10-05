import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useComposerAttachmentPreviews } from "../useComposerAttachmentPreviews";

vi.mock("../../lib/apiPath", () => ({ API_BASE: "/yep/api" }));

const fetchMock = vi.fn<typeof fetch>();
const createObjectURL = vi.fn<(blob: Blob) => string>();
const revokeObjectURL = vi.fn<(url: string) => void>();
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;

function image(id: string, apiPath = `/api/uploads/${id}`) {
  return { id, apiPath, mimeType: "image/png" };
}

function response(body = "image") {
  return { ok: true, blob: async () => new Blob([body]) } as Response;
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
  createObjectURL.mockImplementation(
    () => `blob:preview-${createObjectURL.mock.calls.length}`,
  );
});

afterEach(() => {
  cleanup();
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe("useComposerAttachmentPreviews", () => {
  it("fetches only uploaded images through the authenticated API prefix", async () => {
    fetchMock.mockResolvedValue(response());
    const { result } = renderHook(() =>
      useComposerAttachmentPreviews([
        image("first"),
        image("prefixed", "/yep/api/uploads/prefixed"),
        image("absolute", "https://example.test/picture.png"),
        { id: "text", apiPath: "/api/text", mimeType: "text/plain" },
        { id: "pending", mimeType: "image/png" },
      ]),
    );
    await waitFor(() => expect(Object.keys(result.current)).toHaveLength(3));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/yep/api/uploads/first",
      "/yep/api/uploads/prefixed",
      "https://example.test/picture.png",
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/yep/api/uploads/first",
      expect.objectContaining({
        credentials: "include",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("keeps in-flight and loaded previews across new arrays and parent renders", async () => {
    const pending = deferredResponse();
    fetchMock.mockReturnValue(pending.promise);
    const { result, rerender } = renderHook(() =>
      useComposerAttachmentPreviews([image("first")]),
    );
    rerender();
    rerender();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(response()));
    expect(result.current).toEqual({ first: "blob:preview-1" });
    rerender();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it("releases only removed previews, then releases the rest on unmount", async () => {
    fetchMock.mockResolvedValue(response());
    const { result, rerender, unmount } = renderHook(
      ({ items }) => useComposerAttachmentPreviews(items),
      { initialProps: { items: [image("first"), image("second")] } },
    );
    await waitFor(() => expect(Object.keys(result.current)).toHaveLength(2));
    const firstSignal = fetchMock.mock.calls[0]?.[1]?.signal;
    const secondSignal = fetchMock.mock.calls[1]?.[1]?.signal;
    rerender({ items: [image("second")] });
    expect(result.current).toEqual({ second: "blob:preview-2" });
    expect(firstSignal?.aborted).toBe(true);
    expect(secondSignal?.aborted).toBe(false);
    expect(revokeObjectURL.mock.calls).toEqual([["blob:preview-1"]]);
    unmount();
    expect(secondSignal?.aborted).toBe(true);
    expect(revokeObjectURL.mock.calls).toEqual([
      ["blob:preview-1"],
      ["blob:preview-2"],
    ]);
  });

  it("releases a loaded URL when an attachment path changes", async () => {
    fetchMock.mockResolvedValue(response());
    const { result, rerender } = renderHook(
      ({ path }) => useComposerAttachmentPreviews([image("first", path)]),
      { initialProps: { path: "/api/original" } },
    );
    await waitFor(() => expect(result.current.first).toBe("blob:preview-1"));
    rerender({ path: "/api/replacement" });
    expect(result.current).toEqual({});
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:preview-1");
    await waitFor(() => expect(result.current.first).toBe("blob:preview-2"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("ignores a late response from a replaced path even if fetch ignores abort", async () => {
    const stale = deferredResponse();
    fetchMock
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(response());
    const { result, rerender } = renderHook(
      ({ path }) => useComposerAttachmentPreviews([image("first", path)]),
      { initialProps: { path: "/api/original" } },
    );
    rerender({ path: "/api/replacement" });
    await waitFor(() => expect(result.current.first).toBe("blob:preview-1"));
    await act(async () => stale.resolve(response("stale")));
    expect(result.current).toEqual({ first: "blob:preview-1" });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("does not allocate a URL when a response arrives after unmount", async () => {
    const stale = deferredResponse();
    fetchMock.mockReturnValue(stale.promise);
    const { unmount } = renderHook(() =>
      useComposerAttachmentPreviews([image("first")]),
    );
    unmount();
    await act(async () => stale.resolve(response()));
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it.each(["network", "http"])(
    "keeps a failed %s preview empty without retries on each keystroke",
    async (failure) => {
      if (failure === "network")
        fetchMock.mockRejectedValue(new Error("offline"));
      else fetchMock.mockResolvedValue({ ok: false } as Response);
      const { result, rerender } = renderHook(() =>
        useComposerAttachmentPreviews([image("first")]),
      );
      await act(async () => {});
      rerender();
      expect(result.current).toEqual({});
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(createObjectURL).not.toHaveBeenCalled();
    },
  );
});
