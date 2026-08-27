import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../../../i18n";
import { readMediaFileRenderer } from "../ReadMediaFileRenderer";

const renderContext = {
  isStreaming: false,
  theme: "dark" as const,
};

describe("ReadMediaFileRenderer", () => {
  afterEach(cleanup);

  it("renders a bounded image summary without raw payloads", () => {
    render(
      <I18nProvider>
        {readMediaFileRenderer.renderToolResult(
          {
            type: "media",
            kind: "image",
            path: "/tmp/example.png",
            mimeType: "image/png",
            bytes: 4096,
          },
          false,
          renderContext,
          { path: "/tmp/example.png" },
        )}
      </I18nProvider>,
    );

    expect(screen.getAllByText("example.png")).toHaveLength(2);
    expect(screen.getByText(/Image · image\/png · 4.0 KB/)).toBeDefined();
    expect(document.body.textContent).not.toContain("base64");
    expect(document.body.textContent).not.toContain("blobref");
  });

  it("renders video metadata without using an image element", () => {
    const { container } = render(
      <I18nProvider>
        {readMediaFileRenderer.renderToolResult(
          {
            type: "media",
            kind: "video",
            path: "/tmp/example.mp4",
            mimeType: "video/mp4",
          },
          false,
          renderContext,
          { path: "/tmp/example.mp4" },
        )}
      </I18nProvider>,
    );

    expect(screen.getByText("example.mp4")).toBeDefined();
    expect(screen.getByText(/Video · video\/mp4/)).toBeDefined();
    expect(container.querySelector("img")).toBeNull();
  });

  it("shows a safe fallback for missing media details", () => {
    render(
      <I18nProvider>
        {readMediaFileRenderer.renderToolResult(
          "media loaded",
          false,
          renderContext,
          {},
        )}
      </I18nProvider>,
    );

    expect(
      screen.getByText("Media loaded, but preview details are unavailable"),
    ).toBeDefined();
  });
});
