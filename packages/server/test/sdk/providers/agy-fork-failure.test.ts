import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgyProvider } from "../../../src/sdk/providers/agy.js";
import type { SDKMessage } from "../../../src/sdk/types.js";

const SOURCE = "a0476472-2b9a-4ba8-807f-fa5b2b5adfac";
const FORK = "22711671-a480-44c1-b939-3b242a355855";

/**
 * `agy acp` whose fork process (`--log-file`) forks fine, while the
 * conversation process then fails to attach the fork: the situation that
 * used to leave an orphan copy behind.
 */
const FAKE_AGY = `#!/usr/bin/env node
const http = require("node:http");
const fs = require("node:fs");
const args = process.argv.slice(2);
const logIndex = args.indexOf("--log-file");
const forkProcess = logIndex >= 0;
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\\n");
function boot() {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ newCascadeId: "${FORK}" })));
  });
  server.listen(0, "127.0.0.1", () => {
    fs.appendFileSync(args[logIndex + 1], "Language server listening on random port at " + server.address().port + " for HTTP\\n");
  });
}
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    if (msg.method === "initialize") send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    else if (forkProcess && msg.method === "session/list") { boot(); send({ id: msg.id, result: { sessions: [] } }); }
    else send({ id: msg.id, error: { code: -32603, message: "attach failed: upstream EOF" } });
  }
});
`;

describe("agy edit fork failure", () => {
  let dir: string;
  let agyPath: string;

  beforeEach(async () => {
    vi.stubEnv("YEP_AGY_PROXY", "");
    dir = await mkdtemp(join(tmpdir(), "agy-fork-fail-"));
    agyPath = join(dir, "agy");
    await writeFile(agyPath, FAKE_AGY);
    await chmod(agyPath, 0o755);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  it("announces a created fork before reporting a later failure", async () => {
    const provider = new AgyProvider({ agyPath });
    const session = await provider.startSession({
      cwd: dir,
      resumeSessionId: SOURCE,
      resumeSessionAt: `agy-${SOURCE}-step-8`,
      permissionMode: "default",
    });
    const messages: SDKMessage[] = [];
    for await (const message of session.iterator) messages.push(message);

    expect(messages.map((message) => message.type)).toEqual([
      "system",
      "error",
    ]);
    // The fork id, so Yep records its edit-fork lineage instead of listing
    // the copy as a separate, unowned session.
    expect(messages[0]).toMatchObject({ subtype: "init", session_id: FORK });
    expect(messages[1]).toMatchObject({
      error: expect.stringMatching(/attach failed/),
    });
  });
});
