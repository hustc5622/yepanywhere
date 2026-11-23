import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  forkAgyConversation,
  parseAgyLanguageServerHttpPort,
  planAgyEditFork,
} from "../../../src/sdk/providers/agy-fork.js";

const SOURCE = "a0476472-2b9a-4ba8-807f-fa5b2b5adfac";

/**
 * Mirrors `agy acp` 1.5.14: the language server boots on the first session
 * request, logs its ports to `--log-file`, and serves Connect JSON behind
 * the `ANTIGRAVITY_SERVER_CSRF_TOKEN` token.
 */
const FAKE_AGY = `#!/usr/bin/env node
const http = require("node:http");
const fs = require("node:fs");
const args = process.argv.slice(2);
const logFile = args[args.indexOf("--log-file") + 1];
const token = process.env.ANTIGRAVITY_SERVER_CSRF_TOKEN;
const mode = process.env.FAKE_AGY_MODE || "ok";
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\\n");
let booted = false;
function boot() {
  if (booted) return;
  booted = true;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (process.env.FAKE_AGY_REQUESTS) fs.appendFileSync(process.env.FAKE_AGY_REQUESTS, JSON.stringify({ url: req.url, csrf: req.headers["x-antigravity-csrf-token"], body: JSON.parse(body) }) + "\\n");
      if (req.headers["x-antigravity-csrf-token"] !== token) {
        res.writeHead(401).end(JSON.stringify({ code: "unauthenticated", message: "unauthenticated: invalid CSRF token" }));
        return;
      }
      if (mode === "user-step") {
        res.writeHead(500).end(JSON.stringify({ code: "internal", message: "internal: cannot fork at step 2: that step is a user message" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ newCascadeId: "22711671-a480-44c1-b939-3b242a355855", forkedAtStepIndex: JSON.parse(body).forkAtStepIndex }));
    });
  });
  server.listen(0, "127.0.0.1", () => {
    fs.appendFileSync(logFile, "I1122 server.go:1305] Language server listening on random port at 1 for HTTPS (gRPC)\\n");
    fs.appendFileSync(logFile, "I1122 server.go:1313] Language server listening on random port at " + server.address().port + " for HTTP\\n");
  });
}
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    const msg = JSON.parse(line);
    if (msg.method === "initialize") send({ id: msg.id, result: { protocolVersion: 1 } });
    else if (msg.method === "session/list") {
      if (mode === "signed-out") send({ id: msg.id, error: { code: -32000, message: "Authentication required" } });
      else if (mode === "boot-then-signed-out") {
        // Real agy boots the language server first, then fails the token refresh.
        boot();
        setTimeout(() => send({ id: msg.id, error: { code: -32000, message: "Authentication required" } }), 300);
      }
      else { boot(); send({ id: msg.id, result: { sessions: [] } }); }
    }
  }
});
`;

describe("agy edit-fork plan", () => {
  it("forks before the edited prompt", () => {
    expect(planAgyEditFork(SOURCE, `agy-${SOURCE}-step-8`)).toEqual({
      kind: "fork",
      sourceSessionId: SOURCE,
      forkAtStepIndex: 7,
    });
    expect(planAgyEditFork(SOURCE, "agy-step-2")).toMatchObject({
      forkAtStepIndex: 1,
    });
  });

  it("starts fresh when the first prompt is edited", () => {
    expect(planAgyEditFork(SOURCE, `agy-${SOURCE}-step-0`)).toEqual({
      kind: "fresh",
      sourceSessionId: SOURCE,
    });
  });

  it("rejects boundaries that are not this conversation's steps", () => {
    expect(() => planAgyEditFork(SOURCE, "yep-live-uuid")).toThrow(
      /not a persisted agy message/,
    );
    expect(() =>
      planAgyEditFork(
        SOURCE,
        "agy-22711671-a480-44c1-b939-3b242a355855-step-3",
      ),
    ).toThrow(/different conversation/);
  });

  it("reads the HTTP port, not the gRPC one", () => {
    expect(
      parseAgyLanguageServerHttpPort(
        [
          "I1122 server.go:1305] Language server listening on random port at 52805 for HTTPS (gRPC)",
          "I1122 server.go:1313] Language server listening on random port at 52806 for HTTP",
        ].join("\n"),
      ),
    ).toBe(52806);
    expect(parseAgyLanguageServerHttpPort("booting")).toBeNull();
  });
});

describe("forkAgyConversation", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function fakeAgy(): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), "agy-fork-"));
    const agyPath = join(dir, "agy");
    await writeFile(agyPath, FAKE_AGY);
    await chmod(agyPath, 0o755);
    return agyPath;
  }

  it("forks through the language server with the CSRF token", async () => {
    const agyPath = await fakeAgy();
    const requestsLog = join(dir as string, "requests.jsonl");
    const forked = await forkAgyConversation({
      agyPath,
      cwd: dir as string,
      env: { FAKE_AGY_MODE: "ok", FAKE_AGY_REQUESTS: requestsLog },
      sourceSessionId: SOURCE,
      forkAtStepIndex: 7,
      timeoutMs: 10_000,
    });
    expect(forked).toBe("22711671-a480-44c1-b939-3b242a355855");
    const requests = (await readFile(requestsLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: "/exa.language_server_pb.LanguageServerService/ForkConversation",
      body: {
        sourceCascadeId: SOURCE,
        forkAtStepIndex: 7,
        targetForkWorkspace: "FORK_TARGET_CURRENT_WORKSPACE",
      },
    });
    expect(requests[0].csrf).toMatch(/^[0-9a-f]{48}$/);
  });

  it("reports agy's refusal", async () => {
    const agyPath = await fakeAgy();
    await expect(
      forkAgyConversation({
        agyPath,
        cwd: dir as string,
        env: { FAKE_AGY_MODE: "user-step" },
        sourceSessionId: SOURCE,
        forkAtStepIndex: 2,
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow(/could not fork the conversation: .*user message/);
  });

  it("surfaces a signed-out CLI as an auth error", async () => {
    const agyPath = await fakeAgy();
    await expect(
      forkAgyConversation({
        agyPath,
        cwd: dir as string,
        env: { FAKE_AGY_MODE: "signed-out" },
        sourceSessionId: SOURCE,
        forkAtStepIndex: 2,
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow(/Authentication required/);
  });

  it("does not fork when the auth check fails after the server booted", async () => {
    const agyPath = await fakeAgy();
    const requestsLog = join(dir as string, "requests.jsonl");
    await expect(
      forkAgyConversation({
        agyPath,
        cwd: dir as string,
        env: {
          FAKE_AGY_MODE: "boot-then-signed-out",
          FAKE_AGY_REQUESTS: requestsLog,
        },
        sourceSessionId: SOURCE,
        forkAtStepIndex: 2,
        timeoutMs: 10_000,
      }),
    ).rejects.toMatchObject({
      code: -32000,
      message: "Authentication required",
    });
    await expect(readFile(requestsLog, "utf8")).rejects.toThrow(/ENOENT/);
  });
});
