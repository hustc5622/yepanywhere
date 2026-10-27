import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSideImages } from "../../resources/pi-side-conversation.mjs";
import { resolveSideImages } from "../../src/side-conversations/attachments.js";
import {
  type SideCodexClient,
  createCodexSideConversation,
} from "../../src/side-conversations/codex.js";
import {
  SideConversationSession,
  type SideTransport,
} from "../../src/side-conversations/session.js";

describe("side conversation images", () => {
  let root: string;
  let uploads: string;
  let image: string;

  beforeEach(async () => {
    root = join(tmpdir(), `side-images-${randomUUID()}`);
    uploads = join(root, "uploads");
    await mkdir(join(uploads, "project", "session"), { recursive: true });
    image = join(uploads, "project", "session", "shot.png");
    await writeFile(image, "png-bytes");
    await writeFile(join(root, "outside.png"), "secret");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("accepts only image uploads inside the uploads directory", async () => {
    await expect(
      resolveSideImages(
        [{ path: image, name: "shot.png", mimeType: "IMAGE/PNG" }],
        uploads,
      ),
    ).resolves.toEqual([
      {
        path: expect.stringContaining("shot.png"),
        name: "shot.png",
        mimeType: "image/png",
      },
    ]);
    await expect(
      resolveSideImages(
        [
          {
            path: join(root, "outside.png"),
            name: "x.png",
            mimeType: "image/png",
          },
        ],
        uploads,
      ),
    ).rejects.toThrow(/not a Yep upload/);
    await expect(
      resolveSideImages(
        [
          {
            path: join(uploads, "project", "session", "../../../outside.png"),
            name: "x",
            mimeType: "image/png",
          },
        ],
        uploads,
      ),
    ).rejects.toThrow(/not a Yep upload/);
    await expect(
      resolveSideImages(
        [{ path: image, name: "notes.pdf", mimeType: "application/pdf" }],
        uploads,
      ),
    ).rejects.toThrow(/images only/);
  });

  it("validates images before admitting the question and records their names", async () => {
    const transport: SideTransport = {
      send: vi.fn(async () => {}),
      interrupt: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const resolveImages = vi.fn(async () => [
      { path: "/real/shot.png", name: "shot.png", mimeType: "image/png" },
    ]);
    const session = new SideConversationSession({
      ready: () => true,
      parentId: () => "parent",
      supportsImages: true,
      resolveImages,
      create: async () => transport,
    });
    const created = await session.execute({
      action: "create",
      requestId: "c",
      context: "snapshot",
    });
    expect(created.capabilities).toEqual({ images: true });
    const id = created.conversation?.id ?? "";
    const attachments = [
      { path: "/uploads/shot.png", name: "shot.png", mimeType: "image/png" },
    ];
    const sent = await session.execute({
      action: "send",
      id,
      requestId: "q",
      text: "what is this?",
      attachments,
    });
    expect(resolveImages).toHaveBeenCalledWith(attachments);
    expect(transport.send).toHaveBeenCalledWith("what is this?", "q", [
      { path: "/real/shot.png", name: "shot.png", mimeType: "image/png" },
    ]);
    expect(sent.conversation?.messages[0]).toMatchObject({
      role: "user",
      attachments: [{ name: "shot.png", mimeType: "image/png" }],
    });

    await session.dispose();
  });

  it("rejects images when the provider cannot read them", async () => {
    const session = new SideConversationSession({
      ready: () => true,
      parentId: () => "parent",
      create: async () => ({
        send: vi.fn(async () => {}),
        interrupt: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      }),
    });
    const created = await session.execute({
      action: "create",
      requestId: "c",
      context: "empty",
    });
    expect(created.capabilities).toEqual({ images: false });
    const result = await session.execute({
      action: "send",
      id: created.conversation?.id ?? "",
      requestId: "q",
      text: "look",
      attachments: [{ path: image, name: "shot.png", mimeType: "image/png" }],
    });
    expect(result.error).toMatch(/cannot read images/);
    expect(result.conversation?.messages).toEqual([]);
    expect(result.conversation?.status).toBe("idle");
    await session.dispose();
  });

  it("keeps the conversation idle when an image fails validation", async () => {
    const send = vi.fn(async () => {});
    const session = new SideConversationSession({
      ready: () => true,
      parentId: () => "parent",
      supportsImages: true,
      resolveImages: async () => {
        throw new Error("Attachment no longer exists: shot.png");
      },
      create: async () => ({
        send,
        interrupt: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      }),
    });
    const created = await session.execute({
      action: "create",
      requestId: "c",
      context: "empty",
    });
    const id = created.conversation?.id ?? "";
    const failed = await session.execute({
      action: "send",
      id,
      requestId: "q",
      text: "look",
      attachments: [
        { path: "/x.png", name: "shot.png", mimeType: "image/png" },
      ],
    });
    expect(failed.error).toMatch(/no longer exists/);
    expect(failed.conversation).toMatchObject({ status: "idle", messages: [] });
    expect(send).not.toHaveBeenCalled();
    const retried = await session.execute({
      action: "send",
      id,
      requestId: "q",
      text: "look again",
    });
    expect(retried.error).toBeUndefined();
    expect(send).toHaveBeenCalledWith("look again", "q", []);
    await session.dispose();
  });

  it("does not admit a question whose conversation closed during image checks", async () => {
    let release!: () => void;
    const send = vi.fn(async () => {});
    const session = new SideConversationSession({
      ready: () => true,
      parentId: () => "parent",
      supportsImages: true,
      resolveImages: () =>
        new Promise((resolve) => {
          release = () =>
            resolve([
              { path: "/u/a.png", name: "a.png", mimeType: "image/png" },
            ]);
        }),
      create: async () => ({
        send,
        interrupt: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      }),
    });
    const created = await session.execute({
      action: "create",
      requestId: "c",
      context: "empty",
    });
    const id = created.conversation?.id ?? "";
    const pending = session.execute({
      action: "send",
      id,
      requestId: "q",
      text: "look",
      attachments: [{ path: "/u/a.png", name: "a.png", mimeType: "image/png" }],
    });
    await session.execute({ action: "close", id });
    release();
    const result = await pending;
    expect(result.error).toMatch(/ended/);
    expect(result.conversation).toMatchObject({
      status: "closed",
      messages: [],
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("sends Codex side images inline so a bridge host need not share the disk", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "config/read") return { config: {} };
      if (method === "thread/fork")
        return {
          thread: { id: "side", ephemeral: true },
          sandbox: { type: "readOnly" },
        };
      if (method === "turn/start")
        return { turn: { id: "t", status: "inProgress" } };
      return {};
    });
    const client = {
      requestIsolated: request,
      isolateThread: vi.fn(() => vi.fn()),
    } as unknown as SideCodexClient;
    const side = await createCodexSideConversation({
      client,
      parentId: "main",
      cwd: "/tmp",
      context: "snapshot",
      emit: vi.fn(),
    });
    await side.send("look", "r", [
      { path: image, name: "shot.png", mimeType: "image/png" },
    ]);
    const turn = (
      request.mock.calls as unknown as Array<[string, Record<string, unknown>]>
    ).find(([method]) => method === "turn/start")?.[1];
    expect(turn?.input).toEqual([
      { type: "text", text: "look", text_elements: [] },
      {
        type: "image",
        url: `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`,
      },
    ]);
    await side.close();
  });

  it("reads Pi side images as ImageContent and rejects bad shapes", async () => {
    await expect(
      readSideImages([{ path: image, mimeType: "image/png" }]),
    ).resolves.toEqual([
      {
        type: "image",
        data: Buffer.from("png-bytes").toString("base64"),
        mimeType: "image/png",
      },
    ]);
    await expect(readSideImages(undefined)).resolves.toEqual([]);
    await expect(
      readSideImages([{ path: "relative.png", mimeType: "image/png" }]),
    ).rejects.toThrow(/Invalid/);
    await expect(
      readSideImages([{ path: image, mimeType: "text/plain" }]),
    ).rejects.toThrow(/Invalid/);
  });
});
