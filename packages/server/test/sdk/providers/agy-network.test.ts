import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AgySplitProxy,
  getAgyUpstreamFailure,
  isAgyUpstreamHost,
  parseConnectTarget,
  setAgyUpstreamFailureForTests,
  startAgySplitProxy,
} from "../../../src/sdk/providers/agy-network.js";

const closers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
  setAgyUpstreamFailureForTests(null);
});

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  return (server.address() as net.AddressInfo).port;
}

/** TCP service that answers every chunk with `${tag}:${chunk}`. */
async function echoServer(tag: string) {
  const sockets = new Set<net.Socket>();
  let connections = 0;
  const server = net.createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", (chunk) => socket.write(`${tag}:${chunk}`));
  });
  closers.push(() => {
    for (const socket of sockets) socket.destroy();
  });
  const port = await listen(server);
  return { port, connections: () => connections };
}

/** Upstream CONNECT proxy that tunnels every request to `targetPort`. */
async function upstreamProxy(targetPort: number, status = 200) {
  const seen: Array<{ url?: string; auth?: string }> = [];
  const sockets = new Set<net.Socket>();
  const server = http.createServer((_req, res) => res.writeHead(405).end());
  server.on("connect", (req, client: net.Socket) => {
    sockets.add(client);
    seen.push({ url: req.url, auth: req.headers["proxy-authorization"] });
    if (status !== 200) {
      client.end(`HTTP/1.1 ${status} Denied\r\n\r\n`);
      return;
    }
    const remote = net.connect(targetPort, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection established\r\n\r\n");
      client.pipe(remote);
      remote.pipe(client);
    });
    sockets.add(remote);
    remote.on("error", () => client.destroy());
    client.on("error", () => remote.destroy());
  });
  closers.push(() => {
    for (const socket of sockets) socket.destroy();
  });
  const port = await listen(server);
  return { port, seen };
}

/** CONNECT through the split proxy, send `ping`, return status and reply. */
function tunnel(proxyUrl: string, authority: string) {
  return new Promise<{ status: string; reply: string }>((resolve, reject) => {
    const { port } = new URL(proxyUrl);
    const socket = net.connect(Number(port), "127.0.0.1", () => {
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`,
      );
    });
    let buffered = "";
    let status = "";
    socket.on("data", (chunk) => {
      buffered += chunk.toString();
      if (!status) {
        const end = buffered.indexOf("\r\n\r\n");
        if (end < 0) return;
        status = buffered.slice(9, 12);
        buffered = buffered.slice(end + 4);
        if (status !== "200") return;
        socket.write("ping");
        return;
      }
      if (buffered.length > 0) {
        socket.destroy();
        resolve({ status, reply: buffered });
      }
    });
    socket.on("close", () => resolve({ status, reply: buffered }));
    socket.on("error", reject);
  });
}

async function split(upstream: string): Promise<AgySplitProxy> {
  const proxy = await startAgySplitProxy(upstream);
  closers.push(() => proxy.close());
  return proxy;
}

describe("agy upstream host selection", () => {
  it("matches Google domains and their subdomains only", () => {
    for (const host of [
      "daily-cloudcode-pa.googleapis.com",
      "googleapis.com",
      "oauth2.googleapis.com",
      "accounts.google.com",
      "www.gstatic.com",
      "lh3.googleusercontent.com",
      "CloudCode-PA.GoogleAPIs.com.",
    ]) {
      expect(isAgyUpstreamHost(host), host).toBe(true);
    }
    for (const host of [
      "evilgoogle.com",
      "google.com.example.net",
      "antigravity.google",
      "github.com",
      "mountainspirit.xaminim.com",
      "127.0.0.1",
    ]) {
      expect(isAgyUpstreamHost(host), host).toBe(false);
    }
  });

  it("parses CONNECT authorities and rejects malformed ones", () => {
    expect(parseConnectTarget("example.com:443")).toEqual({
      host: "example.com",
      port: 443,
    });
    expect(parseConnectTarget("[::1]:8443")).toEqual({
      host: "::1",
      port: 8443,
    });
    expect(parseConnectTarget("example.com")).toBeNull();
    expect(parseConnectTarget("user@example.com:443")).toBeNull();
    expect(parseConnectTarget("example.com:0")).toBeNull();
    expect(parseConnectTarget(undefined)).toBeNull();
  });
});

describe("agy split proxy", () => {
  it("tunnels Google hosts through the authenticated upstream", async () => {
    const remote = await echoServer("upstream");
    const upstream = await upstreamProxy(remote.port);
    const proxy = await split(`http://agy:p%40ss@127.0.0.1:${upstream.port}`);

    const result = await tunnel(
      proxy.url,
      "daily-cloudcode-pa.googleapis.com:443",
    );

    expect(result).toEqual({ status: "200", reply: "upstream:ping" });
    expect(upstream.seen).toEqual([
      {
        url: "daily-cloudcode-pa.googleapis.com:443",
        auth: `Basic ${Buffer.from("agy:p@ss").toString("base64")}`,
      },
    ]);
  });

  it("connects every other host directly, bypassing the upstream", async () => {
    const remote = await echoServer("upstream");
    const upstream = await upstreamProxy(remote.port);
    const direct = await echoServer("direct");
    const proxy = await split(`http://127.0.0.1:${upstream.port}`);

    const result = await tunnel(proxy.url, `127.0.0.1:${direct.port}`);

    expect(result).toEqual({ status: "200", reply: "direct:ping" });
    expect(upstream.seen).toEqual([]);
  });

  it("fails Google hosts with 502 instead of falling back to direct", async () => {
    const remote = await echoServer("upstream");
    const upstream = await upstreamProxy(remote.port, 403);
    const proxy = await split(`http://127.0.0.1:${upstream.port}`);

    const result = await tunnel(proxy.url, "oauth2.googleapis.com:443");

    expect(result.status).toBe("502");
    expect(remote.connections()).toBe(0);
  });

  it("remembers a failing upstream until a tunnel succeeds again", async () => {
    const remote = await echoServer("upstream");
    const refusing = await upstreamProxy(remote.port, 403);
    const working = await upstreamProxy(remote.port);
    expect(getAgyUpstreamFailure()).toBeNull();

    const broken = await split(`http://127.0.0.1:${refusing.port}`);
    await tunnel(broken.url, "oauth2.googleapis.com:443");
    expect(getAgyUpstreamFailure()).toMatch(/refused CONNECT \(403\)/);
    expect(getAgyUpstreamFailure(Date.now() + 10 * 60_000)).toBeNull();

    // Direct hosts say nothing about the upstream exit.
    const direct = await echoServer("direct");
    await tunnel(broken.url, `127.0.0.1:${direct.port}`);
    expect(getAgyUpstreamFailure()).not.toBeNull();

    const healthy = await split(`http://127.0.0.1:${working.port}`);
    await tunnel(healthy.url, "oauth2.googleapis.com:443");
    expect(getAgyUpstreamFailure()).toBeNull();
  });

  it("only serves CONNECT and rejects non-HTTP upstreams", async () => {
    const proxy = await split("http://127.0.0.1:9");
    const response = await fetch(`${proxy.url}/`);
    expect(response.status).toBe(405);
    await expect(startAgySplitProxy("socks5://127.0.0.1:1080")).rejects.toThrow(
      /http/,
    );
  });
});
