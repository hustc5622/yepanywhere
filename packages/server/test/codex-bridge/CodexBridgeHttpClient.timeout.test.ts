import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexBridgeHttpClient } from "../../src/codex-bridge/CodexBridgeHttpClient.js";

describe("CodexBridgeHttpClient against a sidecar that never answers", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    // Accept every request and never respond: a wedged sidecar.
    server = createServer(() => {});
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it("gives up on control calls instead of waiting for the transport timeout", async () => {
    const client = new CodexBridgeHttpClient({
      baseUrl,
      requestTimeoutMs: 100,
    });
    const started = Date.now();
    const [status, sessions, views] = await Promise.all([
      client.getStatus(),
      client.listSessions(),
      client.listSessionViews(),
    ]);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(status.listening).toBe(false);
    expect(sessions).toEqual([]);
    expect(views).toEqual([]);
  });
});
