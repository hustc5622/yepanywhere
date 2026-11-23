import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { serve } from "@hono/node-server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthService } from "../../src/auth/AuthService.js";
import { createAuthRoutes } from "../../src/auth/routes.js";
import { installProxyProtocol } from "../../src/network/proxy-protocol.js";

const V2_SIGNATURE = Buffer.from([
  0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a,
]);

function proxyHeader(source: string): Buffer {
  const header = Buffer.alloc(28);
  V2_SIGNATURE.copy(header);
  header[12] = 0x21;
  header[13] = 0x11;
  header.writeUInt16BE(12, 14);
  source.split(".").forEach((octet, index) => {
    header[16 + index] = Number(octet);
  });
  header.set([127, 0, 0, 1], 20);
  header.writeUInt16BE(40000, 24);
  header.writeUInt16BE(8022, 26);
  return header;
}

/** One login over a fresh connection, as frpc would forward it. */
function loginThroughTunnel(
  port: number,
  source: string | null,
  password: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const body = JSON.stringify({ password });
  const request = Buffer.from(
    [
      "POST /login HTTP/1.1",
      "Host: 127.0.0.1",
      "Content-Type: application/json",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "Connection: close",
      "",
      body,
    ].join("\r\n"),
  );
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      // Write without half-closing: the server answers, then closes
      // because of `Connection: close`.
      socket.write(
        source ? Buffer.concat([proxyHeader(source), request]) : request,
      );
    });
    let raw = "";
    socket.on("data", (chunk) => {
      raw += chunk.toString("utf8");
    });
    socket.on("error", reject);
    socket.on("close", () => {
      const status = Number(raw.match(/^HTTP\/1\.1 (\d+)/)?.[1] ?? 0);
      const json = raw.slice(raw.indexOf("\r\n\r\n") + 4);
      try {
        resolve({ status, body: JSON.parse(json) });
      } catch {
        reject(new Error(`unexpected response: ${raw}`));
      }
    });
  });
}

describe("login rate limit behind an frp tunnel with PROXY protocol", () => {
  let testDir: string;
  let server: ReturnType<typeof serve>;
  let port: number;
  let authService: AuthService;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-proxy-proto-"));
    authService = new AuthService({ dataDir: testDir });
    await authService.initialize();
    await authService.enableAuth("correct-horse");
    const routes = createAuthRoutes({ authService });
    server = await new Promise((resolve) => {
      const created = serve(
        { fetch: routes.fetch, port: 0, hostname: "127.0.0.1" },
        () => resolve(created),
      );
      installProxyProtocol(created as unknown as net.Server);
    });
    port = (server.address() as net.AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("locks out only the client that keeps failing", async () => {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const result = await loginThroughTunnel(port, "203.0.113.10", "nope");
      expect(result.status).toBe(401);
      expect(result.body.attemptsRemaining).toBe(5 - attempt);
    }
    const locked = await loginThroughTunnel(port, "203.0.113.10", "nope");
    expect(locked.status).toBe(429);
    expect(locked.body.tier).toBe("soft");

    // Another phone behind the same tunnel still has its full budget.
    const other = await loginThroughTunnel(port, "198.51.100.20", "nope");
    expect(other.status).toBe(401);
    expect(other.body.attemptsRemaining).toBe(4);
    const ok = await loginThroughTunnel(port, "198.51.100.20", "correct-horse");
    expect(ok.status).toBe(200);

    // Direct local clients keep their own loopback bucket.
    const local = await loginThroughTunnel(port, null, "correct-horse");
    expect(local.status).toBe(200);
  });

  it("records the real client address on the session", async () => {
    const ok = await loginThroughTunnel(port, "203.0.113.77", "correct-horse");
    expect(ok.status).toBe(200);
    const raw = JSON.parse(
      await fs.readFile(authService.getFilePath(), "utf-8"),
    ) as { sessions: Record<string, { lastIp?: string }> };
    expect(Object.values(raw.sessions).map((s) => s.lastIp)).toContain(
      "203.0.113.77",
    );
  });
});
