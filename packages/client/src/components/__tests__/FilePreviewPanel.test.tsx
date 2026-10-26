import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import {
  type FileRef,
  type FileSnapshot,
  fileRefFromPath,
} from "../../lib/fileRef";
import { UI_KEYS } from "../../lib/storageKeys";
import { FilePreviewPanel } from "../FilePreviewPanel";
import { FileViewer } from "../FileViewer";

const { getFilePreview, locateFile } = vi.hoisted(() => ({
  getFilePreview: vi.fn(),
  locateFile: vi.fn(),
}));
vi.mock("../../api/client", () => ({ api: { getFilePreview, locateFile } }));

function preview(
  path: string,
  kind: string,
  extra: Record<string, unknown> = {},
) {
  return {
    kind,
    metadata: {
      path,
      absolutePath: path,
      size: 10,
      mimeType: "application/octet-stream",
      isText: kind === "text" || kind === "markdown",
    },
    rawUrl: `/api/fs/raw?path=${encodeURIComponent(path)}`,
    ...extra,
  };
}

function renderViewer(fileRef: FileRef, snapshot?: FileSnapshot) {
  return render(
    <I18nProvider>
      <FileViewer fileRef={fileRef} snapshot={snapshot} />
    </I18nProvider>,
  );
}

describe("unified file preview", () => {
  beforeEach(() => {
    localStorage.setItem(UI_KEYS.locale, "en");
    getFilePreview.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it.each([
    ["/tmp/a.png", "image", "img"],
    ["/tmp/a.mp4", "video", "video"],
    ["/tmp/a.mp3", "audio", "audio"],
    ["/tmp/a.pdf", "pdf", "iframe"],
  ])("renders %s as %s from the raw endpoint", async (path, kind, tag) => {
    getFilePreview.mockResolvedValue(preview(path, kind));
    const { container } = renderViewer({ path });
    await waitFor(() => {
      expect(
        container.querySelector(`.file-viewer-body ${tag}`),
      ).not.toBeNull();
    });
    expect(
      container.querySelector(`.file-viewer-body ${tag}`)?.getAttribute("src"),
    ).toBe(`/api/fs/raw?path=${encodeURIComponent(path)}`);
  });

  it("offers a download for documents without an inline viewer", async () => {
    getFilePreview.mockResolvedValue(preview("/tmp/plan.docx", "office"));
    renderViewer({ path: "/tmp/plan.docx" });
    expect(
      await screen.findByRole("button", { name: "Download File" }),
    ).toBeTruthy();
  });

  it("switches between the current file and the tool snapshot", async () => {
    getFilePreview.mockResolvedValue(
      preview("/w/a.ts", "text", { content: "current body" }),
    );
    renderViewer(
      { path: "/w/a.ts" },
      { kind: "text", content: "snapshot body", startLine: 1 },
    );

    expect(await screen.findByText("current body")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Tool result" }));
    expect(screen.getByText("snapshot body")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Current file" }));
    expect(screen.getByText("current body")).toBeTruthy();
  });

  it("falls back to the snapshot when the file cannot be loaded", async () => {
    getFilePreview.mockRejectedValue(
      Object.assign(new Error("File not found"), {
        absolutePath: "/w/gone.ts",
      }),
    );
    renderViewer(
      { path: "/w/gone.ts", lineNumber: 11, lineEnd: 12 },
      {
        kind: "text",
        content: "line ten\nline eleven\nline twelve",
        startLine: 10,
      },
    );

    expect(
      await screen.findByText(
        "The file could not be loaded; showing what the tool read.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("line eleven").classList.contains("highlighted-line"),
    ).toBe(true);
    expect(
      screen.getByText("line ten").classList.contains("highlighted-line"),
    ).toBe(false);
    expect(screen.getByText("10")).toBeTruthy();
  });

  it("navigates in place when a file link inside a markdown preview is clicked", async () => {
    getFilePreview.mockImplementation(async (ref: FileRef) =>
      ref.path === "/docs/index.md"
        ? preview(ref.path, "markdown", {
            content: "[next](/docs/next.md)",
            renderedMarkdownHtml:
              '<p><a href="/api/local-file?path=%2Fdocs%2Fnext.md" class="local-file-link" data-file-path="/docs/next.md">next</a></p>',
          })
        : preview(ref.path, "text", { content: "second page" }),
    );

    render(
      <I18nProvider>
        <FilePreviewPanel
          fileRef={{ path: "/docs/index.md" }}
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );

    fireEvent.click(await screen.findByRole("link", { name: "next" }));
    expect(await screen.findByText("second page")).toBeTruthy();
    expect(getFilePreview).toHaveBeenLastCalledWith(
      { path: "/docs/next.md", projectId: undefined },
      true,
    );
  });

  it("shows CSV files as a table by default with a source toggle", async () => {
    getFilePreview.mockResolvedValue(
      preview("/d/data.csv", "text", { content: 'name,score\n"Bo, B",42\n' }),
    );
    renderViewer({ path: "/d/data.csv" });

    expect(
      await screen.findByRole("columnheader", { name: "name" }),
    ).toBeTruthy();
    expect(screen.getByRole("cell", { name: "Bo, B" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("renders converted spreadsheets with sheet tabs", async () => {
    getFilePreview.mockResolvedValue(
      preview("/d/book.xlsx", "office", {
        office: {
          format: "xlsx",
          truncatedSheets: false,
          sheets: [
            {
              name: "Data",
              rows: [["a", "b"]],
              totalRows: 1,
              truncatedRows: false,
              truncatedColumns: false,
            },
            {
              name: "Other",
              rows: [["z"]],
              totalRows: 1,
              truncatedRows: false,
              truncatedColumns: false,
            },
          ],
        },
      }),
    );
    renderViewer({ path: "/d/book.xlsx" });

    expect(await screen.findByRole("cell", { name: "a" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "B" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Other" }));
    expect(screen.getByRole("cell", { name: "z" })).toBeTruthy();
  });

  it("renders converted documents and slides", async () => {
    getFilePreview.mockResolvedValueOnce(
      preview("/d/plan.docx", "office", {
        office: {
          format: "docx",
          html: "<h1>Plan</h1><p>Body</p>",
          truncated: false,
        },
      }),
    );
    renderViewer({ path: "/d/plan.docx" });
    expect(await screen.findByRole("heading", { name: "Plan" })).toBeTruthy();
    cleanup();

    getFilePreview.mockResolvedValueOnce(
      preview("/d/deck.pptx", "office", {
        office: {
          format: "pptx",
          truncated: false,
          slides: [{ paragraphs: ["Intro", "Hello"] }],
        },
      }),
    );
    renderViewer({ path: "/d/deck.pptx" });
    expect(await screen.findByText("Slide 1 · Intro")).toBeTruthy();
    expect(screen.getByText("Hello")).toBeTruthy();
  });

  it("explains why an office document could not be converted", async () => {
    getFilePreview.mockResolvedValue(
      preview("/d/locked.xlsx", "office", { officeError: "Not a ZIP archive" }),
    );
    renderViewer({ path: "/d/locked.xlsx" });
    expect(
      await screen.findByText(
        "This document could not be previewed: Not a ZIP archive",
      ),
    ).toBeTruthy();
  });

  it("explains a relative path missing from its project and searches others on request", async () => {
    const notFound = Object.assign(new Error("File not found"), {
      status: 404,
      absolutePath: "/work/yep/src/flow/FlowView.tsx",
    });
    getFilePreview.mockImplementation(async (ref: FileRef) => {
      if (ref.path === "/work/data/src/flow/FlowView.tsx") {
        return preview(ref.path, "text", { content: "found it" });
      }
      throw notFound;
    });
    locateFile.mockResolvedValue({
      candidates: [
        {
          projectId: "p-yep",
          projectName: "yep",
          projectPath: "/work/yep",
          absolutePath: "/work/yep/src/flow/FlowView.tsx",
        },
        {
          projectId: "p-data",
          projectName: "data_flow_ui",
          projectPath: "/work/data",
          absolutePath: "/work/data/src/flow/FlowView.tsx",
        },
      ],
    });

    const ref = fileRefFromPath(
      "src/flow/FlowView.tsx",
      { projectId: "p-yep", projectPath: "/work/yep" },
      { lineNumber: 1 },
    );
    expect(ref.relative).toEqual({
      path: "src/flow/FlowView.tsx",
      baseDir: "/work/yep",
    });
    render(
      <I18nProvider>
        <FilePreviewPanel fileRef={ref} onClose={vi.fn()} />
      </I18nProvider>,
    );

    expect(
      await screen.findByText(
        '"src/flow/FlowView.tsx" was resolved against yep and is not there. It may belong to another project.',
      ),
    ).toBeTruthy();
    // Nothing is searched until the user asks.
    expect(locateFile).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Search other projects for this file",
      }),
    );
    expect(locateFile).toHaveBeenCalledWith("src/flow/FlowView.tsx");

    // The project that already missed is not offered again.
    const candidate = await screen.findByRole("button", {
      name: /data_flow_ui/,
    });
    expect(screen.queryByRole("button", { name: /^yep/ })).toBeNull();
    fireEvent.click(candidate);
    expect(await screen.findByText("found it")).toBeTruthy();
  });

  it("does not offer a project search for absolute paths or other errors", async () => {
    getFilePreview.mockRejectedValue(
      Object.assign(new Error("File not found"), { status: 404 }),
    );
    renderViewer({ path: "/tmp/missing.ts" });
    expect(await screen.findByText("File not found")).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "Search other projects for this file",
      }),
    ).toBeNull();
    cleanup();

    getFilePreview.mockRejectedValue(
      Object.assign(new Error("Path is not a file"), { status: 400 }),
    );
    renderViewer(fileRefFromPath("src", { projectPath: "/work/yep" }));
    expect(await screen.findByText("Path is not a file")).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "Search other projects for this file",
      }),
    ).toBeNull();
  });

  it("reports when no other project has the file", async () => {
    getFilePreview.mockRejectedValue(
      Object.assign(new Error("File not found"), { status: 404 }),
    );
    locateFile.mockResolvedValue({ candidates: [] });
    renderViewer(fileRefFromPath("docs/plan.md", { projectPath: "/work/yep" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Search other projects for this file",
      }),
    );
    expect(
      await screen.findByText("No other local project has this file."),
    ).toBeTruthy();
  });
});
