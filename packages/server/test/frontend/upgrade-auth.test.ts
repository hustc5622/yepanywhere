import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { WebSocketServer } from "ws";
import type { AuthService } from "../../src/auth/AuthService.js";
import { attachUnifiedUpgradeHandler } from "../../src/frontend/proxy.js";
import { createAuthMiddleware } from "../../src/middleware/auth.js";

describe("attachUnifiedUpgradeHandler auth rejection status", () => {
  it("returns HTTP 401 Unauthorized when auth middleware blocks /api/ws upgrade", async () => {
    const server = new EventEmitter();
    const authService = {
      isEnabled: () => true,
      hasAccount: () => true,
      isLocalhostOpen: () => false,
      validateSession: async () => false,
      validateSessionWithRefresh: async () => ({
        valid: false,
        shouldRefreshCookie: false,
      }),
    } as unknown as AuthService;

    const app = new Hono();
    app.use("/api/*", createAuthMiddleware({ authService }));
    app.get("/api/ws", (c) => c.text("should not reach"));

    attachUnifiedUpgradeHandler(
      server as unknown as Parameters<typeof attachUnifiedUpgradeHandler>[0],
      {
        isApiPath: (p) => p.startsWith("/api"),
        app,
        wss: {} as WebSocketServer,
      },
    );

    const written: string[] = [];
    const socket = Object.assign(new EventEmitter(), {
      end(chunk?: string) {
        if (chunk) written.push(chunk);
      },
    }) as unknown as Socket;

    const req = {
      url: "/api/ws",
      headers: { host: "127.0.0.1:8022" },
    } as unknown as IncomingMessage;

    server.emit("upgrade", req, socket, Buffer.alloc(0));

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(written.join("")).toContain("HTTP/1.1 401 Unauthorized");
  });
});
