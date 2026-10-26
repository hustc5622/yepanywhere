import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionMetadataProvider } from "../../../../contexts/SessionMetadataContext";
import { I18nProvider } from "../../../../i18n";
import { bashRenderer } from "../BashRenderer";
import { globRenderer } from "../GlobRenderer";
import { grepRenderer } from "../GrepRenderer";

const { getFilePreview } = vi.hoisted(() => ({
  getFilePreview: vi.fn(() => new Promise(() => {})),
}));
vi.mock("../../../../api/client", () => ({ api: { getFilePreview } }));
vi.mock("../../../../contexts/SchemaValidationContext", () => ({
  useSchemaValidationContext: () => ({
    enabled: false,
    reportValidationError: vi.fn(),
    isToolIgnored: vi.fn(() => false),
  }),
}));

const context = { isStreaming: false, theme: "dark" as const };

function renderInSession(ui: ReactNode) {
  return render(
    <I18nProvider>
      <SessionMetadataProvider
        projectId="proj-1"
        projectPath="/repo"
        sessionId="s-1"
      >
        {ui}
      </SessionMetadataProvider>
    </I18nProvider>,
  );
}

describe("file entries in search and shell tool output", () => {
  afterEach(() => {
    cleanup();
    getFilePreview.mockClear();
  });

  it("opens Glob results relative to the search root", async () => {
    renderInSession(
      globRenderer.renderToolResult(
        {
          filenames: ["src/a.ts", "/abs/b.ts"],
          numFiles: 2,
          durationMs: 1,
          truncated: false,
        },
        false,
        context,
        { pattern: "**/*.ts", path: "/repo/packages/client" },
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: /a\.ts/ }));
    await waitFor(() =>
      expect(getFilePreview).toHaveBeenCalledWith(
        { path: "/repo/packages/client/src/a.ts" },
        true,
      ),
    );
  });

  it("links grep match and context lines to their line", async () => {
    renderInSession(
      grepRenderer.renderToolResult(
        {
          mode: "content",
          filenames: [],
          numFiles: 1,
          content: "src/a.ts:12:const x = 1;\nsrc/a.ts-13-// next\n--",
        },
        false,
        context,
        { pattern: "x" },
      ),
    );
    const links = screen.getAllByRole("button", { name: /src\/a\.ts/ });
    expect(links.map((link) => link.textContent)).toEqual([
      "src/a.ts:12",
      "src/a.ts-13",
    ]);
    expect(screen.getByText(":const x = 1;", { exact: false })).toBeTruthy();
    fireEvent.click(links[0] as HTMLElement);
    await waitFor(() =>
      expect(getFilePreview).toHaveBeenCalledWith(
        { path: "/repo/src/a.ts" },
        true,
      ),
    );
  });

  it("offers the file a shell command reads, using the command's workdir", async () => {
    renderInSession(
      bashRenderer.renderToolUse(
        // Codex shell calls carry a workdir next to the BashInput fields.
        {
          command: "nl -ba src/app.ts | sed -n '20,40p'",
          workdir: "/repo/packages/server",
        } as Parameters<typeof bashRenderer.renderToolUse>[0],
        context,
      ),
    );
    const link = screen.getByRole("button", { name: /app\.ts/ });
    expect(link.textContent).toBe("app.ts:20-40");
    fireEvent.click(link);
    await waitFor(() =>
      expect(getFilePreview).toHaveBeenCalledWith(
        { path: "/repo/packages/server/src/app.ts" },
        true,
      ),
    );
  });

  it("does not add a file link to ordinary commands", () => {
    renderInSession(
      bashRenderer.renderToolUse({ command: "pnpm test" }, context),
    );
    expect(screen.queryByRole("button", { name: /Reads/ })).toBeNull();
    expect(document.querySelector(".bash-file-read")).toBeNull();
  });
});
