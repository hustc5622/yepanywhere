import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { CodexBridgeService } from "../../src/codex-bridge/CodexBridgeService.js";
import { readCodexAuthIdentity } from "../../src/codex-bridge/auth-identity.js";

describe.each(["lifecycle", "legacy-blocking"] as const)(
  "Codex bridge account changes (%s)",
  (journalMode) => {
    let home: string;
    let bridge: CodexBridgeService;
    let url: string;
    const clients: WebSocket[] = [];
    let nextId = 1;

    beforeEach(async () => {
      home = await mkdtemp(join(process.cwd(), ".tmp-codex-auth-"));
      const cli = join(home, "codex.mjs");
      await writeFile(cli, FAKE_CODEX, { mode: 0o755 });
      await login("account-a");
      const port = await availablePort();
      bridge = new CodexBridgeService({
        journalMode,
        enabled: true,
        host: "127.0.0.1",
        port,
        codexPath: cli,
        codexHome: home,
        startupTimeoutMs: 5000,
      });
      await bridge.start();
      url = `ws://127.0.0.1:${port}`;
    });
    afterEach(async () => {
      for (const client of clients.splice(0)) client.close();
      await bridge?.shutdown();
      await rm(home, { recursive: true, force: true });
    });

    async function login(
      account: string,
      token = "token-1",
      subject = "person-1",
    ) {
      const payload = Buffer.from(JSON.stringify({ sub: subject })).toString(
        "base64url",
      );
      await writeFile(
        join(home, "auth.json"),
        JSON.stringify({
          tokens: {
            account_id: account,
            access_token: token,
            refresh_token: token,
            id_token: `header.${payload}.signature`,
          },
        }),
      );
    }
    async function connect() {
      const client = new WebSocket(url);
      clients.push(client);
      await new Promise<void>((resolve, reject) => {
        client.once("open", resolve);
        client.once("error", reject);
      });
      await rpc(client, "initialize", {
        clientInfo: { name: "auth-test", version: "1" },
      });
      client.send(JSON.stringify({ method: "initialized" }));
      return client;
    }
    function rpc(
      client: WebSocket,
      method: string,
      params: unknown = {},
    ): Promise<{
      result: Record<string, unknown>;
      error?: { message: string };
    }> {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          client.off("message", onMessage);
          reject(new Error(`Timeout: ${method}`));
        }, 8000);
        const onMessage = (data: WebSocket.RawData) => {
          const message = JSON.parse(data.toString());
          if (message.id !== id) return;
          clearTimeout(timer);
          client.off("message", onMessage);
          resolve(message);
        };
        client.on("message", onMessage);
        client.send(JSON.stringify({ id, method, params }));
      });
    }
    async function log() {
      return (await readFile(join(home, "requests.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    }
    async function start(client: WebSocket, threadId = "original") {
      return rpc(client, "thread/start", {
        fakeThreadId: threadId,
        cwd: home,
        config: { preserved: "yes" },
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      });
    }

    it("resumes an open session with the new account before submitting exactly one turn", async () => {
      const client = await connect();
      await start(client);
      const before = await rpc(client, "turn/start", { threadId: "original" });
      await login("account-b");
      const after = await rpc(client, "turn/start", { threadId: "original" });
      expect(before).toMatchObject({ result: { account: "account-a" } });
      expect(after.result.account).toBe("account-b");
      expect(after.result.threadId).toBe("original");
      const requests = await log();
      expect(requests.filter((r) => r.method === "turn/start")).toHaveLength(2);
      const resumed = requests.find(
        (r) => r.account === "account-b" && r.method === "thread/resume",
      );
      expect(resumed.params).toMatchObject({
        threadId: "original",
        config: { preserved: "yes" },
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      });
      expect(resumed.params).not.toHaveProperty("fakeThreadId");
      expect(client.readyState).toBe(WebSocket.OPEN);
    });

    it("reuses one new process for concurrent connections after switching accounts", async () => {
      const old = await connect();
      await start(old);
      await login("account-b");
      const newer = await Promise.all([connect(), connect(), connect()]);
      const results = await Promise.all(
        newer.map((client) =>
          rpc(client, "thread/resume", { threadId: "original", cwd: home }),
        ),
      );
      expect(results.map((r) => r.result.account)).toEqual([
        "account-b",
        "account-b",
        "account-b",
      ]);
      expect(new Set(results.map((r) => r.result.pid)).size).toBe(1);
    });

    it("does not replace processes during same-account token refresh or partial auth writes", async () => {
      const client = await connect();
      await start(client);
      const before = await rpc(client, "turn/start", { threadId: "original" });
      await login("account-a", "refreshed-token");
      const refreshed = await rpc(client, "turn/start", {
        threadId: "original",
      });
      await writeFile(join(home, "auth.json"), "{");
      const partial = await rpc(client, "turn/start", { threadId: "original" });
      expect(refreshed.result.pid).toBe(before.result.pid);
      expect(partial.result.pid).toBe(before.result.pid);
    });

    it("waits for an unsubscribed thread's writer to exit before a new client resumes it", async () => {
      const old = await connect();
      const before = await start(old);
      await rpc(old, "thread/unsubscribe", { threadId: "original" });
      await login("account-b");
      const fresh = await connect();
      const resumed = await rpc(fresh, "thread/resume", {
        threadId: "original",
      });
      expect(resumed.error).toBeUndefined();
      expect(resumed.result.account).toBe("account-b");
      expect(resumed.result.pid).not.toBe(before.result.pid);
      expect(old.readyState).toBe(WebSocket.OPEN);
      // Even non-lifecycle requests on idle peers must reconnect after exit.
      const metadata = await rpc(old, "config/read");
      expect(metadata.result.pid).toBe(resumed.result.pid);
    });

    it("preserves unrelated active work in the old writer and lets rejected requests retry", async () => {
      const idle = await connect();
      await start(idle);
      const active = await connect();
      await start(active, "busy");
      const held = await rpc(active, "turn/start", {
        threadId: "busy",
        hold: true,
      });
      await login("account-b");
      const rejected = await rpc(idle, "turn/start", { threadId: "original" });
      expect(rejected.error?.message).toContain("Wait for active work");
      const fresh = await connect();
      const blocked = await rpc(fresh, "thread/resume", {
        threadId: "original",
      });
      expect(blocked.error?.message).toContain("Wait for active work");
      const finished = await rpc(active, "test/finish", { threadId: "busy" });
      expect(finished.result.pid).toBe(held.result.pid);
      const resumed = await rpc(fresh, "thread/resume", {
        threadId: "original",
      });
      expect(resumed.error).toBeUndefined();
      expect(resumed.result.account).toBe("account-b");
      const retried = await rpc(idle, "turn/start", { threadId: "original" });
      expect(retried.result.pid).toBe(resumed.result.pid);
      const restoredPeer = await rpc(active, "config/read");
      expect(restoredPeer.result.pid).toBe(resumed.result.pid);
      expect(
        (await log()).filter(
          (r) => r.method === "turn/start" && r.params.threadId === "original",
        ),
      ).toHaveLength(1);
    });

    it("distinguishes people sharing a ChatGPT workspace without retaining token values", async () => {
      const before = await readCodexAuthIdentity(home);
      await login("account-a", "token-1", "person-2");
      const after = await readCodexAuthIdentity(home);
      expect(after).not.toBe(before);
      expect(after).toMatch(/^[a-f0-9]{64}$/);
    });

    it("leaves active work running and refuses to resume that thread under another account", async () => {
      const active = await connect();
      await start(active);
      const held = await rpc(active, "turn/start", {
        threadId: "original",
        hold: true,
      });
      await login("account-b");
      const another = await connect();
      const blocked = await rpc(another, "thread/resume", {
        threadId: "original",
        cwd: home,
      });
      expect(blocked.error.message).toContain("Wait for active work");
      const independent = await rpc(another, "thread/start", {
        fakeThreadId: "independent",
        cwd: home,
      });
      expect(independent.result.account).toBe("account-b");
      const finished = await rpc(active, "test/finish", {
        threadId: "original",
      });
      expect(finished.result.pid).toBe(held.result.pid);
      const resumed = await rpc(active, "turn/start", { threadId: "original" });
      expect(resumed.result.account).toBe("account-b");
      expect(
        (await log()).filter(
          (r) => r.method === "turn/start" && r.params.threadId === "original",
        ),
      ).toHaveLength(2);
    });

    it("invalidates cached auth on the native account-mismatch error even without a file identity change", async () => {
      const client = await connect();
      await start(client);
      const before = await rpc(client, "test/auth-error", {
        threadId: "original",
      });
      const after = await rpc(client, "turn/start", { threadId: "original" });
      expect(after.result.pid).not.toBe(before.result.pid);
      expect(
        (await log()).filter((r) => r.method === "turn/start"),
      ).toHaveLength(1);
    });
    it("does not mistake an old idle subscriber for work running in the new account", async () => {
      const old = await connect();
      await start(old);
      await login("account-b");
      const active = await connect();
      await rpc(active, "thread/resume", { threadId: "original", cwd: home });
      await rpc(active, "turn/start", { threadId: "original", hold: true });
      const joining = await connect();
      const response = await rpc(joining, "thread/resume", {
        threadId: "original",
        cwd: home,
      });
      expect(response).toMatchObject({ result: { account: "account-b" } });
      await rpc(active, "test/finish", { threadId: "original" });
    });

    it("does not load threads that were only read for metadata during recovery", async () => {
      const client = await connect();
      await start(client);
      await writeFile(
        join(home, "history-only.json"),
        JSON.stringify({ id: "history-only", cwd: home }),
      );
      await rpc(client, "thread/read", { threadId: "history-only" });
      await login("account-b");
      const result = await rpc(client, "turn/start", { threadId: "original" });
      expect(result).toMatchObject({ result: { account: "account-b" } });
      const resumed = (await log()).filter(
        (r) => r.account === "account-b" && r.method === "thread/resume",
      );
      expect(resumed.map((r) => r.params.threadId)).toEqual(["original"]);
    });

    it("does not reconstruct an ephemeral thread from missing disk history", async () => {
      const client = await connect();
      await rpc(client, "thread/start", {
        fakeThreadId: "temporary",
        ephemeral: true,
        cwd: home,
      });
      await login("account-b");
      const blocked = await rpc(client, "turn/start", {
        threadId: "temporary",
      });
      expect(blocked.error?.message).toContain(
        "temporary thread cannot be resumed",
      );
      expect(
        (await log()).filter((r) => r.method === "turn/start"),
      ).toHaveLength(0);
    });
  },
);

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

const FAKE_CODEX = `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { WebSocketServer } from "ws";
const home = process.env.CODEX_HOME;
const account = JSON.parse(readFileSync(join(home, "auth.json"))).tokens.account_id;
const url = new URL(process.argv.at(-1));
const server = new WebSocketServer({ port: Number(url.port), host: url.hostname });
let turnNumber = 0;
const activeTurns = new Map();
// Match Codex's process-owned writer: unsubscribe/socket close do not release
// it immediately. Keep a PID marker after exit so readers must verify liveness.
function acquireWriter(id) {
  const path = join(home, id + ".writer");
  if (existsSync(path)) {
    const owner = Number(readFileSync(path, "utf8"));
    if (owner !== process.pid) {
      try { process.kill(owner, 0); return "thread " + id + " already has an active writer"; }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  }
  writeFileSync(path, String(process.pid));
}
// Make ordering observable: sending SIGTERM alone does not release the lock.
process.on("SIGTERM", () => setTimeout(() => process.exit(0), 150));
server.on("connection", (ws) => {
  let initialized = false;
  const threads = new Set();
  ws.on("message", (data) => {
    const envelope = JSON.parse(data.toString());
    for (const m of Array.isArray(envelope) ? envelope : [envelope]) {
      appendFileSync(join(home, "requests.jsonl"), JSON.stringify({ account, pid: process.pid, method: m.method, params: m.params }) + "\\n");
      const send = (value) => ws.send(JSON.stringify(value));
      const notify = (method, params) => send({ method, params });
      const done = () => notify("turn/completed", { threadId: m.params.threadId, turn: { id: activeTurns.get(m.params.threadId), status: "completed" } });
      if (m.method === "initialized") { initialized = true; continue; }
      let result = { account, pid: process.pid };
      let error;
      if (m.method !== "initialize" && !initialized) error = "Not initialized";
      else if (m.method === "config/read") result.config = { mcp_servers: {} };
      else if (["thread/start", "thread/resume", "thread/read"].includes(m.method)) {
        const id = m.params.threadId ?? m.params.fakeThreadId;
        const path = join(home, id + ".json");
        if (m.method === "thread/start") writeFileSync(path, JSON.stringify({ id, cwd: home, ephemeral: m.params.ephemeral === true }));
        if (!existsSync(path)) error = "Thread missing";
        else {
          if (m.method !== "thread/read") error = acquireWriter(id);
          if (!error) { result.thread = JSON.parse(readFileSync(path)); if (m.method !== "thread/read") threads.add(id); }
        }
      } else if (m.method === "thread/unsubscribe") { threads.delete(m.params.threadId); result.status = "unsubscribed"; }
      else if (m.method === "turn/start") {
        if (!threads.has(m.params.threadId)) error = "Thread not loaded";
        else {
          result.threadId = m.params.threadId;
          result.turn = { id: "turn-" + (++turnNumber), status: "inProgress" };
          activeTurns.set(m.params.threadId, result.turn.id);
          notify("turn/started", { threadId: m.params.threadId, turn: result.turn });
          if (!m.params.hold) done();
        }
      } else if (m.method === "test/finish") done();
      else if (m.method === "test/auth-error") notify("error", { threadId: m.params.threadId, error: { message: "Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again." }, willRetry: false });
      send(error ? { id: m.id, error: { code: -32000, message: error } } : { id: m.id, result });
    }
  });
});
`;
