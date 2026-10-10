/**
 * Native Codex concurrency regression with a local fake Responses endpoint.
 * No real model requests, user sessions, credentials, or running services.
 * pnpm exec tsx --conditions source scripts/smoke-side-conversations.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { type ServerResponse, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findCodexCliPath } from "../packages/server/src/sdk/cli-detection.js";
import { CodexAppServerClient } from "../packages/server/src/sdk/providers/codex.js";
import { createCodexSideConversation } from "../packages/server/src/side-conversations/codex.js";
import type { SideEvent } from "../packages/server/src/side-conversations/session.js";

async function main() {
  const binary = await findCodexCliPath();
  assert(binary, "Install Codex CLI before running the native smoke check");
  const directory = await mkdtemp(join(tmpdir(), "yep-side-concurrency-"));
  let releaseMain: (() => void) | undefined;
  let resolveMainRequest: (() => void) | undefined;
  const mainRequested = new Promise<void>((resolve) => {
    resolveMainRequest = resolve;
  });
  let requests = 0;
  let sidePayload:
    | { tools?: Array<{ name?: string; type: string }> }
    | undefined;
  const finish = (response: ServerResponse, id: string, text: string) => {
    for (const event of [
      {
        type: "response.output_item.added",
        item: { type: "message", id, role: "assistant", content: [] },
      },
      { type: "response.output_text.delta", delta: text },
      {
        type: "response.output_item.done",
        item: {
          type: "message",
          id,
          role: "assistant",
          content: [{ type: "output_text", text }],
        },
      },
      {
        type: "response.completed",
        response: {
          id: `response-${id}`,
          usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
        },
      },
    ])
      response.write(
        `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      );
    response.end();
  };
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests++;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(
        'event: response.created\ndata: {"type":"response.created","response":{"id":"r"}}\n\n',
      );
      if (requests === 1) {
        releaseMain = () => finish(response, "main-answer", "Main task done");
        resolveMainRequest?.();
      } else {
        sidePayload = JSON.parse(body);
        finish(response, "side-answer", "Side answer");
      }
    });
  });
  let client: CodexAppServerClient | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert(address && typeof address !== "string");
    await writeFile(
      join(directory, "config.toml"),
      `model = "side-static"\nmodel_provider = "side-static"\n[model_providers.side-static]\nname = "Local mock"\nbase_url = "http://127.0.0.1:${address.port}"\nwire_api = "responses"\n`,
    );
    client = new CodexAppServerClient(binary, directory, {
      ...process.env,
      CODEX_HOME: directory,
    });
    const active = client;
    const check = async () => {
      await active.connect();
      await active.requestIsolated("initialize", {
        clientInfo: { name: "yep-side-check", version: "1" },
        capabilities: null,
      });
      active.notify("initialized");
      const parent = await active.requestIsolated<{ thread: { id: string } }>(
        "thread/start",
        { cwd: directory, approvalPolicy: "never", sandbox: "read-only" },
      );
      await active.requestIsolated("turn/start", {
        threadId: parent.thread.id,
        input: [
          { type: "text", text: "Continue the main task", text_elements: [] },
        ],
      });
      await mainRequested;
      let resolveSide: (() => void) | undefined;
      const done = new Promise<void>((resolve) => {
        resolveSide = resolve;
      });
      const events: SideEvent[] = [];
      const side = await createCodexSideConversation({
        client: active,
        parentId: parent.thread.id,
        cwd: directory,
        context: "snapshot",
        emit(event) {
          events.push(event);
          if (event.type === "done") resolveSide?.();
        },
      });
      await side.send(
        "Explain the main task without continuing it",
        "side-question",
      );
      await done;
      const during = await active.requestIsolated<{
        thread: { status: { type: string } };
      }>("thread/read", { threadId: parent.thread.id, includeTurns: false });
      assert.equal(
        during.thread.status.type,
        "active",
        "Parent must remain active while side chat answers",
      );
      await side.close();
      releaseMain?.();
      for (;;) {
        const event = await active.nextNotification();
        const params = event.params as { threadId?: string } | undefined;
        if (
          event.method === "turn/completed" &&
          params?.threadId === parent.thread.id
        )
          break;
      }
      assert.equal(requests, 2);
      assert(
        events.some(
          (event) => event.type === "text" && event.text === "Side answer",
        ),
      );
      assert(JSON.stringify(sidePayload).includes("Continue the main task"));
      assert(JSON.stringify(sidePayload).includes("reference context"));
      const toolNames =
        sidePayload?.tools?.map((tool) => tool.name ?? tool.type) ?? [];
      assert(
        toolNames.every((name) =>
          ["view_image", "request_user_input"].includes(name),
        ),
        `Unexpected side tool surface: ${toolNames.join(", ")}`,
      );
      console.log(
        JSON.stringify({
          mockRequests: requests,
          parentContinued: true,
          sideAnswered: true,
          snapshotInherited: true,
          toolNames,
        }),
      );
    };
    await Promise.race([
      check(),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error("Native side smoke timed out")),
          25_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(deadline);
    await client?.closeAndWait();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

await main();
