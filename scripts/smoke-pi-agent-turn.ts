// Offline check of Pi agent-initiated turns against the real `pi` binary.
// A local fake Anthropic gateway answers every model request with "ok", and a
// wrapper extension (Yep's extension + a test hook) wakes the agent once with
// `pi.sendMessage(..., { triggerTurn: true })` after the first run settles,
// the way pi-subagents delivers an async result. No real model request is
// made. Run: npx tsx scripts/smoke-pi-agent-turn.ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = mkdtempSync(join(tmpdir(), "pi-agent-turn-"));
const cwd = join(root, "project");
mkdirSync(cwd, { recursive: true });

let requests = 0;
const server = createServer((req, res) => {
  if (req.method === "GET" && req.url?.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        success: true,
        data: [
          {
            id: "fake-model",
            name: "Fake Model",
            context_window: 200_000,
            supported_endpoint_types: ["anthropic/messages"],
          },
        ],
      }),
    );
    return;
  }
  if (req.method === "POST" && req.url?.includes("/messages")) {
    requests += 1;
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const event = (type: string, data: unknown) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      event("message_start", {
        type: "message_start",
        message: {
          id: `msg_${requests}`,
          type: "message",
          role: "assistant",
          model: "fake-model",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      });
      event("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      event("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: `reply ${requests}` },
      });
      event("content_block_stop", { type: "content_block_stop", index: 0 });
      event("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 3 },
      });
      event("message_stop", { type: "message_stop" });
      res.end();
    });
    return;
  }
  res.writeHead(404).end();
});
await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
const port = (server.address() as { port: number }).port;

const yepExtension = resolve("packages/server/resources/pi-yep-extension.mjs");
const wrapper = join(root, "wrapper-extension.mjs");
writeFileSync(
  wrapper,
  `import yep from ${JSON.stringify(yepExtension)};
let woke = false;
export default function (pi) {
  yep(pi);
  pi.on("agent_settled", () => {
    if (woke) return;
    woke = true;
    setTimeout(() => {
      pi.sendMessage(
        { customType: "smoke-wake", content: "background job finished", display: true },
        { triggerTurn: true },
      );
    }, 500);
  });
}
`,
);

process.env.YEP_LLM_GATEWAY_API_KEY = "offline-smoke";
process.env.YEP_LLM_GATEWAY_API_BASE = `http://127.0.0.1:${port}/v1`;
process.env.YEP_LLM_GATEWAYS = "";
process.env.YEP_PI_NATIVE_CONFIG = "false";
process.env.YEP_ANYWHERE_DATA_DIR = join(root, "data");

const { PiProvider } = await import(
  "../packages/server/src/sdk/providers/pi.js"
);
const provider = new PiProvider({
  sessionsDir: join(root, "sessions"),
  agentDir: join(root, "agent"),
  extensionPath: wrapper,
  timeout: 20_000,
});
const session = await provider.startSession({ cwd, model: "fake-model" });
const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const timeline: string[] = [];
let results = 0;
const timeout = setTimeout(() => {
  console.log(ts(), "TIMEOUT");
  session.abort();
}, 60_000);
session.queue.push({ text: "first" });
for await (const message of session.iterator) {
  const m = message as Record<string, unknown>;
  const label =
    m.type === "system"
      ? `system:${m.subtype}${m.origin ? `(${m.origin})` : ""}`
      : m.type === "result"
        ? `result${m.turnStatus ? `:${m.turnStatus}` : ""}`
        : `${m.type}:${JSON.stringify((m.message as { content?: unknown })?.content ?? "").slice(0, 60)}`;
  console.log(ts(), label);
  timeline.push(
    label.startsWith("system") || label.startsWith("result")
      ? label
      : String(m.type),
  );
  if (m.type === "result") {
    results += 1;
    if (results === 2) session.queue.push({ text: "second" });
    if (results === 3) break;
  }
}
clearTimeout(timeout);
session.abort();
server.close();
console.log("model requests", requests);
console.log("timeline", timeline.join(" → "));
