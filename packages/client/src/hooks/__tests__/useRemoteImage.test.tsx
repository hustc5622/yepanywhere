import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("useRemoteImage", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("prefixes API image URLs with the Vite base path", async () => {
    vi.stubEnv("BASE_URL", "/yep/");
    vi.resetModules();

    const { preloadRemoteImage, useRemoteImage } = await import(
      "../useRemoteImage"
    );
    const apiUrl = "/api/projects/proj-123/sessions/sess-456/upload/image.png";

    const { result } = renderHook(() => useRemoteImage(apiUrl));

    expect(result.current.url).toBe(
      "/yep/api/projects/proj-123/sessions/sess-456/upload/image.png",
    );
    await expect(preloadRemoteImage(apiUrl)).resolves.toBe(
      "/yep/api/projects/proj-123/sessions/sess-456/upload/image.png",
    );
  });

  it("does not duplicate an already-prefixed API image URL", async () => {
    vi.stubEnv("BASE_URL", "/yep/");
    vi.resetModules();

    const { useRemoteImage } = await import("../useRemoteImage");
    const { result } = renderHook(() =>
      useRemoteImage("/yep/api/local-image?path=%2Ftmp%2Fshot.png"),
    );

    expect(result.current.url).toBe(
      "/yep/api/local-image?path=%2Ftmp%2Fshot.png",
    );
  });

  it("reports URL, status, content type, and response body for failed image requests", async () => {
    vi.stubEnv("BASE_URL", "/yep/");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "File not found" }), {
          status: 404,
          statusText: "Not Found",
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    vi.resetModules();

    const { useFetchedImage } = await import("../useRemoteImage");
    const apiUrl = "/api/projects/proj/sessions/session/upload/image.jpg";
    const { result } = renderHook(() => useFetchedImage(apiUrl));

    await waitFor(() => {
      expect(result.current.error).toContain("HTTP 404 Not Found");
    });
    expect(result.current.error).toContain(
      "URL: /yep/api/projects/proj/sessions/session/upload/image.jpg",
    );
    expect(result.current.error).toContain("Content-Type: application/json");
    expect(result.current.error).toContain(
      'Response: {"error":"File not found"}',
    );
    expect(consoleError).toHaveBeenCalledWith(
      "[useFetchedImage] Failed to fetch image",
      expect.objectContaining({
        requestUrl: "/yep/api/projects/proj/sessions/session/upload/image.jpg",
      }),
    );
  });
});
