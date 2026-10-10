import { expect, it, vi } from "vitest";
import { EmbeddedRuntimeController } from "../../src/runtime/EmbeddedRuntimeController.js";
import { HttpRuntimeController } from "../../src/runtime/HttpRuntimeController.js";
import { createRuntimeControlApp } from "../../src/runtime/control-server.js";
import type { Supervisor } from "../../src/supervisor/Supervisor.js";

it("passes side controls through external runtime without queueing or replacing the main process", async () => {
  const execute = vi.fn(async () => ({ supported: true }));
  const main = {
    id: "main-process",
    state: "in-turn",
    isTerminated: false,
    sideConversations: { execute },
  };
  const supervisor = {
    getProcessForSession: vi.fn(() => main),
    queueMessageToSession: vi.fn(),
    resumeSession: vi.fn(),
  };
  const embedded = new EmbeddedRuntimeController(
    supervisor as unknown as Supervisor,
  );
  const app = createRuntimeControlApp({
    controller: embedded,
    token: "test-token",
  });
  const remote = new HttpRuntimeController({
    baseUrl: "http://runtime",
    token: "test-token",
    fetch: (input, init) => app.request(String(input), init),
  });
  expect(
    await remote.sideConversation("main", {
      action: "create",
      requestId: "r",
      context: "snapshot",
    }),
  ).toEqual({ supported: true });
  expect(execute).toHaveBeenCalledWith({
    action: "create",
    requestId: "r",
    context: "snapshot",
  });
  expect(main.state).toBe("in-turn");
  expect(supervisor.queueMessageToSession).not.toHaveBeenCalled();
  expect(supervisor.resumeSession).not.toHaveBeenCalled();
  expect(
    (
      await app.request("/sessions/main/side-conversation", {
        method: "POST",
        body: "{}",
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await app.request("/sessions/main/side-conversation", {
        method: "POST",
        headers: { authorization: "Bearer test-token" },
        body: JSON.stringify({ action: "get", threadId: "foreign" }),
      })
    ).status,
  ).toBe(400);
});

it("reports old external runtimes as unsupported instead of falling back to a main prompt", async () => {
  const fetch = vi.fn(async () => new Response("{}", { status: 404 }));
  const remote = new HttpRuntimeController({
    baseUrl: "http://runtime",
    token: "token",
    fetch,
  });
  expect(await remote.sideConversation("parent", { action: "get" })).toEqual({
    supported: false,
    reason: "unsupported",
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});
