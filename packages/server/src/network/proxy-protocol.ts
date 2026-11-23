/**
 * PROXY protocol (v1 text / v2 binary) support for the HTTP(S) listeners.
 *
 * Public traffic reaches Yep through frp TCP tunnels. frpc dials the local
 * listener from 127.0.0.1, so without extra information every phone, browser
 * and attacker shares one client address — and therefore one login rate-limit
 * bucket. With `transport.proxyProtocolVersion = "v2"` on the frpc proxy, frpc
 * prefixes each connection with a PROXY header carrying the real peer address.
 *
 * The header is optional on purpose: the same port also serves local scripts,
 * the browser on this machine and the Feishu runtime, none of which send it.
 * It is honored only when the TCP peer is trusted (loopback by default, which
 * is where frpc connects from); for any other peer the bytes are handed to the
 * HTTP/TLS stack untouched, so a remote client cannot forge its address. A
 * PROXY header can never be confused with HTTP (methods are uppercase words,
 * not "PROXY " or "\r\n\r\n\0") or TLS (records start with 0x16).
 *
 * Spec: https://www.haproxy.org/download/2.9/doc/proxy-protocol.txt
 */

import { type Server, type Socket, isIP } from "node:net";

const V2_SIGNATURE = Buffer.from([
  0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a,
]);
const V2_HEADER_LENGTH = 16;
/** Largest legal v2 payload we accept (addresses plus generous TLV room). */
const V2_MAX_PAYLOAD = 4096;
const V1_PREFIX = Buffer.from("PROXY ", "ascii");
/** Spec: a v1 line is at most 107 bytes including CRLF. */
const V1_MAX_LENGTH = 107;
const DEFAULT_HEADER_TIMEOUT_MS = 5_000;

const PROXY_CLIENT = Symbol.for("yep-anywhere.proxy-protocol.client");

export interface ProxyProtocolAddress {
  /** Real client address reported by the proxy (IPv4 or IPv6 text form). */
  address: string;
  port?: number;
  version: 1 | 2;
}

export type ProxyProtocolParseResult =
  | { kind: "need-more" }
  /** The buffer does not start with a PROXY header. */
  | { kind: "none" }
  | { kind: "invalid"; reason: string }
  /**
   * A complete header of `length` bytes. `client` is null for v2 LOCAL,
   * v1 UNKNOWN and unsupported address families (keep the TCP peer address).
   */
  | { kind: "header"; length: number; client: ProxyProtocolAddress | null };

function startsWithPartial(buffer: Buffer, prefix: Buffer): boolean {
  const length = Math.min(buffer.length, prefix.length);
  return buffer.subarray(0, length).equals(prefix.subarray(0, length));
}

function parseV1(buffer: Buffer): ProxyProtocolParseResult {
  const limit = Math.min(buffer.length, V1_MAX_LENGTH);
  const end = buffer.subarray(0, limit).indexOf("\r\n", 0, "ascii");
  if (end === -1) {
    return buffer.length >= V1_MAX_LENGTH
      ? { kind: "invalid", reason: "v1 header exceeds 107 bytes" }
      : { kind: "need-more" };
  }
  const length = end + 2;
  const parts = buffer.subarray(0, end).toString("ascii").split(" ");
  const protocol = parts[1];
  if (protocol === "UNKNOWN") return { kind: "header", length, client: null };
  if ((protocol !== "TCP4" && protocol !== "TCP6") || parts.length !== 6) {
    return { kind: "invalid", reason: "malformed v1 header" };
  }
  const [, , source, , sourcePort] = parts;
  const family = isIP(source ?? "");
  if (family !== (protocol === "TCP4" ? 4 : 6)) {
    return { kind: "invalid", reason: "v1 source address mismatch" };
  }
  const port = Number(sourcePort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return { kind: "invalid", reason: "v1 source port out of range" };
  }
  return {
    kind: "header",
    length,
    client: { address: source as string, port, version: 1 },
  };
}

function formatIpv6(bytes: Buffer): string {
  const groups: string[] = [];
  for (let index = 0; index < 16; index += 2) {
    groups.push(bytes.readUInt16BE(index).toString(16));
  }
  // Normalise through URL so the result matches Node's compressed notation.
  return new URL(`http://[${groups.join(":")}]`).hostname.slice(1, -1);
}

function parseV2(buffer: Buffer): ProxyProtocolParseResult {
  if (buffer.length < V2_HEADER_LENGTH) return { kind: "need-more" };
  const versionCommand = buffer[12] as number;
  if (versionCommand >> 4 !== 2) {
    return { kind: "invalid", reason: "unsupported v2 version" };
  }
  const command = versionCommand & 0x0f;
  const payloadLength = buffer.readUInt16BE(14);
  if (payloadLength > V2_MAX_PAYLOAD) {
    return { kind: "invalid", reason: "v2 payload too large" };
  }
  const length = V2_HEADER_LENGTH + payloadLength;
  if (buffer.length < length) return { kind: "need-more" };
  if (command === 0x0) return { kind: "header", length, client: null };
  if (command !== 0x1) {
    return { kind: "invalid", reason: "unsupported v2 command" };
  }

  const family = (buffer[13] as number) >> 4;
  const payload = buffer.subarray(V2_HEADER_LENGTH, length);
  if (family === 0x1) {
    if (payload.length < 12) {
      return { kind: "invalid", reason: "short v2 IPv4 block" };
    }
    const address = Array.from(payload.subarray(0, 4)).join(".");
    return {
      kind: "header",
      length,
      client: { address, port: payload.readUInt16BE(8), version: 2 },
    };
  }
  if (family === 0x2) {
    if (payload.length < 36) {
      return { kind: "invalid", reason: "short v2 IPv6 block" };
    }
    return {
      kind: "header",
      length,
      client: {
        address: formatIpv6(payload.subarray(0, 16)),
        port: payload.readUInt16BE(32),
        version: 2,
      },
    };
  }
  // AF_UNSPEC / AF_UNIX: nothing usable, keep the TCP peer address.
  return { kind: "header", length, client: null };
}

/** Parse a PROXY header at the start of `buffer` (possibly incomplete). */
export function parseProxyProtocolHeader(
  buffer: Buffer,
): ProxyProtocolParseResult {
  if (buffer.length === 0) return { kind: "need-more" };
  if (buffer[0] === V1_PREFIX[0]) {
    if (!startsWithPartial(buffer, V1_PREFIX)) return { kind: "none" };
    if (buffer.length < V1_PREFIX.length) return { kind: "need-more" };
    return parseV1(buffer);
  }
  if (buffer[0] === V2_SIGNATURE[0]) {
    if (!startsWithPartial(buffer, V2_SIGNATURE)) return { kind: "none" };
    if (buffer.length < V2_SIGNATURE.length) return { kind: "need-more" };
    return parseV2(buffer);
  }
  return { kind: "none" };
}

/** Loopback peers: where a local frpc / reverse proxy connects from. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.startsWith("::ffff:") ? address.slice(7) : address;
  return normalized === "::1" || /^127\.\d+\.\d+\.\d+$/.test(normalized);
}

type SocketWithProxyClient = Socket & {
  [PROXY_CLIENT]?: ProxyProtocolAddress;
  /** TLSSocket keeps the raw TCP socket it wraps here. */
  _parent?: SocketWithProxyClient;
};

/**
 * Real client address announced by a trusted PROXY header for this socket (or
 * the raw socket underneath a TLS socket). Undefined when none was sent.
 */
export function getProxyProtocolClient(
  socket: Socket | undefined | null,
): ProxyProtocolAddress | undefined {
  const value = socket as SocketWithProxyClient | undefined | null;
  return value?.[PROXY_CLIENT] ?? value?._parent?.[PROXY_CLIENT];
}

export interface ProxyProtocolOptions {
  /** Peers whose PROXY header is trusted. Default: loopback only. */
  isTrustedPeer?: (address: string | undefined) => boolean;
  /**
   * Give up waiting for the first bytes after this long and hand the socket
   * over as-is (idle pre-connected browser sockets). Default 5s; frpc sends
   * its header immediately.
   */
  headerTimeoutMs?: number;
  /** Called for rejected (malformed) headers. */
  onInvalid?: (reason: string, peer: string | undefined) => void;
}

const INSTALLED = Symbol.for("yep-anywhere.proxy-protocol.installed");

/**
 * Accept an optional PROXY header on every connection of `server` (HTTP or
 * HTTPS) before Node's HTTP/TLS stack sees the socket.
 */
export function installProxyProtocol(
  server: Server,
  options: ProxyProtocolOptions = {},
): void {
  const marked = server as Server & { [INSTALLED]?: boolean };
  if (marked[INSTALLED]) return;
  marked[INSTALLED] = true;

  const isTrustedPeer = options.isTrustedPeer ?? isLoopbackAddress;
  const headerTimeoutMs = options.headerTimeoutMs ?? DEFAULT_HEADER_TIMEOUT_MS;
  const downstream = server.listeners("connection") as Array<
    (socket: Socket) => void
  >;
  server.removeAllListeners("connection");

  const dispatch = (socket: Socket) => {
    for (const listener of downstream) listener.call(server, socket);
  };

  server.on("connection", (socket: Socket) => {
    if (!isTrustedPeer(socket.remoteAddress)) {
      dispatch(socket);
      return;
    }

    let buffered: Buffer = Buffer.alloc(0);
    let settled = false;

    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onEarlyError);
      socket.off("close", onEarlyClose);
    };

    const handOver = (rest: Buffer) => {
      cleanup();
      // Hold buffered bytes until the next owner is attached: a flowing
      // stream with no `data` listener would drop them.
      socket.pause();
      if (rest.length > 0) {
        // Node's HTTP server normally reads the TCP handle natively
        // (`parser.consume`), which would skip bytes already pulled into the
        // JS stream. Mark the handle as consumed so the parser reads through
        // the stream instead, starting with the unshifted bytes. TLS servers
        // drain the stream buffer into the TLS layer themselves.
        const handle = (
          socket as Socket & { _handle?: { _consumed?: boolean } }
        )._handle;
        if (handle) handle._consumed = true;
        socket.unshift(rest);
      }
      dispatch(socket);
      // HTTP reads through `data` events; TLS pulls the buffer with read()
      // when it initialises and must not see a flowing raw socket.
      if (socket.listenerCount("data") > 0) socket.resume();
    };

    const onData = (chunk: Buffer) => {
      if (settled) return;
      buffered =
        buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
      const result = parseProxyProtocolHeader(buffered);
      if (result.kind === "need-more") return;
      if (result.kind === "invalid") {
        cleanup();
        options.onInvalid?.(result.reason, socket.remoteAddress);
        socket.destroy();
        return;
      }
      if (result.kind === "header") {
        if (result.client) {
          (socket as SocketWithProxyClient)[PROXY_CLIENT] = result.client;
        }
        handOver(buffered.subarray(result.length));
        return;
      }
      handOver(buffered);
    };

    // Until the HTTP/TLS stack owns the socket, an error with no listener
    // would crash the process.
    const onEarlyError = () => {
      cleanup();
      socket.destroy();
    };
    const onEarlyClose = () => cleanup();

    const timer = setTimeout(() => {
      if (!settled) handOver(buffered);
    }, headerTimeoutMs);
    timer.unref?.();

    socket.on("data", onData);
    socket.on("error", onEarlyError);
    socket.on("close", onEarlyClose);
  });
}
