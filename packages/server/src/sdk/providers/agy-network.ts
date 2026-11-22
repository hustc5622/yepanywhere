/**
 * Model-only network routing for Antigravity CLI (`agy`).
 *
 * agy is a closed binary: there is no endpoint override Yep can rely on, and
 * every proxy variable handed to it is inherited by the shell commands and
 * MCP servers it starts. Pointing agy straight at `YEP_AGY_PROXY` would
 * therefore send all tool traffic through the same remote exit.
 *
 * Instead, agy gets a loopback CONNECT proxy as `HTTPS_PROXY`. It forwards
 * Google endpoints (model, auth, quota) through `YEP_AGY_PROXY` and connects
 * everything else directly, so tools keep using this machine's network even
 * though they inherit the variable. A failed upstream is reported as 502 and
 * never retried directly: a model request must not silently change its exit.
 */
import http from "node:http";
import net from "node:net";
import tls from "node:tls";

/** Registrable domains whose traffic belongs to agy's model/auth path. */
export const AGY_UPSTREAM_DOMAINS = [
  "googleapis.com",
  "google.com",
  "gstatic.com",
  "googleusercontent.com",
] as const;

const CONNECT_TIMEOUT_MS = 15_000;
const MAX_UPSTREAM_HEADER_BYTES = 16 * 1024;

export function isAgyUpstreamHost(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  return AGY_UPSTREAM_DOMAINS.some(
    (domain) => name === domain || name.endsWith(`.${domain}`),
  );
}

interface ConnectTarget {
  host: string;
  port: number;
}

/** Parse a CONNECT authority (`host:port`, `[v6]:port`); null if malformed. */
export function parseConnectTarget(authority: string | undefined) {
  if (!authority || /[\s/\\@]/.test(authority)) return null;
  let url: URL;
  try {
    url = new URL(`http://${authority}`);
  } catch {
    return null;
  }
  const port = Number(url.port);
  if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535)
    return null;
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  return { host, port } satisfies ConnectTarget;
}

function upstreamAuthorization(upstream: URL): string | undefined {
  if (!upstream.username && !upstream.password) return undefined;
  const user = decodeURIComponent(upstream.username);
  const pass = decodeURIComponent(upstream.password);
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

/** Open a tunnel to `target` through the upstream HTTP(S) CONNECT proxy. */
function tunnelThroughUpstream(
  upstream: URL,
  authorization: string | undefined,
  target: ConnectTarget,
): Promise<{ socket: net.Socket; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    const port =
      Number(upstream.port) || (upstream.protocol === "https:" ? 443 : 80);
    const host = upstream.hostname.replace(/^\[(.*)\]$/, "$1");
    const socket: net.Socket =
      upstream.protocol === "https:"
        ? tls.connect({
            host,
            port,
            servername: net.isIP(host) ? undefined : host,
          })
        : net.connect({ host, port });
    const authority = net.isIPv6(target.host)
      ? `[${target.host}]:${target.port}`
      : `${target.host}:${target.port}`;
    let buffered = Buffer.alloc(0);
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    const onClose = () => fail(new Error("upstream proxy closed"));
    socket.setTimeout(CONNECT_TIMEOUT_MS, () =>
      fail(new Error("upstream proxy timed out")),
    );
    // Stays attached: errors between the handshake and splice() must not
    // become unhandled; splice() installs the real teardown.
    socket.on("error", fail);
    socket.once("close", onClose);
    socket.once(
      upstream.protocol === "https:" ? "secureConnect" : "connect",
      () => {
        socket.write(
          `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${
            authorization ? `Proxy-Authorization: ${authorization}\r\n` : ""
          }\r\n`,
        );
      },
    );
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buffered.length > MAX_UPSTREAM_HEADER_BYTES)
          fail(new Error("upstream proxy response too large"));
        return;
      }
      socket.off("data", onData);
      // Hold any early tunnel bytes until splice() pipes the socket.
      socket.pause();
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(
        buffered.subarray(0, end).toString("latin1"),
      )?.[1];
      if (status !== "200") {
        fail(new Error(`upstream proxy refused CONNECT (${status ?? "?"})`));
        return;
      }
      settled = true;
      socket.setTimeout(0);
      socket.off("close", onClose);
      resolve({ socket, rest: buffered.subarray(end + 4) });
    };
    socket.on("data", onData);
  });
}

function connectDirect(target: ConnectTarget): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: target.host, port: target.port });
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
      socket.destroy();
      reject(new Error("direct connection timed out"));
    });
    // Settling twice is a no-op, so the listener can stay until splice().
    socket.on("error", reject);
    socket.once("connect", () => {
      socket.setTimeout(0);
      resolve(socket);
    });
  });
}

function splice(client: net.Socket, remote: net.Socket) {
  const close = () => {
    client.destroy();
    remote.destroy();
  };
  client.on("error", close);
  remote.on("error", close);
  client.on("close", close);
  remote.on("close", close);
  client.pipe(remote);
  remote.pipe(client);
}

export interface AgySplitProxy {
  /** `http://127.0.0.1:<port>`, suitable for `HTTPS_PROXY`. */
  url: string;
  close(): Promise<void>;
}

/**
 * Loopback CONNECT proxy: Google endpoints through `upstreamUrl`, the rest
 * direct. Only CONNECT is served; agy and its tools only use it for HTTPS.
 */
export async function startAgySplitProxy(
  upstreamUrl: string,
): Promise<AgySplitProxy> {
  const upstream = new URL(upstreamUrl);
  if (!["http:", "https:"].includes(upstream.protocol)) {
    throw new Error("YEP_AGY_PROXY must be an http:// or https:// proxy URL");
  }
  const authorization = upstreamAuthorization(upstream);
  const sockets = new Set<net.Socket>();
  const server = http.createServer((_req, res) => {
    res.writeHead(405, { connection: "close" }).end();
  });
  server.on("connection", (socket: net.Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("connect", (req, client: net.Socket, head: Buffer) => {
    client.on("error", () => client.destroy());
    const target = parseConnectTarget(req.url);
    if (!target) {
      client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    const viaUpstream = isAgyUpstreamHost(target.host);
    const opened = viaUpstream
      ? tunnelThroughUpstream(upstream, authorization, target)
      : connectDirect(target).then((socket) => ({
          socket,
          rest: Buffer.alloc(0),
        }));
    opened.then(
      ({ socket, rest }) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        if (client.destroyed) {
          socket.destroy();
          return;
        }
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length > 0) client.write(rest);
        if (head.length > 0) socket.write(head);
        splice(client, socket);
      },
      () => {
        // Never fall back to direct for upstream hosts, and never echo the
        // upstream URL (it may carry credentials).
        client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      },
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  // A long-lived helper of this process; it must not keep the process alive.
  server.unref();
  const address = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

let shared: { upstream: string; proxy: Promise<AgySplitProxy> } | undefined;

/**
 * The process-wide split proxy for `upstreamUrl`, started on first use.
 * A changed upstream starts a new proxy; sessions already running keep theirs.
 */
export function ensureAgySplitProxy(upstreamUrl: string): Promise<string> {
  if (!shared || shared.upstream !== upstreamUrl) {
    const proxy = startAgySplitProxy(upstreamUrl);
    shared = { upstream: upstreamUrl, proxy };
    proxy.catch(() => {
      if (shared?.proxy === proxy) shared = undefined;
    });
  }
  return shared.proxy.then((proxy) => proxy.url);
}
