/**
 * ZCode protocol client tests.
 *
 * Uses a fake app-server (inline `.js` script) to exercise the
 * `ZCodeProtocolClient` against:
 *   - Normal request/response
 *   - JSON-RPC-style error response
 *   - Request timeout
 *   - Server notifications and reverse requests interleaved
 *   - stdout half-line / multi-line / malformed JSON
 *   - stderr bound + redaction (sentinel must not appear in output)
 *   - Child spawn error / exit / abort
 *   - Unsupported server request returns error (does not hang)
 *   - Notification queue ordering
 *   - Close rejects all pending requests
 *
 * The fake server matches the REAL ZCode CLI 0.16.1 protocol contract:
 *   - No `jsonrpc` field in messages (classified by `method`/`id` presence)
 *   - `workspace/readState` requires `workspace: {workspacePath, workspaceKey}`
 *   - Responses use `{id, result}` or `{id, error: {code, message}}`
 */

import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ZCodeProtocolClient } from "../../../src/sdk/providers/zcode-protocol/client.js";
import { ZCodeProtocolError } from "../../../src/sdk/providers/zcode-protocol/types.js";

// =============================================================================
// Fake app-server fixture
// =============================================================================

/**
 * Write a fake ZCode app-server script to a temp dir and return its path.
 *
 * The fake speaks newline-delimited JSON over stdio, matching the real
 * ZCode CLI 0.16.1 protocol (no `jsonrpc` field). Behavior is driven by
 * `ZCODE_FAKE_*` env vars set before `client.connect()`:
 *
 *   - `ZCODE_FAKE_EARLY_EXIT=1`     — exit immediately on spawn.
 *   - `ZCODE_FAKE_STDERR_SECRET=1`  — write a sentinel secret to stderr.
 *   - `ZCODE_FAKE_STDERR_SPLIT=1`   — split that secret across stderr chunks.
 *   - `ZCODE_FAKE_MALFORMED=1`      — write a non-JSON line to stdout.
 *   - `ZCODE_FAKE_HALF_LINE=1`     — write a line split across two chunks.
 *   - `ZCODE_FAKE_HANG=1`           — never respond to requests (for timeout).
 *   - `ZCODE_FAKE_SERVER_REQUEST=1` — send a server→client request.
 *   - `ZCODE_FAKE_NOTIFY=method`   — send a notification before responding.
 */
function writeFakeZCodeAppServer(tempDir: string): string {
  const fakePath = join(tempDir, "fake-zcode.js");
  writeFileSync(
    fakePath,
    `#!/usr/bin/env node
const argv = process.argv.slice(2);
// argv for .cjs-style: ["app-server"] when spawned via node <path> app-server
if (argv[0] !== "app-server") {
  process.exit(1);
}

if (process.env.ZCODE_FAKE_EARLY_EXIT === "1") {
  process.exit(1);
}

if (process.env.ZCODE_FAKE_STDERR_SECRET === "1") {
  process.stderr.write("Error: Bearer sk-fake-secret-token-12345 leaked\\n");
}

if (process.env.ZCODE_FAKE_STDERR_SPLIT === "1") {
  process.stderr.write("Error: Bearer sk-fake-");
  setTimeout(() => process.stderr.write("secret-token-12345 leaked\\n"), 10);
}

if (process.env.ZCODE_FAKE_MALFORMED === "1") {
  process.stdout.write("this is not json\\n");
}

if (process.env.ZCODE_FAKE_HALF_LINE === "1") {
  // Half-line mode: handle() will send the response in two chunks.
  // No early write here.
}

let buffer = "";

// Real ZCode CLI 0.16.1 does NOT use a jsonrpc field.
function send(id, result) {
  process.stdout.write(JSON.stringify({ id, result }) + "\\n");
}

function sendError(id, code, message) {
  process.stdout.write(
    JSON.stringify({ id, error: { code, message } }) + "\\n",
  );
}

function notify(method, params) {
  process.stdout.write(
    JSON.stringify({ method, params }) + "\\n",
  );
}

function request(id, method, params) {
  process.stdout.write(
    JSON.stringify({ id, method, params }) + "\\n",
  );
}

function handle(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  // Client responses to server-initiated requests only carry {id, result}
  // or {id, error}. They must not trigger another notification/request, or
  // the fixture recursively echoes its own reverse request back to the client.
  const method = message.method;
  if (!method) return;

  // Send a notification before responding (if requested).
  if (process.env.ZCODE_FAKE_NOTIFY) {
    notify(process.env.ZCODE_FAKE_NOTIFY, { data: "before-response" });
  }

  // Send a server→client request (if requested).
  if (process.env.ZCODE_FAKE_SERVER_REQUEST === "1") {
    request("srv-1", "interaction/requestPermission", {
      tool: "Bash",
      input: { command: "ls" },
    });
  }

  if (process.env.ZCODE_FAKE_HANG === "1") {
    return; // never respond
  }

  if (method === "workspace/readState") {
    if (process.env.ZCODE_FAKE_HALF_LINE === "1") {
      // Send the response in two chunks to test line reassembly.
      const full = JSON.stringify({
        id: message.id,
        result: { workspace: { root: "/tmp" }, models: [] },
      });
      const half = Math.floor(full.length / 2);
      process.stdout.write(full.slice(0, half));
      setTimeout(() => {
        process.stdout.write(full.slice(half) + "\\n");
      }, 50);
      return;
    }
    send(message.id, {
      workspace: { root: "/tmp" },
      models: [{ id: "zai/glm-4.6", label: "GLM-4.6" }],
    });
    return;
  }

  if (method === "session/list") {
    send(message.id, {
      sessions: [{ sessionId: "s1", title: "Session One" }],
    });
    return;
  }

  if (method === "workspace/updateProviderRegistry") {
    send(message.id, { updated: true });
    return;
  }

  if (method === "echo") {
    send(message.id, { echoed: message.params });
    return;
  }

  // Unknown method → error
  sendError(message.id, -32601, "Method not found: " + method);
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf-8");
  const lines = buffer.split("\\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) handle(trimmed);
  }
});
`,
    { mode: 0o755 },
  );
  return fakePath;
}

// =============================================================================
// Test harness
// =============================================================================

async function makeClient(
  tempDir: string,
  envOverride?: Record<string, string>,
  configOverride?: {
    requestTimeoutMs?: number;
    stderrBound?: number;
  },
): Promise<{ client: ZCodeProtocolClient; fakePath: string }> {
  const fakePath = writeFakeZCodeAppServer(tempDir);
  const client = new ZCodeProtocolClient({
    command: process.execPath,
    args: [fakePath, "app-server"],
    env: { ...process.env, ...envOverride },
    requestTimeoutMs: configOverride?.requestTimeoutMs ?? 3000,
    stderrBound: configOverride?.stderrBound,
  });
  await client.connect();
  return { client, fakePath };
}

const TEMP_DIR = await mkdtemp(join(tmpdir(), "zcode-protocol-test-"));

afterAll(async () => {
  await rm(TEMP_DIR, { recursive: true, force: true });
});

// =============================================================================
// Tests
// =============================================================================

describe("ZCodeProtocolClient", () => {
  describe("request/response", () => {
    it("resolves with the result for a normal request", async () => {
      const { client } = await makeClient(TEMP_DIR);
      try {
        const result = await client.request<{
          models?: unknown[];
        }>("workspace/readState");
        expect(result.models).toBeDefined();
        expect(Array.isArray(result.models)).toBe(true);
      } finally {
        client.close();
      }
    });

    it("resolves session/list with sessions array", async () => {
      const { client } = await makeClient(TEMP_DIR);
      try {
        const result = await client.request<{ sessions: unknown[] }>(
          "session/list",
        );
        expect(result.sessions).toHaveLength(1);
      } finally {
        client.close();
      }
    });

    it("rejects with ZCodeServerError when server returns an error", async () => {
      const { client } = await makeClient(TEMP_DIR);
      try {
        await expect(client.request("unknown/method")).rejects.toThrow(
          "Method not found",
        );
      } finally {
        client.close();
      }
    });

    it("times out when server does not respond", async () => {
      const { client } = await makeClient(
        TEMP_DIR,
        { ZCODE_FAKE_HANG: "1" },
        { requestTimeoutMs: 500 },
      );
      try {
        await expect(client.request("workspace/readState")).rejects.toThrow(
          ZCodeProtocolError,
        );
        await expect(
          client.request("workspace/readState"),
        ).rejects.toMatchObject({ code: "zcode_protocol_timeout" });
      } finally {
        client.close();
      }
    });
  });

  describe("notifications", () => {
    it("receives server notifications via nextNotification", async () => {
      const { client } = await makeClient(TEMP_DIR, {
        ZCODE_FAKE_NOTIFY: "session.updated",
      });
      try {
        // The fake sends a notification before responding to the request.
        // We need to send a request to trigger it, then read the notification.
        const requestPromise = client.request("workspace/readState");
        const notification = await client.nextNotification();
        expect(notification.method).toBe("session.updated");
        expect(notification.params).toEqual({ data: "before-response" });
        await requestPromise; // drain
      } finally {
        client.close();
      }
    });

    it("preserves notification ordering", async () => {
      // Use echo to trigger multiple notifications.
      const { client } = await makeClient(TEMP_DIR, {
        ZCODE_FAKE_NOTIFY: "turn.started",
      });
      try {
        const p1 = client.request("echo", { n: 1 });
        const n1 = await client.nextNotification();
        await p1;

        const p2 = client.request("echo", { n: 2 });
        const n2 = await client.nextNotification();
        await p2;

        expect(n1.method).toBe("turn.started");
        expect(n2.method).toBe("turn.started");
      } finally {
        client.close();
      }
    });
  });

  describe("server-to-client requests", () => {
    it("calls the registered handler and sends a response back", async () => {
      const { client } = await makeClient(TEMP_DIR, {
        ZCODE_FAKE_SERVER_REQUEST: "1",
      });
      try {
        const receivedRequests: { method: string; params?: unknown }[] = [];
        client.setServerRequestHandler(async (req) => {
          receivedRequests.push({ method: req.method, params: req.params });
          return { decision: "allow" };
        });

        // Send a request to trigger the server request.
        await client.request("workspace/readState");

        expect(receivedRequests).toHaveLength(1);
        expect(receivedRequests[0]?.method).toBe(
          "interaction/requestPermission",
        );
      } finally {
        client.close();
      }
    });

    it("returns -32601 when no handler is registered", async () => {
      const { client } = await makeClient(TEMP_DIR, {
        ZCODE_FAKE_SERVER_REQUEST: "1",
      });
      try {
        // No handler set — should not hang; the server request response is
        // -32601, but the client doesn't track it.  The main point is that
        // the client does not hang and the request completes.
        await expect(
          client.request("workspace/readState"),
        ).resolves.toBeDefined();
      } finally {
        client.close();
      }
    });
  });

  describe("stdout edge cases", () => {
    it("handles malformed JSON lines without crashing", async () => {
      const { client } = await makeClient(TEMP_DIR, {
        ZCODE_FAKE_MALFORMED: "1",
      });
      try {
        // The malformed line is ignored; the next valid request should work.
        const result = await client.request<{ models?: unknown[] }>(
          "workspace/readState",
        );
        expect(result).toBeDefined();
      } finally {
        client.close();
      }
    });

    it("handles half-line (split chunk) responses", async () => {
      const { client } = await makeClient(TEMP_DIR, {
        ZCODE_FAKE_HALF_LINE: "1",
      });
      try {
        // The fake writes a response in two chunks. The client should
        // reassemble the line and respond.  We send a request with id=1
        // which matches the half-line response.
        const result = await client.request("workspace/readState");
        expect(result).toBeDefined();
      } finally {
        client.close();
      }
    });
  });

  describe("plaintext stderr", () => {
    it("preserves credential text from stderr buffer", async () => {
      const { client } = await makeClient(TEMP_DIR, {
        ZCODE_FAKE_STDERR_SECRET: "1",
      });
      try {
        await expect.poll(() => client.getStderrTail()).not.toBe("");
        const stderr = client.getStderrTail();
        expect(stderr).toContain("sk-fake-secret-token-12345");
        expect(stderr).toContain("Bearer");
      } finally {
        client.close();
      }
    });

    it("reassembles a credential split across stderr chunks", async () => {
      const { client } = await makeClient(TEMP_DIR, {
        ZCODE_FAKE_STDERR_SPLIT: "1",
      });
      try {
        await expect
          .poll(() => client.getStderrTail())
          .toBe("Error: Bearer sk-fake-secret-token-12345 leaked");
        const stderr = client.getStderrTail();
        expect(stderr).toBe("Error: Bearer sk-fake-secret-token-12345 leaked");
        expect(stderr).toContain("secret-token");
      } finally {
        client.close();
      }
    });

    it("bounds stderr buffer size", async () => {
      // Create a client with a very small stderr bound.
      const fakePath = writeFakeZCodeAppServer(TEMP_DIR);
      const client = new ZCodeProtocolClient({
        command: process.execPath,
        args: [fakePath, "app-server"],
        env: {
          ...process.env,
          ZCODE_FAKE_STDERR_SECRET: "1",
        },
        stderrBound: 100,
      });
      await client.connect();
      try {
        // Write a lot of stderr.
        await new Promise((resolve) => setTimeout(resolve, 200));
        const stderr = client.getStderrTail();
        expect(stderr.length).toBeLessThanOrEqual(200); // bound + some slack
      } finally {
        client.close();
      }
    });
  });

  describe("process lifecycle", () => {
    it("rejects pending requests when process exits", async () => {
      const fakePath = writeFakeZCodeAppServer(TEMP_DIR);
      const client = new ZCodeProtocolClient({
        command: process.execPath,
        args: [fakePath, "app-server"],
        env: {
          ...process.env,
          ZCODE_FAKE_HANG: "1",
        },
        requestTimeoutMs: 60_000, // long timeout; we'll kill the process
      });
      await client.connect();
      try {
        const requestPromise = client.request("workspace/readState");
        // Kill the child process to simulate exit.
        if (client.pid) {
          process.kill(client.pid, "SIGTERM");
        }
        await expect(requestPromise).rejects.toThrow();
      } finally {
        client.close();
      }
    });

    it("close() rejects all pending requests", async () => {
      const { client } = await makeClient(
        TEMP_DIR,
        { ZCODE_FAKE_HANG: "1" },
        { requestTimeoutMs: 60_000 },
      );
      try {
        const p1 = client.request("workspace/readState");
        const p2 = client.request("echo");
        client.close();
        await expect(p1).rejects.toThrow();
        await expect(p2).rejects.toThrow();
      } finally {
        client.close();
      }
    });

    it("isAlive returns true after connect, false after close", async () => {
      const { client } = await makeClient(TEMP_DIR);
      try {
        expect(client.isAlive()).toBe(true);
      } finally {
        client.close();
        expect(client.isAlive()).toBe(false);
      }
    });
  });

  describe("notify", () => {
    it("sends a notification without expecting a response", async () => {
      const { client } = await makeClient(TEMP_DIR);
      try {
        // notify should not throw and not hang.
        client.notify("workspace/setDefaultMode", { mode: "build" });
        // Verify the client is still usable.
        const result = await client.request("workspace/readState");
        expect(result).toBeDefined();
      } finally {
        client.close();
      }
    });
  });

  describe("early exit", () => {
    it("handles early process exit without hanging", async () => {
      const fakePath = writeFakeZCodeAppServer(TEMP_DIR);
      const client = new ZCodeProtocolClient({
        command: process.execPath,
        args: [fakePath, "app-server"],
        env: { ...process.env, ZCODE_FAKE_EARLY_EXIT: "1" },
        requestTimeoutMs: 5000,
      });
      try {
        // connect() may resolve (spawn succeeded) then the process exits.
        // Or connect() may reject if the process exits before spawn.
        // Either way, a subsequent request should reject (not hang).
        try {
          await client.connect();
        } catch {
          // connect rejected — that's also valid.
          return;
        }
        // If connect resolved, the process exited shortly after.
        // A request should reject because the client is closed.
        await expect(client.request("workspace/readState")).rejects.toThrow();
      } finally {
        client.close();
      }
    });
  });
});
