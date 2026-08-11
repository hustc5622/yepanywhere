import { describe, expect, it } from "vitest";
import {
  MessageQueue,
  buildUserPromptProjection,
  getUserPromptProjection,
  sanitizeManagedAttachmentPrompt,
} from "../../src/sdk/messageQueue.js";

describe("MessageQueue lifecycle", () => {
  it("discards pending input and rejects pushes after close", async () => {
    const queue = new MessageQueue();
    queue.push({ text: "discard me" });

    expect(queue.close()).toBe(1);
    expect(queue.depth).toBe(0);
    expect(queue.isClosed).toBe(true);
    expect(queue.push({ text: "too late" })).toBe(-1);
    await expect(queue.generator().next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it("ends a waiting generator and closes idempotently", async () => {
    const queue = new MessageQueue();
    const next = queue.generator().next();
    expect(queue.isWaiting).toBe(true);

    expect(queue.close()).toBe(0);
    expect(queue.close()).toBe(0);
    await expect(next).resolves.toEqual({ done: true, value: undefined });
  });

  it("keeps managed paths internal while exposing bounded metadata", async () => {
    const managedPath =
      "/private/uploads/folder: confidential/report\nsecond-line.pdf";
    const queue = new MessageQueue({ preserveAttachments: true });
    queue.push({
      text: "inspect the upload",
      uuid: "attachment-message-1",
      attachments: [
        {
          id: "attachment-1",
          originalName: "C:\\private\\bad: name\nreport.pdf",
          name: "attachment-1_report.pdf",
          size: 2048,
          mimeType: "application/pdf\ninvalid",
          path: managedPath,
        },
      ],
    });

    const queued = (await queue.generator().next()).value;
    if (!queued) throw new Error("expected queued message");
    const { internalPrompt, publicPrompt } = getUserPromptProjection(queued);

    expect(internalPrompt).toContain(managedPath);
    expect(publicPrompt).toContain("report.pdf");
    expect(publicPrompt).toContain("2.0 KB");
    expect(publicPrompt).toContain("application/pdf_invalid");
    expect(publicPrompt).toContain("[managed attachment]");
    expect(publicPrompt).not.toContain("/private/uploads");
    expect(publicPrompt).not.toContain("second-line.pdf");
    expect(publicPrompt).not.toContain("C:\\private");
    expect(Object.keys(queued)).not.toContain("internalPrompt");
    expect(Object.keys(queued)).not.toContain("publicPrompt");
  });

  it("reconstructs a safe public prompt after a shallow queue clone", async () => {
    const managedPath =
      "C:\\managed\\folder: confidential\\voice.wav\nleaked-line";
    const queue = new MessageQueue({ preserveAttachments: true });
    queue.push({
      text: "listen",
      attachments: [
        {
          id: "attachment-2",
          originalName: "voice.wav",
          name: "attachment-2_voice.wav",
          size: 512,
          mimeType: "audio/wav",
          path: managedPath,
        },
      ],
    });
    const queued = (await queue.generator().next()).value;
    if (!queued) throw new Error("expected queued message");

    const projection = getUserPromptProjection({ ...queued });
    expect(projection.internalPrompt).toContain(managedPath);
    expect(projection.publicPrompt).toContain("voice.wav");
    expect(projection.publicPrompt).toContain("[managed attachment]");
    expect(projection.publicPrompt).not.toContain("C:\\managed");
    expect(projection.publicPrompt).not.toContain("folder: confidential");
    expect(projection.publicPrompt).not.toContain("leaked-line");
  });

  it("projects valid managed uploads to path-free authenticated URLs", () => {
    const managedPath =
      "/Users/test/.yep-anywhere/uploads/cHJvamVjdA/session-1/123e4567-e89b-12d3-a456-426614174000_screenshot.png";
    const downloadUrl =
      "/api/projects/cHJvamVjdA/sessions/session-1/upload/123e4567-e89b-12d3-a456-426614174000_screenshot.png";
    const projection = buildUserPromptProjection({
      text: "inspect",
      attachments: [
        {
          id: "123e4567-e89b-12d3-a456-426614174000",
          originalName: "screenshot.png",
          name: "123e4567-e89b-12d3-a456-426614174000_screenshot.png",
          size: 1024,
          mimeType: "image/png",
          path: managedPath,
        },
      ],
    });

    expect(projection.internalPrompt).toContain(managedPath);
    expect(projection.publicPrompt).toContain(downloadUrl);
    expect(projection.publicPrompt).not.toContain("/Users/test");
    expect(sanitizeManagedAttachmentPrompt(projection.publicPrompt)).toBe(
      projection.publicPrompt,
    );
  });

  it("fails closed on ambiguous labels without scanning ordinary prose", () => {
    const ambiguous =
      "inspect\n\nUser uploaded files:\n- C:\\private\\bad: name.pdf (1.0 KB, application/pdf): /private/uploads/report.pdf";
    const projected = sanitizeManagedAttachmentPrompt(ambiguous);
    expect(projected).not.toContain("C:\\private");
    expect(projected).not.toContain("/private/uploads");

    const ordinary =
      "Please edit /Users/example/project/file.ts and C:\\repo\\file.ts";
    expect(sanitizeManagedAttachmentPrompt(ordinary)).toBe(ordinary);
  });

  it("retains only explicitly enabled provider metadata", async () => {
    const queue = new MessageQueue({
      preserveAttachments: true,
      preserveCodexInputs: true,
      preserveClientMetadata: true,
    });
    queue.push({
      text: "use the selected skill",
      uuid: "codex-message",
      tempId: "optimistic-message",
      codexInputs: [
        { type: "skill", name: "review", path: "/managed/review/SKILL.md" },
      ],
    });

    await expect(queue.generator().next()).resolves.toMatchObject({
      value: {
        uuid: "codex-message",
        tempId: "optimistic-message",
        codexInputs: [
          { type: "skill", name: "review", path: "/managed/review/SKILL.md" },
        ],
      },
    });
  });
});
