import { describe, expect, it } from "vitest";
import { parsePiSessionJsonl } from "../../src/pi-schema/session.js";

function jsonl(records: unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

describe("Pi session JSONL parser", () => {
  it("can defer inline media and thinking payloads without changing the default", () => {
    const content = jsonl([
      {
        type: "session",
        id: "session-1",
        timestamp: "2026-08-18T00:00:00.000Z",
        cwd: "/tmp/project",
      },
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: "2026-08-18T00:00:01.000Z",
        message: {
          role: "user",
          content: [
            { type: "text", text: "Review this" },
            { type: "image", mimeType: "image/png", data: "a".repeat(256) },
          ],
        },
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp: "2026-08-18T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private reasoning" },
            { type: "image", mimeType: "image/jpeg", data: "b".repeat(256) },
          ],
        },
      },
    ]);

    const normal = parsePiSessionJsonl(content);
    expect(normal?.activeEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "user-1",
          message: expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({ data: "a".repeat(256) }),
            ]),
          }),
        }),
      ]),
    );

    const deferred = parsePiSessionJsonl(content, {
      deferMedia: true,
      deferThinking: true,
    });
    expect(deferred?.activeEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "user-1",
          message: expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({
                type: "image",
                data: "",
                deferred: true,
              }),
            ]),
          }),
        }),
        expect.objectContaining({
          id: "assistant-1",
          message: expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({
                type: "thinking",
                thinking: "",
                deferred: true,
              }),
              expect.objectContaining({
                type: "image",
                data: "",
                deferred: true,
              }),
            ]),
          }),
        }),
      ]),
    );
  });
});
