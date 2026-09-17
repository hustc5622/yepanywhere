import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enhanceReportImages } from "../reportImages";

const STRINGS = { failed: "Image failed to load", retry: "Retry" };
const IMAGE_SRC = "/yep/api/reports/image?path=report.md&image=assets%2Fa.png";

function renderArticle(src = IMAGE_SRC): HTMLElement {
  const article = document.createElement("article");
  article.innerHTML = `<p><img src="${src}" alt="chart"></p>`;
  document.body.append(article);
  return article;
}

function frameOf(article: HTMLElement): HTMLElement {
  const frame = article.querySelector<HTMLElement>(".report-image-frame");
  if (!frame) throw new Error("image frame missing");
  return frame;
}

describe("enhanceReportImages", () => {
  let createObjectURL: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    createObjectURL = vi.fn(() => "blob:report-image");
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL,
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("recovers a failed native load through the authenticated fetch", async () => {
    const article = renderArticle();
    const loadImage = vi
      .fn()
      .mockResolvedValue(new Blob([new Uint8Array([1])]));
    enhanceReportImages(article, {
      signal: new AbortController().signal,
      loadImage,
      preferFetch: false,
      strings: STRINGS,
    });

    const image = article.querySelector("img") as HTMLImageElement;
    expect(loadImage).not.toHaveBeenCalled();

    image.dispatchEvent(new Event("error"));
    await vi.waitFor(() =>
      expect(loadImage).toHaveBeenCalledWith(IMAGE_SRC, expect.anything()),
    );
    await vi.waitFor(() => expect(image.src).toContain("blob:report-image"));
    expect(
      frameOf(article).classList.contains("report-image-load-failed"),
    ).toBe(false);
  });

  it("surfaces the HTTP status and a retry control when recovery fails", async () => {
    const article = renderArticle();
    const loadImage = vi
      .fn()
      .mockRejectedValueOnce(new Error("Failed to load report image: HTTP 404"))
      .mockResolvedValueOnce(new Blob([new Uint8Array([1])]));
    enhanceReportImages(article, {
      signal: new AbortController().signal,
      loadImage,
      preferFetch: false,
      strings: STRINGS,
    });

    const image = article.querySelector("img") as HTMLImageElement;
    image.dispatchEvent(new Event("error"));

    const frame = frameOf(article);
    await vi.waitFor(() =>
      expect(frame.classList.contains("report-image-load-failed")).toBe(true),
    );
    expect(frame.dataset.reportImageError).toBe(
      "Image failed to load · HTTP 404",
    );

    // The failure text must never become a text node: report comments are
    // anchored by text offsets over the article.
    expect(article.textContent).toBe("");

    const retry = frame.querySelector<HTMLButtonElement>(".report-image-retry");
    expect(retry?.dataset.label).toBe("Retry");
    retry?.click();

    await vi.waitFor(() =>
      expect(frame.classList.contains("report-image-load-failed")).toBe(false),
    );
    expect(loadImage.mock.calls[1]?.[0]).toContain("_retry=");
  });

  it("fetches immediately when the desktop token requires it", async () => {
    const article = renderArticle();
    const loadImage = vi
      .fn()
      .mockResolvedValue(new Blob([new Uint8Array([1])]));
    enhanceReportImages(article, {
      signal: new AbortController().signal,
      loadImage,
      preferFetch: true,
      strings: STRINGS,
    });

    await vi.waitFor(() => expect(loadImage).toHaveBeenCalledTimes(1));
  });

  it("ignores images that are not served by the reports endpoint", () => {
    const article = renderArticle("https://example.com/chart.png");
    const loadImage = vi.fn();
    enhanceReportImages(article, {
      signal: new AbortController().signal,
      loadImage,
      preferFetch: true,
      strings: STRINGS,
    });

    expect(article.querySelector(".report-image-frame")).toBeNull();
    expect(loadImage).not.toHaveBeenCalled();
  });
});
