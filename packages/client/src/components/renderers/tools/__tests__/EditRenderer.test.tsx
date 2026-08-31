import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../../i18n";
import { UI_KEYS } from "../../../../lib/storageKeys";
import { editRenderer } from "../EditRenderer";

vi.mock("../../../../contexts/SchemaValidationContext", () => ({
  useSchemaValidationContext: () => ({
    enabled: false,
    reportValidationError: vi.fn(),
    isToolIgnored: vi.fn(() => false),
    ignoreToolErrors: vi.fn(),
    clearIgnoredTools: vi.fn(),
    ignoredTools: [],
  }),
}));

vi.mock("../../../../contexts/SessionMetadataContext", () => ({
  useSessionMetadata: () => ({ projectPath: "/workspace" }),
}));

const renderContext = {
  isStreaming: false,
  theme: "dark" as const,
};
if (!editRenderer.renderCollapsedPreview) {
  throw new Error("Edit renderer must provide collapsed preview");
}
const renderCollapsedPreview = editRenderer.renderCollapsedPreview;

describe("EditRenderer collapsed preview fallback", () => {
  it.each([false, true])(
    "shows an external filename and its distinct full label (diff ready: %s)",
    (withDiff) => {
      const path = "/tmp/example/api_request.py";
      if (!editRenderer.renderInteractiveSummary)
        throw new Error("Missing Edit summary");
      render(
        <div>
          {editRenderer.renderInteractiveSummary(
            {
              file_path: path,
              ...(withDiff
                ? {
                    _structuredPatch: [
                      {
                        oldStart: 1,
                        oldLines: 1,
                        newStart: 1,
                        newLines: 1,
                        lines: ["-old", "+new"],
                      },
                    ],
                  }
                : {}),
            } as never,
            undefined,
            false,
            renderContext,
          )}
        </div>,
      );
      expect(screen.getByTitle(path).textContent).toContain("api_request.py");
      expect(screen.queryByText("[path hidden]")).toBeNull();
    },
  );

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("opens a short structured Edit diff in the detail panel", () => {
    localStorage.setItem(UI_KEYS.locale, "en");
    vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    const input = {
      file_path: "/workspace/src/example.ts",
      old_string: "const x = 1;",
      new_string: "const x = 2;",
      _structuredPatch: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: ["-const x = 1;", "+const x = 2;"],
        },
      ],
    };

    render(
      <I18nProvider>
        <div>
          {renderCollapsedPreview(
            input as never,
            { ok: true } as never,
            false,
            renderContext,
          )}
        </div>
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show full diff" }));
    expect(screen.getByRole("dialog", { name: "example.ts" })).toBeDefined();
  });

  it("renders raw patch text for completed rows when structured patch is missing", () => {
    const input = {
      _rawPatch: [
        "*** Begin Patch",
        "*** Update File: src/example.ts",
        "@@",
        "-const x = 1;",
        "+const x = 2;",
        "*** End Patch",
      ].join("\n"),
    };

    render(
      <div>
        {renderCollapsedPreview(
          input as never,
          { ok: true } as never,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(screen.queryByText("Computing diff...")).toBeNull();
    expect(screen.getByText(/\*\*\* Begin Patch/)).toBeDefined();
  });

  it("keeps pending classic Edit rows on Computing diff...", () => {
    const input = {
      file_path: "src/example.ts",
      old_string: "const x = 1;",
      new_string: "const x = 2;",
    };

    render(
      <div>
        {renderCollapsedPreview(
          input as never,
          undefined,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(screen.getByText("Computing diff...")).toBeDefined();
  });

  it("keeps structured diff rendering unchanged when structured patch exists", () => {
    const input = {
      _structuredPatch: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: ["-const x = 1;", "+const x = 2;"],
        },
      ],
    };

    render(
      <div>
        {renderCollapsedPreview(
          input as never,
          undefined,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(screen.queryByText("Computing diff...")).toBeNull();
    expect(screen.getByText("-const x = 1;")).toBeDefined();
    expect(screen.getByText("+const x = 2;")).toBeDefined();
  });

  it("renders server-provided highlighted diff HTML when available", () => {
    const input = {
      _structuredPatch: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: ["-const x = 1;", "+const x = 2;"],
        },
      ],
      _diffHtml:
        '<pre class="shiki"><code class="language-ts"><span class="line line-deleted"><span class="diff-prefix">-</span><span style="color:var(--shiki-token-keyword)">const</span> x = 1;</span>\n<span class="line line-inserted"><span class="diff-prefix">+</span><span style="color:var(--shiki-token-keyword)">const</span> x = 2;</span></code></pre>',
    };

    const { container } = render(
      <div>
        {renderCollapsedPreview(
          input as never,
          { ok: true } as never,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(screen.queryByText("Computing diff...")).toBeNull();
    expect(
      container.querySelector(".highlighted-diff .line-inserted"),
    ).toBeTruthy();
    expect(screen.getAllByText(/const/)).toHaveLength(2);
  });

  it("renders stable fallback text when completed row has no patch data", () => {
    const input = {};

    render(
      <div>
        {renderCollapsedPreview(
          input as never,
          { ok: true } as never,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(screen.queryByText("Computing diff...")).toBeNull();
    expect(screen.getByText("Patch preview unavailable")).toBeDefined();
  });

  it("derives filename from raw patch when file_path is missing", () => {
    const summary = editRenderer.getUseSummary?.({
      _rawPatch: [
        "*** Begin Patch",
        "*** Update File: packages/client/src/components/Foo.tsx",
        "@@",
        "-const x = 1;",
        "+const x = 2;",
        "*** End Patch",
      ].join("\n"),
    } as never);

    expect(summary).toBe("Foo.tsx");
  });

  it("shows raw patch filename in interactive summary when file_path is missing", () => {
    if (!editRenderer.renderInteractiveSummary) {
      throw new Error("Edit renderer must provide interactive summary");
    }

    render(
      <div>
        {editRenderer.renderInteractiveSummary(
          {
            _rawPatch: [
              "*** Begin Patch",
              "*** Update File: packages/client/src/components/Foo.tsx",
              "@@",
              "-const x = 1;",
              "+const x = 2;",
              "*** End Patch",
            ].join("\n"),
            _structuredPatch: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: ["-const x = 1;", "+const x = 2;"],
              },
            ],
          } as never,
          undefined,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(screen.getByRole("button", { name: /Foo\.tsx/i })).toBeDefined();
  });

  it("renders completed result diffs from input augment data", () => {
    render(
      <div>
        {editRenderer.renderToolResult(
          { content: "Edited successfully." } as never,
          false,
          renderContext,
          {
            file_path: "src/example.ts",
            _structuredPatch: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: ["-const x = 1;", "+const x = 2;"],
              },
            ],
          } as never,
        )}
      </div>,
    );

    expect(screen.queryByText("(empty)")).toBeNull();
    expect(screen.getByText("-const x = 1;")).toBeDefined();
    expect(screen.getByText("+const x = 2;")).toBeDefined();
  });

  it("renders completed result raw patch from input when structured data is unavailable", () => {
    render(
      <div>
        {editRenderer.renderToolResult(
          { content: "Edited successfully." } as never,
          false,
          renderContext,
          {
            file_path: "src/example.ts",
            _rawPatch: [
              "--- src/example.ts",
              "+++ src/example.ts",
              "@@ -1,1 +1,1 @@",
              "-const x = 1;",
              "+const x = 2;",
            ].join("\n"),
          } as never,
        )}
      </div>,
    );

    expect(screen.queryByText("(empty)")).toBeNull();
    expect(screen.getByText(/--- src\/example\.ts/)).toBeDefined();
  });
});
