import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../../api/client";
import { SessionMetadataProvider } from "../../../contexts/SessionMetadataContext";
import { I18nProvider } from "../../../i18n";
import { TextBlock } from "../TextBlock";

vi.mock("../../../api/client", () => ({
  api: {
    getFile: vi.fn(),
    getFileRawUrl: vi.fn(
      () => "/api/projects/proj-1/files/raw?path=sample.txt",
    ),
  },
}));

function renderWithSessionMetadata(ui: React.ReactNode) {
  return render(
    <I18nProvider>
      <SessionMetadataProvider
        projectId="proj-1"
        projectPath="/Users/yueyuan/project"
        sessionId="session-1"
      >
        {ui}
      </SessionMetadataProvider>
    </I18nProvider>,
  );
}

describe("TextBlock", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("opens project-local markdown file links in the file viewer", async () => {
    vi.mocked(api.getFile).mockResolvedValue({
      metadata: {
        path: "transcripts/sample.txt",
        size: 20,
        mimeType: "text/plain",
        isText: true,
      },
      content: "corrected transcript",
      rawUrl: "/api/projects/proj-1/files/raw?path=transcripts%2Fsample.txt",
    });

    renderWithSessionMetadata(
      <TextBlock
        text=""
        augmentHtml={
          '<p><a href="/api/local-image?path=%2FUsers%2Fyueyuan%2Fproject%2Ftranscripts%2Fsample.txt">激进版 sample</a></p>'
        }
      />,
    );

    fireEvent.click(screen.getByText("激进版 sample"));

    await waitFor(() => {
      expect(api.getFile).toHaveBeenCalledWith(
        "proj-1",
        "transcripts/sample.txt",
        true,
      );
    });
    expect(await screen.findByText("corrected transcript")).toBeTruthy();
  });

  it("opens project-external local markdown links in the local file modal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            metadata: {
              path: "/Users/yueyuan/.codex/AGENTS.md",
              size: 27,
              mimeType: "text/markdown",
              isText: true,
            },
            content: "# Global Agents\n\nUse rg first.",
            rawUrl:
              "/api/local-file?path=%2FUsers%2Fyueyuan%2F.codex%2FAGENTS.md",
            lineNumber: 3,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    );

    renderWithSessionMetadata(
      <TextBlock
        text=""
        augmentHtml={
          '<p><a href="/api/local-file?path=%2FUsers%2Fyueyuan%2F.codex%2FAGENTS.md&amp;line=3" class="local-file-link" data-file-path="/Users/yueyuan/.codex/AGENTS.md" data-line="3">~/.codex/AGENTS.md</a></p>'
        }
      />,
    );

    fireEvent.click(screen.getByText("~/.codex/AGENTS.md"));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/local-file?path=%2FUsers%2Fyueyuan%2F.codex%2FAGENTS.md&line=3",
        { credentials: "include" },
      );
    });
    expect(await screen.findByText("Use rg first.")).toBeTruthy();
    expect(api.getFile).not.toHaveBeenCalled();
  });

  it("linkifies plain local image paths and opens the media modal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise(() => {
            // Keep the image request pending so the modal remains in loading state.
          }),
      ),
    );

    renderWithSessionMetadata(
      <TextBlock text={"Saved image:\n\n/tmp/kitten.png"} />,
    );

    const link = screen.getByRole("link", { name: /\/tmp\/kitten\.png/i });
    expect(link.getAttribute("href")).toBe(
      "/api/local-image?path=%2Ftmp%2Fkitten.png",
    );
    expect(link.getAttribute("data-media-type")).toBe("image");

    fireEvent.click(link);

    expect(await screen.findByText("Loading...")).toBeTruthy();
  });

  it("marks plain fallback text as pre-wrapped so Codex markdown newlines stay visible", () => {
    const text = "First paragraph\n\n- item 1\n- item 2\n\nSecond paragraph";

    const { container } = renderWithSessionMetadata(<TextBlock text={text} />);

    const paragraph = container.querySelector(".text-block-plain");

    expect(paragraph?.textContent).toBe(text);
  });

  it("does not render a block-level copy button", () => {
    renderWithSessionMetadata(<TextBlock text="alpha beta gamma" />);

    expect(screen.queryByRole("button", { name: "Copy markdown" })).toBeNull();
  });
});
