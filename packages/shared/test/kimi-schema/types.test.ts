import { describe, expect, it } from "vitest";
import {
  type KimiWireRecord,
  getKimiPromptImages,
  getKimiPromptText,
  inferKimiSubagentStatus,
  isKimiTurnEndedRecord,
  parseKimiBlobRef,
  parseKimiSessionState,
  parseKimiWireJsonl,
} from "../../src/kimi-schema/types.js";

describe("parseKimiWireJsonl", () => {
  it("preserves terminal provider errors and raw filter reasons", () => {
    const records = parseKimiWireJsonl(
      [
        JSON.stringify({
          type: "context.append_loop_event",
          event: {
            type: "step.end",
            finishReason: "filtered",
            providerFinishReason: "filtered",
            rawFinishReason: "content_filter",
          },
          time: 1,
        }),
        JSON.stringify({
          type: "turn.ended",
          turnId: 0,
          reason: "failed",
          error: {
            code: "provider.filtered",
            message: "Provider safety policy blocked the response.",
            name: "ProviderFilteredError",
            retryable: false,
          },
          time: 2,
        }),
      ].join("\n"),
    );

    expect(records[0]).toMatchObject({
      event: {
        finishReason: "filtered",
        providerFinishReason: "filtered",
        rawFinishReason: "content_filter",
      },
    });
    expect(isKimiTurnEndedRecord(records[1])).toBe(true);
    expect(records[1]).toMatchObject({
      type: "turn.ended",
      turnId: 0,
      reason: "failed",
      error: {
        code: "provider.filtered",
        message: "Provider safety policy blocked the response.",
        retryable: false,
      },
    });
  });
});

describe("parseKimiSessionState", () => {
  it("keeps the legacy workDir and ISO timestamp layout", () => {
    expect(
      parseKimiSessionState(
        JSON.stringify({
          workDir: "/tmp/legacy-project",
          createdAt: "2026-08-11T01:02:03.000Z",
          updatedAt: "2026-08-11T01:03:04.000Z",
          title: "Legacy session",
        }),
      ),
    ).toMatchObject({
      workDir: "/tmp/legacy-project",
      createdAt: "2026-08-11T01:02:03.000Z",
      updatedAt: "2026-08-11T01:03:04.000Z",
      title: "Legacy session",
    });
  });

  it("normalizes Kimi Code 0.34 state v2 cwd and epoch timestamps", () => {
    const createdAt = Date.UTC(2026, 7, 11, 1, 2, 3);
    const updatedAt = Date.UTC(2026, 7, 11, 1, 3, 4);

    expect(
      parseKimiSessionState(
        JSON.stringify({
          version: 2,
          cwd: "/tmp/v2-project",
          createdAt,
          updatedAt,
          title: "Version two session",
        }),
      ),
    ).toMatchObject({
      version: 2,
      cwd: "/tmp/v2-project",
      workDir: "/tmp/v2-project",
      createdAt: new Date(createdAt).toISOString(),
      updatedAt: new Date(updatedAt).toISOString(),
      title: "Version two session",
    });
  });
});

describe("parseKimiBlobRef", () => {
  const hash = "a".repeat(64);

  it("parses a content-addressed blob reference", () => {
    expect(parseKimiBlobRef(`blobref:image/png;${hash}`)).toEqual({
      mimeType: "image/png",
      hash,
    });
  });

  it("returns null for non-blobref urls", () => {
    expect(parseKimiBlobRef("data:image/png;base64,AAAB")).toBeNull();
    expect(parseKimiBlobRef("file:///tmp/a.png")).toBeNull();
  });

  it("rejects hashes that are not a bare sha256", () => {
    // Guards against path traversal out of the blobs directory.
    expect(parseKimiBlobRef("blobref:image/png;../../etc/passwd")).toBeNull();
    expect(parseKimiBlobRef("blobref:image/png;short")).toBeNull();
    expect(parseKimiBlobRef(`blobref:;${hash}`)).toBeNull();
  });
});

describe("getKimiPromptText", () => {
  it("joins text parts and ignores images", () => {
    expect(
      getKimiPromptText([
        { type: "text", text: "first" },
        { type: "image_url", imageUrl: { url: "data:image/png;base64,A" } },
        { type: "text", text: "second" },
      ]),
    ).toBe("first\nsecond");
  });

  it("drops the compression notice Kimi injects next to an image", () => {
    expect(
      getKimiPromptText([
        { type: "text", text: "describe this" },
        {
          type: "text",
          text: "<system>Image compressed to fit model limits: original 1290x2796 image/png (33 KB) -> sent 923x2000 image/png (30 KB).</system>",
        },
      ]),
    ).toBe("describe this");
  });

  it("keeps user text that merely mentions a system tag", () => {
    expect(
      getKimiPromptText([
        { type: "text", text: "the <system> tag is not closed here" },
      ]),
    ).toBe("the <system> tag is not closed here");
  });

  it("preserves literal <system>...</system> user text that is not the compression notice", () => {
    // The narrow regex must only hide Kimi's own compression-injection text.
    // A user message that legitimately wraps content in <system> tags is
    // not dropped, otherwise transcripts, session titles and normalization
    // would silently lose real user input.
    expect(
      getKimiPromptText([
        { type: "text", text: "<system>show this literal user text</system>" },
      ]),
    ).toBe("<system>show this literal user text</system>");
    expect(
      getKimiPromptText([
        {
          type: "text",
          text: "<system>custom system instructions go here</system>",
        },
      ]),
    ).toBe("<system>custom system instructions go here</system>");
  });

  it("hides only the exact Kimi compression notice", () => {
    const notice =
      "<system>Image compressed to fit model limits: original 1290x2796 image/png (33 KB) -> sent 923x2000 image/png (30 KB).</system>";
    expect(getKimiPromptText([{ type: "text", text: notice }])).toBe("");
    // Even when surrounded by other text parts, only the notice is dropped.
    expect(
      getKimiPromptText([
        { type: "text", text: "before" },
        { type: "text", text: notice },
        { type: "text", text: "after" },
      ]),
    ).toBe("before\nafter");
  });
});

describe("getKimiPromptImages", () => {
  const hash = "f".repeat(64);

  it("resolves blobrefs and data urls in order", () => {
    expect(
      getKimiPromptImages([
        { type: "text", text: "x" },
        { type: "image_url", imageUrl: { url: `blobref:image/webp;${hash}` } },
        { type: "image_url", imageUrl: { url: "data:image/jpeg;base64,AAAB" } },
      ]),
    ).toEqual([
      {
        url: `blobref:image/webp;${hash}`,
        mimeType: "image/webp",
        blobHash: hash,
      },
      { url: "data:image/jpeg;base64,AAAB", mimeType: "image/jpeg" },
    ]);
  });

  it("returns nothing for a text-only turn", () => {
    expect(getKimiPromptImages([{ type: "text", text: "hi" }])).toEqual([]);
  });
});

describe("inferKimiSubagentStatus", () => {
  const completedRecords: KimiWireRecord[] = [
    {
      type: "context.append_loop_event",
      event: { type: "step.end", finishReason: "end_turn" },
      time: 2,
    },
  ];

  it("lets a background child converge to completed from its own wire", () => {
    expect(inferKimiSubagentStatus(completedRecords, "backgrounded")).toBe(
      "completed",
    );
  });

  it("keeps a non-terminal parent status until the child finishes", () => {
    expect(inferKimiSubagentStatus([], "backgrounded")).toBe("backgrounded");
  });

  it("keeps an authoritative terminal failure over a clean child end", () => {
    expect(inferKimiSubagentStatus(completedRecords, "failed")).toBe("failed");
  });
});
