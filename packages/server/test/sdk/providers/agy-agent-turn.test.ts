import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgyProvider } from "../../../src/sdk/providers/agy.js";
import type { AgentSession, SDKMessage } from "../../../src/sdk/types.js";

const SESSION = "5940bac3-fc12-4736-acc7-4f9b98076acc";

/**
 * `agy acp` modelled on the real trace (references/antigravity/probe/step7):
 * the prompt starts a background command and resolves `end_turn`; when the
 * command finishes agy wakes itself (`SYSTEM_MESSAGE`), streams the reply
 * with no prompt in flight, and sends no end-of-turn signal. The transcript
 * is the only record of where that turn ends.
 */
const FAKE_AGY = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const sid = "${SESSION}";
const dir = path.join(process.env.FAKE_AGY_DATA, "brain", sid, ".system_generated", "logs");
fs.mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, "transcript_full.jsonl");
let step = 0;
const write = (type, extra = {}) => fs.appendFileSync(transcript, JSON.stringify({ step_index: step++, source: "MODEL", type, status: "DONE", created_at: new Date().toISOString(), ...extra }) + "\n");
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const update = (u) => send({ method: "session/update", params: { sessionId: sid, update: u } });
const chunk = (text) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wakeHold = 0;
let steerId = null;
let cancelled = false;
async function wake() {
  update({ sessionUpdate: "tool_call_update", toolCallId: "call_bg", status: "completed", rawOutput: { output: "BG_DONE_42" } });
  write("SYSTEM_MESSAGE", { source: "SYSTEM" });
  await sleep(300 + wakeHold);
  if (cancelled) return;
  chunk("The background task finished.");
  write("PLANNER_RESPONSE", { content: "The background task finished." });
  if (steerId !== null) {
    send({ id: steerId, result: { stopReason: "end_turn" } });
    steerId = null;
  }
}
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "session/cancel") { cancelled = true; continue; }
    if (msg.id === undefined) continue;
    if (msg.method === "initialize") send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    else if (msg.method === "session/new") send({ id: msg.id, result: { sessionId: sid } });
    else if (msg.method === "session/prompt") {
      const text = msg.params.prompt.map((b) => b.text ?? "").join("");
      if (text === "cancel-me") {
        // A cancelled turn leaves its call open; agy never reports on it.
        update({ sessionUpdate: "tool_call", toolCallId: "call_cancel", status: "in_progress", title: "sleep", rawInput: { CommandLine: "sleep 60" } });
        send({ id: msg.id, result: { stopReason: "cancelled" } });
      } else if (text.startsWith("start")) {
        wakeHold = text === "start-slow" ? 2500 : 0;
        write("USER_INPUT", { source: "USER_EXPLICIT", content: "<USER_REQUEST>" + text + "</USER_REQUEST>" });
        update({ sessionUpdate: "tool_call", toolCallId: "call_bg", status: "in_progress", title: "sleep", rawInput: { CommandLine: "sleep 1 && echo BG_DONE_42" } });
        write("PLANNER_RESPONSE", { tool_calls: [{ name: "run_command", args: { CommandLine: "sleep 1" } }] });
        write("GENERIC", { status: "RUNNING", content: "Tool is running as a background task" });
        chunk("Started.");
        write("PLANNER_RESPONSE", { content: "Started." });
        send({ id: msg.id, result: { stopReason: "end_turn" } });
        // Observed in the real trace: the last chunks can trail the response.
        setTimeout(() => chunk(" (trailing)"), 100);
        setTimeout(wake, 400);
      } else {
        // A prompt sent while agy works joins the running turn and resolves
        // when that turn ends.
        steerId = msg.id;
      }
    } else send({ id: msg.id, result: {} });
  }
});
`;

describe("agy agent-initiated turns", () => {
  let dir: string;
  let agyPath: string;
  let session: AgentSession | undefined;

  beforeEach(async () => {
    vi.stubEnv("YEP_AGY_PROXY", "");
    dir = await mkdtemp(join(tmpdir(), "agy-wake-"));
    agyPath = join(dir, "agy");
    await writeFile(agyPath, FAKE_AGY);
    await chmod(agyPath, 0o755);
    await mkdir(join(dir, "data"), { recursive: true });
    vi.stubEnv("FAKE_AGY_DATA", join(dir, "data"));
  });

  afterEach(async () => {
    session?.abort();
    session = undefined;
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  async function start(): Promise<SDKMessage[]> {
    const provider = new AgyProvider({ agyPath, dataDir: join(dir, "data") });
    session = await provider.startSession({
      cwd: dir,
      permissionMode: "default",
    });
    const seen: SDKMessage[] = [];
    const iterator = session.iterator;
    void (async () => {
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        seen.push(next.value);
      }
    })();
    return seen;
  }

  const markers = (seen: SDKMessage[]) =>
    seen.flatMap((m) => {
      if (m.type === "result") return [`result:${m.turnStatus}`];
      if (m.type === "user" && typeof m.uuid === "string")
        return Array.isArray(m.message?.content) &&
          m.message.content.some(
            (b: { type?: string }) => b.type === "tool_result",
          )
          ? ["tool_result"]
          : ["user"];
      if (m.type === "system" && m.subtype === "turn_started")
        return ["turn_started"];
      return [];
    });

  it("reports a background-task wake-up as its own turn", async () => {
    const seen = await start();
    session?.queue.push({ text: "start", uuid: "client-1" });
    await vi.waitFor(
      () => {
        expect(seen.filter((m) => m.type === "result")).toHaveLength(2);
      },
      { timeout: 10_000 },
    );
    expect(markers(seen)).toEqual([
      "user",
      "result:completed",
      "turn_started",
      "tool_result",
      "result:completed",
    ]);
    expect(
      seen.find((m) => m.type === "system" && m.subtype === "turn_started"),
    ).toMatchObject({ origin: "agent", session_id: SESSION });
    // The background command finished: nothing keeps the idle process now.
    expect(session?.hasPendingBackgroundWork?.()).toBe(false);
    // The finishing reply streamed inside the woken turn.
    const lastUser = seen.findLastIndex((m) => m.type === "result");
    const wokenText = seen
      .slice(0, lastUser)
      .filter((m) => m.type === "assistant")
      .map((m) => JSON.stringify(m.message?.content));
    expect(wokenText.some((t) => t.includes("background task finished"))).toBe(
      true,
    );
  }, 20_000);

  it("keeps the process while a background command is still running", async () => {
    const seen = await start();
    session?.queue.push({ text: "start-slow", uuid: "client-1" });
    await vi.waitFor(
      () => expect(seen.filter((m) => m.type === "result")).toHaveLength(1),
      { timeout: 10_000 },
    );
    expect(session?.hasPendingBackgroundWork?.()).toBe(true);
  }, 20_000);

  it("does not keep a cancelled turn's open call as background work", async () => {
    const seen = await start();
    session?.queue.push({ text: "cancel-me", uuid: "client-1" });
    await vi.waitFor(
      () => expect(seen.filter((m) => m.type === "result")).toHaveLength(1),
      { timeout: 10_000 },
    );
    expect(markers(seen).at(-1)).toBe("result:interrupted");
    expect(session?.hasPendingBackgroundWork?.()).toBe(false);
  }, 20_000);

  it("lets a prompt join a turn agy started and end with it", async () => {
    const seen = await start();
    session?.queue.push({ text: "start-slow", uuid: "client-1" });
    await vi.waitFor(() => expect(markers(seen)).toContain("turn_started"), {
      timeout: 10_000,
    });
    await expect(
      session?.steer?.({ text: "also say hi", uuid: "client-2" }),
    ).resolves.toEqual({ accepted: true });
    await vi.waitFor(
      () => {
        expect(seen.filter((m) => m.type === "result")).toHaveLength(2);
      },
      { timeout: 10_000 },
    );
    expect(markers(seen).at(-1)).toBe("result:completed");
  }, 20_000);

  it("ends a cancelled wake-up as interrupted", async () => {
    const seen = await start();
    session?.queue.push({ text: "start-slow", uuid: "client-1" });
    await vi.waitFor(() => expect(markers(seen)).toContain("turn_started"), {
      timeout: 10_000,
    });
    await session?.interrupt?.();
    await vi.waitFor(
      () => {
        expect(seen.filter((m) => m.type === "result")).toHaveLength(2);
      },
      { timeout: 10_000 },
    );
    expect(markers(seen).at(-1)).toBe("result:interrupted");
  }, 20_000);

  it("does not mistake the end of a prompt's text for a new turn", async () => {
    const seen = await start();
    session?.queue.push({ text: "start-slow", uuid: "client-1" });
    await vi.waitFor(
      () => {
        expect(seen.filter((m) => m.type === "result")).toHaveLength(2);
      },
      { timeout: 15_000 },
    );
    // Exactly one woken turn: the trailing chunk of the prompt's own reply
    // must not open a second one.
    expect(markers(seen).filter((m) => m === "turn_started")).toHaveLength(1);
  }, 20_000);
});
