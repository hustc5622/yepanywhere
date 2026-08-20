import type { Context } from "hono";
import type { WSEvents } from "hono/ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getLogger } from "../../src/logging/logger.js";
import { createWsRoutes } from "../../src/routes/ws.js";

describe("WebSocket route lifecycle diagnostics", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("correlates connect and disconnect logs with connection duration and close details", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T00:00:00.000Z"));
    const info = vi.spyOn(getLogger(), "info").mockImplementation(() => {});
    let createEvents: ((context: Context) => WSEvents) | undefined;
    const upgradeWebSocket = vi.fn(
      (factory: (context: Context) => WSEvents) => {
        createEvents = factory;
        return {};
      },
    );

    createWsRoutes({
      upgradeWebSocket,
      app: {},
      baseUrl: "http://localhost:3400",
      supervisor: {},
      eventBus: {},
      uploadManager: { cleanupConnection: vi.fn() },
    } as unknown as Parameters<typeof createWsRoutes>[0]);

    if (!createEvents) throw new Error("Expected WebSocket event factory");
    const events = createEvents({
      req: {
        header: () => undefined,
        query: () => undefined,
      },
    } as unknown as Context);
    const raw = {
      OPEN: 1,
      readyState: 1,
      ping: vi.fn(),
    };
    const socket = {
      raw,
      send: vi.fn(),
      close: vi.fn(),
    };

    events.onOpen?.({} as Event, socket as never);
    vi.advanceTimersByTime(31_000);
    events.onClose?.(
      { code: 1006, reason: "proxy reset" } as CloseEvent,
      socket as never,
    );

    const connected = info.mock.calls.find(
      ([payload]) => payload.event === "ws_client_connected",
    )?.[0];
    const disconnected = info.mock.calls.find(
      ([payload]) => payload.event === "ws_client_disconnected",
    )?.[0];
    expect(connected).toEqual({
      event: "ws_client_connected",
      connectionId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
    });
    expect(disconnected).toEqual({
      event: "ws_client_disconnected",
      connectionId: connected?.connectionId,
      durationMs: 31_000,
      closeCode: 1006,
      closeReason: "proxy reset",
    });
  });
});
