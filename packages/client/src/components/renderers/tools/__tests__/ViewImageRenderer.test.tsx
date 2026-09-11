import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../../i18n";
import { viewImageRenderer } from "../ViewImageRenderer";

const imageFetch = vi.hoisted(() =>
  vi.fn((path: string | null) => ({
    url: path,
    loading: false,
    error: null,
    bytes: null,
    mimeType: null,
  })),
);
vi.mock("../../../../hooks/useRemoteImage", () => ({
  useFetchedImage: imageFetch,
}));

const renderContext = {
  isStreaming: false,
  theme: "dark" as const,
};

describe("ViewImageRenderer", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("keeps same-path tool calls attached to their own recorded images", () => {
    for (const id of ["image-1", "image-2"]) {
      const snapshotUrl = `/api/sessions/session/codex-images/${id}`;
      render(
        <I18nProvider>
          {viewImageRenderer.renderInteractiveSummary?.(
            { path: "/tmp/phone.png", snapshotUrl },
            undefined,
            false,
            renderContext,
          )}
        </I18nProvider>,
      );
      expect(imageFetch).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: /phone.png/i }));
      expect(imageFetch).toHaveBeenCalledWith(`${snapshotUrl}?attempt=0`);
      expect(screen.getByRole("img").getAttribute("src")).toBe(
        `${snapshotUrl}?attempt=0`,
      );
      cleanup();
      vi.clearAllMocks();
    }
  });

  it("shows an unavailable snapshot without falling back to the source file, and allows retry", () => {
    imageFetch.mockReturnValueOnce({
      url: null,
      loading: false,
      error: null,
      bytes: null,
      mimeType: null,
    });
    const snapshotUrl = "/api/sessions/session/codex-images/image-1";
    render(
      <I18nProvider>
        {viewImageRenderer.renderToolUse(
          { path: "/tmp/phone.png", snapshotUrl },
          renderContext,
        )}
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /phone.png/i }));
    expect(screen.queryByRole("img")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /retry|重试/i }));
    expect(imageFetch).toHaveBeenLastCalledWith(`${snapshotUrl}?attempt=1`);
  });

  it("uses the saved image filename instead of the generic generated title", () => {
    const input = {
      title: "Generated image",
      path: "/Users/test/.codex/generated_images/session-1/ig_123.png",
      status: "completed",
    };

    expect(viewImageRenderer.getUseSummary?.(input)).toBe("ig_123.png");

    render(
      <div>
        {viewImageRenderer.renderInteractiveSummary?.(
          input,
          undefined,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(screen.getByRole("button", { name: /ig_123\.png/i })).toBeDefined();
    expect(screen.queryByText("Generated image")).toBeNull();
  });

  it("uses the URL filename when the image source is remote", () => {
    expect(
      viewImageRenderer.getUseSummary?.({
        title: "Generated image",
        url: "https://example.test/assets/preview-final.webp",
      }),
    ).toBe("preview-final.webp");
  });

  it("shows image dimensions after the modal image loads", async () => {
    const input = {
      url: "https://example.test/assets/preview-final.webp",
    };

    render(
      <I18nProvider>
        {viewImageRenderer.renderToolResult?.({}, false, renderContext, input)}
      </I18nProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /preview-final\.webp/i }),
    );

    const image = await screen.findByRole("img", {
      name: /preview-final\.webp/i,
    });
    Object.defineProperty(image, "naturalWidth", {
      value: 640,
      configurable: true,
    });
    Object.defineProperty(image, "naturalHeight", {
      value: 480,
      configurable: true,
    });

    fireEvent.load(image);

    expect(screen.getByText("Dimensions 640x480")).toBeDefined();
  });
});
