import { describe, expect, it, vi } from "vitest";
import { HttpRuntimeController } from "../../src/runtime/HttpRuntimeController.js";

function sseResponse(frames: string[], close: boolean): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      if (close) controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function frame(eventType: string, data: unknown = {}): string {
  return `data: ${JSON.stringify({ eventType, data })}\n\n`;
}

function controllerFor(
  respond: (signal: AbortSignal) => Promise<Response>,
): HttpRuntimeController {
  return new HttpRuntimeController({
    baseUrl: "http://runtime.invalid",
    token: "token",
    requestTimeoutMs: 50,
    streamIdleTimeoutMs: 80,
    fetch: async (_input, init) => respond(init?.signal as AbortSignal),
  });
}

describe("runtime session stream liveness", () => {
  it("reports a stream that goes silent", async () => {
    const controller = controllerFor(async () => sseResponse([], false));
    const onError = vi.fn();
    const subscription = await controller.subscribeSession("s", () => {}, {
      onError,
    });
    expect(subscription).not.toBeNull();
    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringMatching(/silent/) }),
      ),
    );
    subscription?.cleanup();
  });

  it("reports a stream that ends before the session completes", async () => {
    const controller = controllerFor(async () =>
      sseResponse([frame("message")], true),
    );
    const onError = vi.fn();
    const events: string[] = [];
    await controller.subscribeSession("s", (type) => events.push(type), {
      onError,
    });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(events).toEqual(["message"]);
  });

  it("treats a stream closed after complete as a normal end", async () => {
    const controller = controllerFor(async () =>
      sseResponse([frame("message"), frame("complete")], true),
    );
    const onError = vi.fn();
    const events: string[] = [];
    await controller.subscribeSession("s", (type) => events.push(type), {
      onError,
    });
    await vi.waitFor(() => expect(events).toEqual(["message", "complete"]));
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(onError).not.toHaveBeenCalled();
  });

  it("bounds the wait for stream headers", async () => {
    const controller = controllerFor(
      (signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    await expect(controller.subscribeSession("s", () => {})).rejects.toThrow(
      /\/events did not open within 50ms/,
    );
  });
});
