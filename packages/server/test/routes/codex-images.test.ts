import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCodexImageRoutes } from "../../src/routes/codex-images.js";

const response = (payload: object) => ({ type: "response_item", payload });
const call = (id: string, name = "exec") =>
  response({
    type: "custom_tool_call",
    call_id: id,
    name,
    input:
      'const r = await tools.view_image({path:"/tmp/phone.png"}); image(r.image_url);',
  });
const view = (id: string) => ({
  type: "event_msg",
  payload: {
    type: "item_completed",
    item: { type: "ImageView", id, path: "file:///tmp/phone.png" },
  },
});
const output = (id: string, ...images: string[]) =>
  response({
    type: "custom_tool_call_output",
    call_id: id,
    output: images.map((bytes) => ({
      type: "input_image",
      image_url: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
    })),
  });

describe("Codex recorded image route", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "codex-images-"));
    file = join(dir, "rollout.jsonl");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const jsonl = (entries: object[]) =>
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  const app = () =>
    createCodexImageRoutes({
      resolveSessionFile: async (sessionId) =>
        sessionId === "session" ? file : null,
    });

  it("serves distinct recorded bytes for repeated views of the same overwritten/deleted file", async () => {
    await writeFile(
      file,
      jsonl([
        call("exec-1"),
        view("image-1"),
        output("exec-1", "first screenshot"),
        call("exec-2"),
        view("image-2"),
        output("exec-2", "second screenshot"),
      ]),
    );
    const routes = app();
    const first = await routes.request("/session/codex-images/image-1");
    const second = await routes.request("/session/codex-images/image-2");
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("image/png");
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect(await first.text()).toBe("first screenshot");
    expect(await second.text()).toBe("second screenshot");
  });

  it("matches direct view_image responses by call_id even with overlapping calls", async () => {
    await writeFile(
      file,
      jsonl([
        response({
          type: "function_call",
          call_id: "direct-1",
          name: "functions.view_image",
          arguments: '{"path":"/tmp/phone.png"}',
        }),
        call("unrelated"),
        response({
          type: "function_call_output",
          call_id: "direct-1",
          output: [
            {
              type: "input_image",
              image_url: "data:image/png;base64,Ynl0ZXM=",
            },
          ],
        }),
        output("unrelated", "wrong"),
      ]),
    );
    const result = await app().request("/session/codex-images/direct-1");
    expect(await result.text()).toBe("bytes");
  });

  it.each([
    [
      call("exec"),
      view("image"),
      view("other-image"),
      output("exec", "one", "two"),
    ],
    [
      call("exec"),
      call("other"),
      view("image"),
      output("exec", "one"),
      output("other", "two"),
    ],
    [call("exec"), view("image"), output("exec")],
    [call("exec"), view("image"), output("exec", "one", "two")],
    [view("image"), call("later"), output("later", "wrong")],
  ])(
    "does not fall back to a mutable file or guess an ambiguous image (%#)",
    async (...entries) => {
      await writeFile(file, jsonl(entries));
      const result = await app().request("/session/codex-images/image");
      expect(result.status).toBe(404);
      expect(result.headers.get("cache-control")).toContain("no-store");
    },
  );

  it("can retry after a live response is flushed without caching a missing image", async () => {
    await writeFile(file, jsonl([call("exec"), view("image")]));
    const routes = app();
    expect((await routes.request("/session/codex-images/image")).status).toBe(
      404,
    );
    await appendFile(file, jsonl([output("exec", "ready")]));
    const result = await routes.request("/session/codex-images/image");
    expect(result.status).toBe(200);
    expect(await result.text()).toBe("ready");
  });

  it("ignores compaction copies and images from other calls", async () => {
    await writeFile(
      file,
      jsonl([
        call("exec"),
        view("image"),
        output("exec"),
        {
          type: "compacted",
          payload: { replacement_history: [output("exec", "wrong").payload] },
        },
        call("other"),
        view("other-image"),
        output("other", "wrong"),
      ]),
    );
    expect((await app().request("/session/codex-images/image")).status).toBe(
      404,
    );
    expect((await app().request("/missing/codex-images/image")).status).toBe(
      404,
    );
    expect((await app().request("/session/codex-images/bad%2Fid")).status).toBe(
      400,
    );
  });
});
