import { describe, expect, it } from "vitest";
import {
  PI_THINKING_PREVIEW_MAX_LENGTH,
  parsePiSessionJsonl,
} from "../../src/pi-schema/session.js";

function jsonl(records: unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

describe("Pi session JSONL parser", () => {
  it("defers inline media and keeps a reasoning preview without changing the default", () => {
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
                thinking: "private reasoning",
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
  it("keeps short reasoning inline and previews long reasoning when deferred", () => {
    const longThinking = "x".repeat(PI_THINKING_PREVIEW_MAX_LENGTH + 40);
    const content = jsonl([
      {
        type: "session",
        id: "session-2",
        timestamp: "2026-08-18T00:00:00.000Z",
        cwd: "/tmp/project",
      },
      {
        type: "message",
        id: "assistant-short",
        parentId: null,
        timestamp: "2026-08-18T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "short reasoning" }],
        },
      },
      {
        type: "message",
        id: "assistant-long",
        parentId: "assistant-short",
        timestamp: "2026-08-18T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: longThinking }],
        },
      },
    ]);

    const deferred = parsePiSessionJsonl(content, { deferThinking: true });
    const byId = new Map(
      (deferred?.entries ?? []).map((entry) => [entry.id, entry]),
    );
    const short = byId.get("assistant-short") as
      | { message: { content: { thinking: string; deferred?: boolean }[] } }
      | undefined;
    const long = byId.get("assistant-long") as
      | {
          message: {
            content: {
              thinking: string;
              deferred?: boolean;
              thinkingLength?: number;
            }[];
          };
        }
      | undefined;
    expect(short?.message.content[0]).toEqual({
      type: "thinking",
      thinking: "short reasoning",
    });
    expect(long?.message.content[0]).toMatchObject({
      type: "thinking",
      thinking: longThinking.slice(0, PI_THINKING_PREVIEW_MAX_LENGTH),
      deferred: true,
      thinkingLength: longThinking.length,
    });
  });
});
