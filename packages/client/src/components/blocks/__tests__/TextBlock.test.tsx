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

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "clipboard",
);

vi.mock("../../../api/client", () => ({
  api: {
    getFilePreview: vi.fn(),
  },
}));

function textPreview(path: string, content: string, mimeType = "text/plain") {
  return {
    kind: "text" as const,
    metadata: {
      path,
      absolutePath: path,
      size: content.length,
      mimeType,
      isText: true,
    },
    content,
    rawUrl: `/api/fs/raw?path=${encodeURIComponent(path)}`,
  };
}

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

  it.each([
    ["<p>Paragraph</p>", "p"],
    ["<ul><li>First</li><li><strong>Last</strong></li></ul>", "strong"],
    ["<pre><code>const x = 1;</code></pre>", "code"],
  ])(
    "anchors the cursor inside the final content element: %s",
    (augmentHtml, tag) => {
      const { container, rerender } = render(
        <TextBlock text="text" augmentHtml={augmentHtml} isStreaming />,
      );
      const tails = container.querySelectorAll(".text-streaming-tail");
      expect(tails).toHaveLength(1);
      expect(tails[0]?.tagName.toLowerCase()).toBe(tag);
      expect(
        container
          .querySelector(".text-block-markdown")
          ?.classList.contains("text-streaming-tail"),
      ).toBe(false);
      rerender(<TextBlock text="text" augmentHtml={augmentHtml} />);
      expect(container.querySelector(".text-streaming-tail")).toBeNull();
    },
  );

  it("opens project-local files linked through the legacy media endpoint", async () => {
    const path = "/Users/yueyuan/project/transcripts/sample.txt";
    vi.mocked(api.getFilePreview).mockResolvedValue(
      textPreview(path, "corrected transcript"),
    );

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
      expect(api.getFilePreview).toHaveBeenCalledWith({ path }, true);
    });
    expect(await screen.findByText("corrected transcript")).toBeTruthy();
  });

  it.each([
    "docs/reports/acceptance.md",
    "./docs/reports/acceptance.md",
    "docs/../docs/reports/acceptance.md",
    "../project/docs/reports/acceptance.md",
  ])(
    "opens the relative file link %s against the session project",
    async (path) => {
      const absolute = "/Users/yueyuan/project/docs/reports/acceptance.md";
      vi.mocked(api.getFilePreview).mockResolvedValue(
        textPreview(absolute, "验收报告原文", "text/markdown"),
      );
      renderWithSessionMetadata(
        <TextBlock
          text={`[完整验收记录](${path})`}
          augmentHtml={`<p><a href="/api/local-file?path=${encodeURIComponent(path)}" class="local-file-link" data-file-path="${path}">[完整验收记录](${path})</a></p>`}
        />,
      );

      const link = screen.getByRole("link", {
        name: `[完整验收记录](${path})`,
      });
      expect(link.textContent).toBe(`[完整验收记录](${path})`);
      fireEvent.click(link);

      await waitFor(() => {
        expect(api.getFilePreview).toHaveBeenCalledWith(
          { path: absolute },
          true,
        );
      });
      expect(await screen.findByText("验收报告原文")).toBeTruthy();
    },
  );

  it("keeps a text selection inside a link instead of navigating", () => {
    renderWithSessionMetadata(
      <TextBlock
        text=""
        augmentHtml='<p>See <a href="/api/local-file?path=docs%2Freport.md" class="local-file-link" data-file-path="docs/report.md">[报告](docs/report.md)</a> and <a href="https://example.com/x">[外链](https://example.com/x)</a></p>'
      />,
    );

    for (const name of [
      "[报告](docs/report.md)",
      "[外链](https://example.com/x)",
    ]) {
      const link = screen.getByRole("link", { name });
      fireEvent.mouseDown(link);
      expect(link.getAttribute("draggable")).toBe("false");

      const textNode = link.firstChild as Text;
      const range = document.createRange();
      range.setStart(textNode, 1);
      range.setEnd(textNode, 5);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);

      const event = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      });
      link.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      selection?.removeAllRanges();
    }

    expect(api.getFilePreview).not.toHaveBeenCalled();
  });

  it("opens modified clicks in the standalone file page", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    try {
      renderWithSessionMetadata(
        <TextBlock
          text="[报告](docs/report.md)"
          augmentHtml='<a href="/api/local-file?path=docs%2Freport.md" class="local-file-link" data-file-path="docs/report.md">报告</a>'
        />,
      );
      fireEvent.click(screen.getByRole("link", { name: "报告" }), {
        ctrlKey: true,
      });
      expect(open).toHaveBeenCalledWith(
        "/file?path=%2FUsers%2Fyueyuan%2Fproject%2Fdocs%2Freport.md",
        "_blank",
      );
      expect(api.getFilePreview).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
    }
  });

  it("opens files outside the project in the same viewer and targets the line", async () => {
    const path = "/Users/yueyuan/.codex/AGENTS.md";
    vi.mocked(api.getFilePreview).mockResolvedValue(
      textPreview(path, "# Global Agents\n\nUse rg first.", "text/markdown"),
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
      expect(api.getFilePreview).toHaveBeenCalledWith({ path }, true);
    });
    const line = await screen.findByText("Use rg first.");
    expect(line.classList.contains("highlighted-line")).toBe(true);
  });

  it("linkifies plain local image paths and opens them in the file viewer", async () => {
    vi.mocked(api.getFilePreview).mockResolvedValue({
      kind: "image",
      metadata: {
        path: "/tmp/kitten.png",
        absolutePath: "/tmp/kitten.png",
        size: 4,
        mimeType: "image/png",
        isText: false,
      },
      rawUrl: "/api/fs/raw?path=%2Ftmp%2Fkitten.png",
    });

    renderWithSessionMetadata(
      <TextBlock text={"Saved image:\n\n/tmp/kitten.png"} />,
    );

    const link = screen.getByRole("link", { name: /\/tmp\/kitten\.png/i });
    expect(link.getAttribute("href")).toBe(
      "/api/local-image?path=%2Ftmp%2Fkitten.png",
    );
    expect(link.getAttribute("data-media-type")).toBe("image");

    fireEvent.click(link);

    const image = await screen.findByRole("img", { name: "kitten.png" });
    expect(image.getAttribute("src")).toBe(
      "/api/fs/raw?path=%2Ftmp%2Fkitten.png",
    );
  });

  it("links non-media paths in plain fallback text with the same rule as the server", async () => {
    vi.mocked(api.getFilePreview).mockResolvedValue(
      textPreview("/Users/yueyuan/project/src/a.ts", "export {}"),
    );
    renderWithSessionMetadata(
      <TextBlock text={"See src/a.ts:3 and /tmp/run.log but not src/utils"} />,
    );

    expect(screen.queryByRole("link", { name: "src/utils" })).toBeNull();
    expect(screen.getByRole("link", { name: "/tmp/run.log" }).className).toBe(
      "local-file-link",
    );
    fireEvent.click(screen.getByRole("link", { name: "src/a.ts:3" }));
    await waitFor(() => {
      expect(api.getFilePreview).toHaveBeenCalledWith(
        { path: "/Users/yueyuan/project/src/a.ts" },
        true,
      );
    });
  });

  it("marks plain fallback text as pre-wrapped so Codex markdown newlines stay visible", () => {
    const text = "First paragraph\n\n- item 1\n- item 2\n\nSecond paragraph";

    const { container } = renderWithSessionMetadata(<TextBlock text={text} />);

    const paragraph = container.querySelector(".text-block-plain");

    expect(paragraph?.textContent).toBe(text);
  });

  it("labels an async final_answer as a question without a progress or completion label", () => {
    const { container } = renderWithSessionMetadata(
      <TextBlock
        text="Which address?"
        phase="final_answer"
        asyncMessage={{
          delivery: "async",
          questions: [
            { title: "Which address?", options: ["Production", "Local"] },
          ],
        }}
      />,
    );
    expect(screen.getByText("Question for you")).toBeDefined();
    expect(
      screen.getByText(
        "The task keeps running. Type your answer in the message box and choose Reply & continue.",
      ),
    ).toBeDefined();
    expect(screen.getByText("Which address?")).toBeDefined();
    expect(container.querySelector(".text-block-async")).not.toBeNull();
    expect(container.querySelector(".text-block-commentary")).toBeNull();
  });

  it("labels older async messages without structured questions", () => {
    renderWithSessionMetadata(
      <TextBlock
        text="Update"
        phase="final_answer"
        asyncMessage={{ delivery: "async" }}
      />,
    );
    expect(screen.getByText("Async update")).toBeDefined();
  });

  it("highlights Codex commentary as a visible progress update", () => {
    const { container } = renderWithSessionMetadata(
      <TextBlock
        text="I am checking the official integration status."
        phase="commentary"
      />,
    );

    expect(screen.getByText("Progress")).toBeDefined();
    expect(container.querySelector(".text-block-commentary")).not.toBeNull();
    expect(
      screen.getByText("I am checking the official integration status."),
    ).toBeDefined();
  });

  it("does not render a block-level copy button", () => {
    renderWithSessionMetadata(<TextBlock text="alpha beta gamma" />);

    expect(screen.queryByRole("button", { name: "Copy markdown" })).toBeNull();
  });
});

describe("TextBlock server-rendered markdown", () => {
  afterEach(() => {
    cleanup();
    if (originalClipboardDescriptor) {
      Object.defineProperty(
        navigator,
        "clipboard",
        originalClipboardDescriptor,
      );
    } else {
      Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("copies the exact plain text from a fenced code block", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    renderWithSessionMetadata(
      <TextBlock
        text={"```text\nfirst line\nsecond <tag>\n```"}
        augmentHtml={
          '<pre class="shiki"><code><span class="line">first line</span>\n<span class="line">second &lt;tag&gt;</span></code></pre>'
        }
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Copy code block" }),
    );

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("first line\nsecond <tag>");
    });
    expect(screen.getByRole("button", { name: "Copied!" })).toBeTruthy();
  });

  it("keeps the rendered nodes when the same HTML is applied again", () => {
    const html = "<p>stable paragraph</p>";
    const { rerender } = renderWithSessionMetadata(
      <TextBlock text="stable paragraph" augmentHtml={html} />,
    );
    const paragraph = screen.getByText("stable paragraph");

    // React re-applies this prop on some commits (a load-older prepend applies
    // the identical string twice); recreating the nodes would drop any live
    // text selection inside them.
    rerender(
      <I18nProvider>
        <SessionMetadataProvider
          projectId="proj-1"
          projectPath="/Users/yueyuan/project"
          sessionId="session-1"
        >
          <TextBlock text="stable paragraph" augmentHtml={`${html}`} />
        </SessionMetadataProvider>
      </I18nProvider>,
    );

    expect(screen.getByText("stable paragraph")).toBe(paragraph);
  });

  it("replaces the rendered nodes when the HTML actually changes", () => {
    const { rerender } = renderWithSessionMetadata(
      <TextBlock text="first" augmentHtml="<p>first</p>" />,
    );
    expect(screen.getByText("first")).toBeTruthy();

    rerender(
      <I18nProvider>
        <SessionMetadataProvider
          projectId="proj-1"
          projectPath="/Users/yueyuan/project"
          sessionId="session-1"
        >
          <TextBlock text="second" augmentHtml="<p>second</p>" />
        </SessionMetadataProvider>
      </I18nProvider>,
    );
    expect(screen.getByText("second")).toBeTruthy();
    expect(screen.queryByText("first")).toBeNull();
  });

  it("adds a copy button when a streamed code block replaces other HTML", async () => {
    const { rerender } = renderWithSessionMetadata(
      <TextBlock text="first" augmentHtml="<p>first</p>" />,
    );
    expect(
      screen.queryByRole("button", { name: "Copy code block" }),
    ).toBeNull();

    rerender(
      <I18nProvider>
        <SessionMetadataProvider
          projectId="proj-1"
          projectPath="/Users/yueyuan/project"
          sessionId="session-1"
        >
          <TextBlock
            text="```text\nlate code\n```"
            augmentHtml={'<pre class="shiki"><code>late code</code></pre>'}
          />
        </SessionMetadataProvider>
      </I18nProvider>,
    );

    expect(
      await screen.findByRole("button", { name: "Copy code block" }),
    ).toBeTruthy();
  });
});
