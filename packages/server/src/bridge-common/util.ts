import type { ChildProcess } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:net";

/** Narrow an unknown value to a plain object record. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

/** Bridges only accept control connections from the local machine. */
export function isLocalAddress(address: string): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1" ||
    address === "localhost"
  );
}

export function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function isPortAvailable(
  host: string,
  port: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

/**
 * Linear scan for a free local port starting at `startPort`.
 * `reservedPorts` lets concurrent starters claim ports before binding.
 */
export async function findAvailablePort(
  startPort: number,
  options: { host?: string; reservedPorts?: Set<number> } = {},
): Promise<number> {
  const host = options.host ?? "127.0.0.1";
  const reserved = options.reservedPorts;
  for (let port = Math.max(1, startPort); port < startPort + 100; port++) {
    if (reserved) {
      if (reserved.has(port)) continue;
      reserved.add(port);
    }
    if (await isPortAvailable(host, port)) {
      return port;
    }
    reserved?.delete(port);
  }
  throw new Error(`No available port found near ${startPort}`);
}

/**
 * Stop a managed child process (group): SIGTERM, then SIGKILL after a grace
 * period. On POSIX the negative pid targets the process group, matching how
 * bridges spawn their upstreams (detached).
 */
export async function terminateProcessGroup(
  child: ChildProcess,
  graceMs = 1500,
): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.killed) {
    return;
  }

  const pid = process.platform !== "win32" ? -child.pid : child.pid;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
      resolve();
    }, graceMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** A managed child counts as running until it exits or is killed. */
export function isChildRunning(child: ChildProcess | null): boolean {
  return !!child && !child.killed && child.exitCode === null;
}
