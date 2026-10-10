import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import {
  CodexAppServerClient,
  CodexProvider,
} from "../../src/sdk/providers/codex.js";
import {
  type SideCodexClient,
  createCodexSideConversation,
} from "../../src/side-conversations/codex.js";

describe("Codex side thread", () => {
  it("forks an externally owned bridge session without taking over its parent and inherits current model settings", async () => {
    let port = 0;
    const http = createServer((request, response) => {
      const path = request.url ?? "";
      const body = path.endsWith("/active")
        ? { active: true, mcpProfile: "full" }
        : path.endsWith("/view")
          ? {
              sessionView: {
                session: {
                  model: "main-current-model",
                  reasoningEffort: "high",
                  serviceTier: "priority",
                },
              },
            }
          : { listening: true, url: `ws://127.0.0.1:${port}` };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    });
    const ws = new WebSocketServer({ server: http });
    const calls: Array<{ method: string; params?: Record<string, unknown> }> =
      [];
    ws.on("connection", (socket) =>
      socket.on("message", (data) => {
        const request = JSON.parse(String(data));
        calls.push(request);
        if (request.id === undefined) return;
        const result =
          request.method === "thread/read"
            ? { thread: { id: "parent", cwd: "/tmp", modelProvider: "openai" } }
            : request.method === "config/read"
              ? { config: {} }
              : request.method === "thread/fork"
                ? {
                    thread: { id: "side", ephemeral: true },
                    sandbox: { type: "readOnly" },
                    model: "main-current-model",
                  }
                : {};
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
      }),
    );
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (!address || typeof address === "string")
      throw new Error("Missing loopback port");
    port = address.port;
    const provider = new CodexProvider({
      bridgeExecution: {
        mode: "external",
        controlUrl: `http://127.0.0.1:${port}`,
      },
    });
    try {
      expect(
        await provider.bridgeSideConversation("parent", { action: "get" }),
      ).toEqual({ supported: true });
      expect(calls).toHaveLength(0);
      const responses = await Promise.all(
        [1, 2].map(() =>
          provider.bridgeSideConversation("parent", {
            action: "create",
            requestId: "same",
            context: "snapshot",
          }),
        ),
      );
      expect(responses[0]?.conversation?.id).toBe(
        responses[1]?.conversation?.id,
      );
      expect(
        calls.filter((call) => call.method === "thread/fork"),
      ).toHaveLength(1);
      expect(
        calls.find((call) => call.method === "thread/fork")?.params,
      ).toMatchObject({
        threadId: "parent",
        model: "main-current-model",
        serviceTier: "priority",
        config: { model_reasoning_effort: "high" },
      });
      expect(
        calls.some((call) =>
          ["thread/resume", "turn/steer", "turn/interrupt"].includes(
            call.method,
          ),
        ),
      ).toBe(false);
    } finally {
      await provider.disposeBridgeSideConversations();
      await new Promise<void>((resolve) => ws.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  });

  it("uses a disposable read-only snapshot and interrupts only its own turn", async () => {
    let notify!: (method: string, params: unknown) => void;
    const request = vi.fn(async (method: string) => {
      if (method === "config/read")
        return {
          config: {
            developer_instructions: "existing policy",
            mcp_servers: {
              remote: { url: "https://example.invalid/mcp", enabled: true },
            },
          },
        };
      if (method === "thread/fork")
        return {
          thread: { id: "side", ephemeral: true },
          sandbox: { type: "readOnly" },
          model: "m",
          reasoningEffort: "high",
        };
      if (method === "turn/start")
        return { turn: { id: "child-turn", status: "inProgress" } };
      return {};
    });
    const client = {
      requestIsolated: request,
      isolateThread: vi.fn((_id, handler) => {
        notify = handler;
        return vi.fn();
      }),
    } as unknown as SideCodexClient;
    const emit = vi.fn();
    const side = await createCodexSideConversation({
      client,
      parentId: "main",
      cwd: "/tmp",
      context: "snapshot",
      emit,
    });
    const calls = request.mock.calls as unknown as Array<
      [string, Record<string, unknown>]
    >;
    const params = calls.find(([m]) => m === "thread/fork")?.[1];
    expect(params).toMatchObject({
      threadId: "main",
      ephemeral: true,
      excludeTurns: true,
      sandbox: "read-only",
      approvalPolicy: "never",
      config: {
        features: { shell_tool: false, multi_agent: false },
        mcp_servers: { remote: { enabled: false, enabled_tools: [] } },
      },
    });
    expect(params).not.toHaveProperty("lastTurnId");
    expect(params?.developerInstructions).toContain("existing policy");
    await side.send("explain", "request");
    notify("item/agentMessage/delta", { itemId: "answer", delta: "hello" });
    expect(emit).toHaveBeenCalledWith({
      type: "text",
      id: "answer",
      text: "hello",
      append: true,
    });
    await side.interrupt();
    expect(request).toHaveBeenCalledWith("turn/interrupt", {
      threadId: "side",
      turnId: "child-turn",
    });
    notify("turn/completed", {
      turn: { id: "child-turn", status: "interrupted" },
    });
    await side.close();
    expect(request).toHaveBeenCalledWith("thread/unsubscribe", {
      threadId: "side",
    });
    expect(
      calls.some(([m]) => m === "thread/resume" || m === "turn/steer"),
    ).toBe(false);
  });
});

let server: WebSocketServer | undefined;
let client: CodexAppServerClient | undefined;
afterEach(async () => {
  await client?.closeAndWait();
  await new Promise<void>((resolve) =>
    server ? server.close(() => resolve()) : resolve(),
  );
});

it("demultiplexes child notifications and approvals before the main journal and main queue", async () => {
  server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server?.once("listening", resolve));
  let socket!: WebSocket;
  const received: unknown[] = [];
  server.on("connection", (ws) => {
    socket = ws;
    ws.on("message", (data) => received.push(JSON.parse(String(data))));
  });
  const address = server.address() as { port: number };
  client = new CodexAppServerClient("unused", "/tmp", {}, [], {
    kind: "websocket",
    url: `ws://127.0.0.1:${address.port}`,
  });
  await client.connect();
  const observer = {
    onClientRequest: vi.fn(),
    onClientResponse: vi.fn(),
    onServerRequest: vi.fn(),
    onServerNotification: vi.fn(),
  };
  await client.setEventObserver(observer as never);
  const parentApproval = vi.fn(async () => ({}));
  client.setServerRequestHandler(parentApproval);
  const child = vi.fn();
  const retire = client.isolateThread("child", child, vi.fn());
  socket.send(
    JSON.stringify({
      method: "item/agentMessage/delta",
      params: { threadId: "child", delta: "side" },
    }),
  );
  socket.send(
    JSON.stringify({
      id: "child-approval",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "child" },
    }),
  );
  socket.send(
    JSON.stringify({
      method: "turn/completed",
      params: { threadId: "main", turn: { id: "main-turn" } },
    }),
  );
  const main = await client.nextNotification();
  expect(main.params).toMatchObject({ threadId: "main" });
  expect(child).toHaveBeenCalledTimes(1);
  expect(observer.onServerNotification).toHaveBeenCalledTimes(1);
  expect(parentApproval).not.toHaveBeenCalled();
  await vi.waitFor(() =>
    expect(received).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "child-approval",
          error: expect.any(Object),
        }),
      ]),
    ),
  );
  retire();
  socket.send(
    JSON.stringify({ method: "turn/completed", params: { threadId: "child" } }),
  );
  socket.send(
    JSON.stringify({ method: "turn/completed", params: { threadId: "main" } }),
  );
  expect((await client.nextNotification()).params).toMatchObject({
    threadId: "main",
  });
  expect(observer.onServerNotification).toHaveBeenCalledTimes(2);
});
