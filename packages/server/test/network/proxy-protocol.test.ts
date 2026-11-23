import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as tls from "node:tls";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import {
  getProxyProtocolClient,
  installProxyProtocol,
  isLoopbackAddress,
  parseProxyProtocolHeader,
} from "../../src/network/proxy-protocol.js";

const V2_SIGNATURE = Buffer.from([
  0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a,
]);

function v2Ipv4(source: string, sourcePort: number, tlv = Buffer.alloc(0)) {
  const payload = Buffer.alloc(12);
  source.split(".").forEach((octet, index) => {
    payload[index] = Number(octet);
  });
  payload.set([127, 0, 0, 1], 4);
  payload.writeUInt16BE(sourcePort, 8);
  payload.writeUInt16BE(8022, 10);
  const header = Buffer.alloc(16);
  V2_SIGNATURE.copy(header);
  header[12] = 0x21; // v2, PROXY
  header[13] = 0x11; // AF_INET, STREAM
  header.writeUInt16BE(payload.length + tlv.length, 14);
  return Buffer.concat([header, payload, tlv]);
}

function v2Ipv6(sourceGroups: number[], sourcePort: number) {
  const payload = Buffer.alloc(36);
  sourceGroups.forEach((group, index) => {
    payload.writeUInt16BE(group, index * 2);
  });
  payload.writeUInt16BE(1, 30); // ::1 destination
  payload.writeUInt16BE(sourcePort, 32);
  payload.writeUInt16BE(8022, 34);
  const header = Buffer.alloc(16);
  V2_SIGNATURE.copy(header);
  header[12] = 0x21;
  header[13] = 0x21; // AF_INET6, STREAM
  header.writeUInt16BE(payload.length, 14);
  return Buffer.concat([header, payload]);
}

function v2Local() {
  const header = Buffer.alloc(16);
  V2_SIGNATURE.copy(header);
  header[12] = 0x20; // v2, LOCAL
  header[13] = 0x00;
  return header;
}

describe("parseProxyProtocolHeader", () => {
  it("parses v1 TCP4 and TCP6 lines", () => {
    const v4 = Buffer.from(
      "PROXY TCP4 203.0.113.7 127.0.0.1 51000 8022\r\nGET",
    );
    expect(parseProxyProtocolHeader(v4)).toEqual({
      kind: "header",
      length: v4.length - 3,
      client: { address: "203.0.113.7", port: 51000, version: 1 },
    });
    const v6 = Buffer.from("PROXY TCP6 2001:db8::1 ::1 51000 8022\r\n");
    expect(parseProxyProtocolHeader(v6)).toMatchObject({
      kind: "header",
      client: { address: "2001:db8::1", version: 1 },
    });
    expect(parseProxyProtocolHeader(Buffer.from("PROXY UNKNOWN\r\n"))).toEqual({
      kind: "header",
      length: 15,
      client: null,
    });
  });

  it("parses v2 IPv4, IPv6 with TLVs and LOCAL", () => {
    const tlv = Buffer.from([0x04, 0x00, 0x02, 0xab, 0xcd]);
    const v4 = v2Ipv4("198.51.100.9", 40000, tlv);
    expect(parseProxyProtocolHeader(v4)).toEqual({
      kind: "header",
      length: v4.length,
      client: { address: "198.51.100.9", port: 40000, version: 2 },
    });
    const v6 = v2Ipv6([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0x42], 443);
    expect(parseProxyProtocolHeader(v6)).toMatchObject({
      kind: "header",
      client: { address: "2001:db8::42", port: 443 },
    });
    expect(parseProxyProtocolHeader(v2Local())).toEqual({
      kind: "header",
      length: 16,
      client: null,
    });
  });

  it("asks for more bytes on every truncated prefix", () => {
    const v2 = v2Ipv4("198.51.100.9", 40000);
    for (let end = 1; end < v2.length; end += 1) {
      expect(parseProxyProtocolHeader(v2.subarray(0, end)).kind).toBe(
        "need-more",
      );
    }
    const v1 = Buffer.from("PROXY TCP4 203.0.113.7 127.0.0.1 51000 8022\r\n");
    for (let end = 1; end < v1.length; end += 1) {
      expect(parseProxyProtocolHeader(v1.subarray(0, end)).kind).toBe(
        "need-more",
      );
    }
  });

  it("never mistakes HTTP or TLS for a PROXY header", () => {
    for (const start of ["GET / HTTP/1.1\r\n", "POST /x", "PUT ", "PATCH "]) {
      expect(parseProxyProtocolHeader(Buffer.from(start)).kind).toBe("none");
    }
    expect(parseProxyProtocolHeader(Buffer.from([0x16, 0x03, 0x01])).kind).toBe(
      "none",
    );
    expect(parseProxyProtocolHeader(Buffer.from("\r\nGET")).kind).toBe("none");
  });

  it("rejects malformed headers", () => {
    expect(
      parseProxyProtocolHeader(Buffer.from("PROXY TCP4 nope 127.0.0.1 1 2\r\n"))
        .kind,
    ).toBe("invalid");
    expect(
      parseProxyProtocolHeader(Buffer.from(`PROXY ${"x".repeat(120)}`)).kind,
    ).toBe("invalid");
    const badVersion = v2Ipv4("1.2.3.4", 1);
    badVersion[12] = 0x11;
    expect(parseProxyProtocolHeader(badVersion).kind).toBe("invalid");
  });
});

describe("isLoopbackAddress", () => {
  it("accepts loopback forms only", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.5.6.7")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("10.0.0.2")).toBe(false);
    expect(isLoopbackAddress("::ffff:192.168.1.2")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

type Served = ReturnType<typeof serve>;

const servers: Served[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          (
            server as unknown as { closeAllConnections?: () => void }
          ).closeAllConnections?.();
          server.close(() => resolve());
        }),
    ),
  );
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function echoApp() {
  const app = new Hono<{
    Bindings: { incoming: { socket: net.Socket } };
  }>();
  const describeClient = (socket: net.Socket) =>
    getProxyProtocolClient(socket)?.address ?? `peer:${socket.remoteAddress}`;
  app.get("/ip", (c) => c.text(describeClient(c.env.incoming.socket)));
  app.post("/echo", async (c) =>
    c.text(`${describeClient(c.env.incoming.socket)}|${await c.req.text()}`),
  );
  return app;
}

async function listen(
  options: { tls?: { cert: Buffer; key: Buffer }; trusted?: boolean } = {},
): Promise<{ server: Served; port: number }> {
  const app = echoApp();
  const server = await new Promise<Served>((resolve) => {
    const created: Served = options.tls
      ? serve(
          {
            fetch: app.fetch,
            port: 0,
            hostname: "127.0.0.1",
            createServer: createHttpsServer,
            serverOptions: options.tls,
          },
          () => resolve(created),
        )
      : serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () =>
          resolve(created),
        );
    installProxyProtocol(created as unknown as net.Server, {
      ...(options.trusted === false ? { isTrustedPeer: () => false } : {}),
    });
  });
  servers.push(server);
  const address = server.address() as net.AddressInfo;
  return { server, port: address.port };
}

function rawExchange(
  port: number,
  chunks: Buffer[],
  until: (text: string) => boolean,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let text = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timed out; received: ${JSON.stringify(text)}`));
    }, 4000);
    socket.on("data", (data) => {
      text += data.toString("utf8");
      if (until(text)) {
        clearTimeout(timer);
        socket.destroy();
        resolve(text);
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(text);
    });
    socket.on("connect", async () => {
      for (const chunk of chunks) {
        socket.write(chunk);
        await new Promise((r) => setTimeout(r, 15));
      }
    });
  });
}

const GET_IP = Buffer.from(
  "GET /ip HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
);

describe("installProxyProtocol over HTTP", () => {
  it("serves plain local clients unchanged", async () => {
    const { port } = await listen();
    const response = await fetch(`http://127.0.0.1:${port}/ip`);
    expect(await response.text()).toBe("peer:127.0.0.1");
  });

  it("uses the v2 client address when header and request share a packet", async () => {
    const { port } = await listen();
    const text = await rawExchange(
      port,
      [Buffer.concat([v2Ipv4("203.0.113.7", 51000), GET_IP])],
      (body) => body.includes("203.0.113.7"),
    );
    expect(text).toContain("HTTP/1.1 200");
    expect(text).toContain("203.0.113.7");
  });

  it("handles a header split across writes and a v1 header", async () => {
    const { port } = await listen();
    const header = v2Ipv4("198.51.100.20", 1234);
    const split = await rawExchange(
      port,
      [header.subarray(0, 5), header.subarray(5), GET_IP],
      (body) => body.includes("198.51.100.20"),
    );
    expect(split).toContain("198.51.100.20");

    const v1 = await rawExchange(
      port,
      [Buffer.from("PROXY TCP4 192.0.2.44 127.0.0.1 5000 8022\r\n"), GET_IP],
      (body) => body.includes("192.0.2.44"),
    );
    expect(v1).toContain("192.0.2.44");
  });

  it("keeps the address for keep-alive requests and request bodies", async () => {
    const { port } = await listen();
    const first = Buffer.from(
      "POST /echo HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\nhello",
    );
    const second = Buffer.from(
      "GET /ip HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
    );
    const text = await rawExchange(
      port,
      [Buffer.concat([v2Ipv4("203.0.113.99", 1), first]), second],
      (body) => (body.match(/HTTP\/1\.1 200/g) ?? []).length >= 2,
    );
    expect(text).toContain("203.0.113.99|hello");
    expect((text.match(/203\.0\.113\.99/g) ?? []).length).toBe(2);
  });

  it("ignores PROXY headers from untrusted peers", async () => {
    const { port } = await listen({ trusted: false });
    const text = await rawExchange(
      port,
      [Buffer.concat([v2Ipv4("203.0.113.7", 51000), GET_IP])],
      () => false,
    );
    expect(text).not.toContain("203.0.113.7");
    expect(text).toContain("400");
  });

  it("drops connections with a malformed header", async () => {
    const { port } = await listen();
    const text = await rawExchange(
      port,
      [Buffer.from("PROXY TCP4 not-an-ip 127.0.0.1 1 2\r\n"), GET_IP],
      () => false,
    );
    expect(text).toBe("");
  });

  it("passes WebSocket upgrades through after the header", async () => {
    const { server, port } = await listen();
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
      wss.handleUpgrade(req, socket as net.Socket, head, (ws) => {
        ws.send(getProxyProtocolClient(req.socket)?.address ?? "none");
        ws.close();
      });
    });
    const upgrade = Buffer.from(
      [
        "GET /ws HTTP/1.1",
        "Host: 127.0.0.1",
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "",
        "",
      ].join("\r\n"),
    );
    const text = await rawExchange(
      port,
      [Buffer.concat([v2Ipv4("203.0.113.55", 7), upgrade])],
      (body) => body.includes("203.0.113.55"),
    );
    expect(text).toContain("101 Switching Protocols");
    expect(text).toContain("203.0.113.55");
    wss.close();
  });
});

function generateCert(): { cert: Buffer; key: Buffer } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-protocol-tls-"));
  tempDirs.push(dir);
  const keyPath = path.join(dir, "k.pem");
  const certPath = path.join(dir, "c.pem");
  const result = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr);
  return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
}

describe("installProxyProtocol over HTTPS", () => {
  function tlsRequest(
    port: number,
    header?: Buffer,
    samePacket = false,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const raw = net.connect(port, "127.0.0.1", () => {
        if (samePacket) {
          // Coalesce the header and the ClientHello into one TCP write.
          raw.cork();
          setTimeout(() => raw.uncork(), 20);
        }
        if (header) raw.write(header);
        const secure = tls.connect({
          socket: raw,
          rejectUnauthorized: false,
          servername: "localhost",
        });
        let text = "";
        secure.on("secureConnect", () => secure.write(GET_IP));
        secure.on("data", (data) => {
          text += data.toString("utf8");
        });
        secure.on("end", () => resolve(text));
        secure.on("close", () => resolve(text));
        secure.on("error", reject);
      });
      raw.on("error", reject);
    });
  }

  it("reads the header before the TLS handshake", async () => {
    const { port } = await listen({ tls: generateCert() });
    const proxied = await tlsRequest(port, v2Ipv4("203.0.113.8", 9));
    expect(proxied).toContain("HTTP/1.1 200");
    expect(proxied).toContain("203.0.113.8");

    const coalesced = await tlsRequest(port, v2Ipv4("203.0.113.12", 9), true);
    expect(coalesced).toContain("203.0.113.12");

    const direct = await tlsRequest(port);
    expect(direct).toContain("peer:127.0.0.1");
  });
});
