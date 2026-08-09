import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { NATIVE_RENDER_ITEM_TYPES } from "@yep-anywhere/shared";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { I18nProvider } from "../../i18n";
import type { NativeRenderItem } from "../../types/renderItems";
import {
  NativeRenderItemRenderer,
  nativeRenderers,
} from "../renderers/NativeRenderItemRenderer";

function renderItem(
  item: NativeRenderItem,
  props: Partial<ComponentProps<typeof NativeRenderItemRenderer>> = {},
) {
  return render(
    <I18nProvider>
      <NativeRenderItemRenderer item={item} {...props} />
    </I18nProvider>,
  );
}

describe("NativeRenderItemRenderer", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("registers every native RenderItem kind", () => {
    expect(Object.keys(nativeRenderers).sort()).toEqual(
      [...NATIVE_RENDER_ITEM_TYPES].sort(),
    );
  });

  it("shows reasoning summary while keeping raw content hidden by default", () => {
    renderItem({
      type: "reasoning",
      id: "reasoning-1",
      sourceMessages: [],
      summary: ["Checked the schema"],
      content: ["private chain of thought"],
      visibility: "raw_allowed",
      status: "complete",
    });

    expect(screen.getByText("Checked the schema")).toBeTruthy();
    expect(screen.queryByText("private chain of thought")).toBeNull();
    expect(screen.getByText("Raw reasoning is hidden by policy.")).toBeTruthy();
  });

  it("renders command lifecycle fields and expandable output", () => {
    renderItem({
      type: "command",
      id: "command-1",
      sourceMessages: [],
      command: "pnpm test",
      cwd: "/repo",
      output: "42 tests passed",
      exitCode: 0,
      durationMs: 1200,
      status: "complete",
    });

    expect(screen.getByText("pnpm test")).toBeTruthy();
    expect(screen.getByText("/repo")).toBeTruthy();
    expect(screen.getByText("42 tests passed")).toBeTruthy();
  });

  it("keeps unknown provider activity visible without exposing raw payload", () => {
    renderItem({
      type: "unknown",
      id: "unknown-1",
      providerItemId: "provider-1",
      sourceMessages: [],
      originalType: "futureTool",
      safeSummary: "Fields: status",
      status: "pending",
    });

    expect(screen.getByText("Unsupported activity")).toBeTruthy();
    expect(screen.getByText("futureTool")).toBeTruthy();
    expect(screen.getByText("Fields: status")).toBeTruthy();
  });

  it("localizes structured Codex queued retry state", () => {
    renderItem({
      type: "warning",
      id: "retry-1",
      sourceMessages: [],
      message: "must not be rendered",
      retrying: true,
      retryStatus: {
        state: "queued",
        category: "overloaded",
        retryable: true,
        attempt: 1,
        nextAttempt: 2,
        maxAttempts: 4,
        retryInMs: 50,
      },
      status: "running",
    });

    expect(screen.getByText("Request queued")).toBeTruthy();
    expect(
      screen.getByText("Codex is busy. Attempt 2/4 will start in 50ms."),
    ).toBeTruthy();
    expect(screen.queryByText("must not be rendered")).toBeNull();
  });

  it("does not print inline image payloads from dynamic tools", () => {
    renderItem({
      type: "dynamic_tool",
      id: "dynamic-1",
      sourceMessages: [],
      tool: "create_image",
      contentItems: [
        { type: "image", url: "data:image/png;base64,MUST_NOT_RENDER" },
      ],
      status: "complete",
    });

    expect(screen.getByText("Image output")).toBeTruthy();
    expect(screen.queryByText(/MUST_NOT_RENDER/)).toBeNull();
  });

  it("renders a typed artifact download without exposing its managed URL", async () => {
    const blob = new Blob(["%PDF-1.7"], { type: "application/pdf" });
    const download = vi
      .spyOn(api, "downloadGeneratedArtifact")
      .mockResolvedValue({ blob, fileName: null });
    const BrowserUrl = URL;
    class TestUrl extends BrowserUrl {}
    Object.defineProperties(TestUrl, {
      createObjectURL: { value: vi.fn(() => "blob:artifact") },
      revokeObjectURL: { value: vi.fn() },
    });
    vi.stubGlobal("URL", TestUrl);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      () => undefined,
    );
    const artifactId = `ga_${"b".repeat(32)}`;
    const sha256 = `sha256:${"c".repeat(64)}`;
    const downloadUrl = `/api/projects/project/sessions/session/generated-artifact/${artifactId}/${sha256.slice("sha256:".length)}/report.pdf`;

    renderItem({
      type: "file_change",
      id: "file-1",
      sourceMessages: [],
      changes: [{ path: "report.pdf", kind: "add" }],
      artifacts: [
        {
          schemaVersion: 1,
          id: artifactId,
          managedRef: "upload:123e4567-e89b-12d3-a456-426614174000",
          fileName: "report.pdf",
          kind: "document",
          mimeType: "application/pdf",
          sizeBytes: 8,
          sha256,
          source: {
            provider: "codex",
            type: "file_change",
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "file-1",
          },
          retention: {
            policy: "temporary",
            expiresAt: "2026-01-02T00:00:00.000Z",
          },
          downloadUrl,
        },
      ],
      status: "complete",
    });

    expect(screen.getAllByText("report.pdf")).toHaveLength(2);
    expect(screen.queryByText(downloadUrl)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(download).toHaveBeenCalledWith(downloadUrl));
  });

  it("submits interaction operation id, version, decision, and secret answer", async () => {
    const onResolveInteraction = vi.fn();
    renderItem(
      {
        type: "interaction",
        id: "interaction-1",
        sourceMessages: [],
        status: "pending",
        operation: {
          operationId: "op-1",
          provider: "codex",
          requestId: "request-1",
          requestMethod: "item/tool/requestUserInput",
          sessionId: "thread-1",
          kind: "question",
          state: "open",
          publicPayload: {
            prompt: "Enter token",
            questions: [
              { id: "token", prompt: "Token", type: "secret", required: true },
            ],
          },
          allowedActors: { mode: "requester_or_admin" },
          allowedDecisions: [
            { id: "submit", tone: "primary", requiresConfirmation: true },
          ],
          createdAt: 0,
          version: 7,
        },
      },
      { onResolveInteraction },
    );

    const input = screen.getByPlaceholderText(
      "Enter securely",
    ) as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.change(input, { target: { value: "secret-value" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onResolveInteraction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm Submit" }));

    await waitFor(() =>
      expect(onResolveInteraction).toHaveBeenCalledWith({
        operationId: "op-1",
        version: 7,
        decisionId: "submit",
        value: { answers: { token: "secret-value" } },
      }),
    );
    await waitFor(() => expect(input.value).toBe(""));
  });
});
