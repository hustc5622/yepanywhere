import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DshSessionScanner } from "../../src/projects/dsh-scanner.js";
import { DshSessionReader } from "../../src/sessions/dsh-reader.js";
import {
  listDshSessionRecords,
  pickDshLogFile,
  projectDshEvents,
  readDshLog,
  readDshLogActivity,
  resolveDshHome,
  scanCompleteZstdFrames,
} from "../../src/sessions/dsh-store.js";
import { normalizeSession } from "../../src/sessions/normalization.js";

const CWD = "/work/demo";
const PROJECT_ID = "demo" as UrlProjectId;

function frame(lines: unknown[]): Buffer {
  return zstdCompressSync(
    Buffer.from(lines.map((line) => `${JSON.stringify(line)}\n`).join("")),
  );
}

function header(id: string, extra: Record<string, unknown> = {}) {
  return {
    type: "session",
    version: 4,
    id,
    createdAt: 1_789_000_000_000,
    cwd: CWD,
    delegationDepth: 0,
    ...extra,
  };
}

const userPrompt = (seq: number, text: string) => ({
  type: "user/message",
  seq,
  time: 1_789_000_000_000 + seq,
  data: {
    id: `user-${seq}`,
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  },
});

const injectedContext = (seq: number) => ({
  type: "user/message",
  seq,
  time: 1_789_000_000_000 + seq,
  data: {
    id: `ctx-${seq}`,
    role: "user",
    content: [
      { type: "text", text: "<system-reminder>instructions</system-reminder>" },
    ],
    source: { kind: "agent-instructions" },
  },
});

const assistant = (seq: number, content: unknown[]) => ({
  type: "assistant/message",
  seq,
  time: 1_789_000_000_000 + seq,
  data: {
    turn: 1,
    step: 1,
    message: {
      id: `assistant-${seq}`,
      role: "assistant",
      content,
      source: {
        kind: "model",
        provider: "deepseek-official",
        model: "deepseek-v4-pro",
      },
    },
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 900,
      totalTokens: 1020,
    },
  },
});

const toolResult = (seq: number, callId: string, text: string) => ({
  type: "tool/result",
  seq,
  time: 1_789_000_000_000 + seq,
  data: {
    message: {
      id: `tool-${seq}`,
      role: "tool",
      toolCallId: callId,
      content: [{ type: "text", text }],
      isError: false,
      source: { kind: "tool", callId },
    },
  },
});

describe("dsh store", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dsh-store-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeSession(
    id: string,
    frames: Buffer[],
    options: { fileName?: string; headerExtra?: Record<string, unknown> } = {},
  ): Promise<string> {
    const dir = join(root, "--work-demo--", id);
    await mkdir(dir, { recursive: true });
    const path = join(dir, options.fileName ?? "session.v4.jsonl.zstd");
    await writeFile(
      path,
      Buffer.concat([frame([header(id, options.headerExtra)]), ...frames]),
    );
    return path;
  }

  it("resolves DSH_HOME like dsh, treating a blank override as unset", () => {
    expect(resolveDshHome({ DSH_HOME: "/custom" })).toBe("/custom");
    expect(resolveDshHome({ DSH_HOME: "   " })).toMatch(/\.dsh$/);
  });

  it("picks the highest format generation", () => {
    expect(
      pickDshLogFile([
        "session.jsonl.zstd",
        "session.v3.jsonl.zstd",
        "session.v4.jsonl.zstd",
        "session.lock",
      ]),
    ).toBe("session.v4.jsonl.zstd");
    expect(pickDshLogFile(["session.lock"])).toBeNull();
  });

  it("decodes every concatenated frame and ignores a torn tail", async () => {
    const path = await writeSession("session-a", [
      frame([userPrompt(1, "hello")]),
      frame([assistant(2, [{ type: "text", text: "hi" }])]),
    ]);
    const torn = frame([userPrompt(3, "late")]);
    await appendFile(path, torn.subarray(0, torn.length - 3));

    const buffer = Buffer.concat([
      frame([header("x")]),
      frame([userPrompt(1, "a")]),
      torn.subarray(0, 5),
    ]);
    expect(scanCompleteZstdFrames(buffer)).toHaveLength(2);

    const log = await readDshLog(path);
    expect(log?.header.id).toBe("session-a");
    expect(log?.events.map((event) => event.type)).toEqual([
      "user/message",
      "assistant/message",
    ]);

    // Completing the frame is picked up incrementally.
    await appendFile(path, torn.subarray(torn.length - 3));
    const grown = await readDshLog(path);
    expect(grown?.events).toHaveLength(3);
  });

  it("lists root conversations only and skips delegated subagents", async () => {
    await writeSession("session-root", [frame([userPrompt(1, "hi")])]);
    await writeSession("session-child", [frame([userPrompt(1, "task")])], {
      headerExtra: { parentSession: "session-root", origin: "subagent" },
    });
    const records = await listDshSessionRecords({ sessionsDir: root });
    expect(records.map((record) => record.sessionId)).toEqual(["session-root"]);
  });

  it("projects prompts, tools, titles and turn outcomes into Pi entries", () => {
    const { session, facts } = projectDshEvents(header("session-p"), [
      { type: "turn/start", seq: 0, data: { turn: 1 } },
      userPrompt(1, "list files"),
      injectedContext(2),
      { type: "request/context", seq: 3, data: { contextWindow: 1_000_000 } },
      assistant(4, [
        { type: "reasoning", text: "Let me look." },
        {
          type: "tool-call",
          id: "call_1",
          name: "bash",
          arguments: '{"command":"ls","description":"List"}',
        },
      ]),
      toolResult(5, "call_1", "a.txt"),
      assistant(6, [{ type: "text", text: "Done." }]),
      { type: "session/title", seq: 7, data: { title: "List files" } },
      {
        type: "turn/end",
        seq: 8,
        data: {
          turn: 1,
          reason: { kind: "aborted", reason: { kind: "user" } },
        },
      },
    ]);
    const roles = session.entries.map((entry) =>
      entry.type === "message" && "message" in entry
        ? (entry.message as { role: string }).role
        : entry.type,
    );
    expect(roles).toEqual(["user", "assistant", "toolResult", "assistant"]);
    expect(facts).toEqual({
      title: "List files",
      contextWindow: 1_000_000,
      activity: { turn: "settled", waitingInput: false },
    });
    const call = session.entries[1];
    expect(call && "message" in call && call.message).toMatchObject({
      content: [
        { type: "thinking", thinking: "Let me look." },
        {
          type: "toolCall",
          id: "call_1",
          name: "bash",
          arguments: { command: "ls" },
        },
      ],
      usage: { input: 100, output: 20, cacheRead: 900 },
    });
    const last = session.entries.at(-1);
    expect(last && "message" in last && last.message).toMatchObject({
      stopReason: "aborted",
    });
  });

  it("records a failed turn as an assistant error", () => {
    const { session } = projectDshEvents(header("session-e"), [
      { type: "turn/start", seq: 0, data: { turn: 1 } },
      userPrompt(1, "go"),
      {
        type: "turn/end",
        seq: 2,
        data: {
          turn: 1,
          reason: {
            kind: "error",
            error: { message: "quota exceeded", code: "QUOTA" },
          },
        },
      },
    ]);
    expect(session.entries.at(-1)).toMatchObject({
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "quota exceeded",
      },
    });
  });

  it("reports an open turn and a pending approval as waiting input", async () => {
    const path = await writeSession("session-live", [
      frame([
        { type: "turn/start", seq: 0, data: { turn: 1 } },
        userPrompt(1, "delete it"),
        {
          type: "approval/asked",
          seq: 2,
          data: { id: "ap-1", toolName: "bash", callId: "c1" },
        },
      ]),
    ]);
    expect(await readDshLogActivity(path)).toEqual({
      turn: "in-flight",
      waitingInput: true,
    });
    await appendFile(
      path,
      frame([
        {
          type: "approval/decided",
          seq: 3,
          data: { id: "ap-1", outcome: "allowed-once" },
        },
      ]),
    );
    expect(await readDshLogActivity(path)).toEqual({
      turn: "in-flight",
      waitingInput: false,
    });
  });

  it("reads summaries and normalized transcripts through the reader", async () => {
    await writeSession("session-r", [
      frame([
        { type: "turn/start", seq: 0, data: { turn: 1 } },
        userPrompt(1, "explain the build"),
        { type: "request/context", seq: 2, data: { contextWindow: 100_000 } },
        assistant(3, [{ type: "text", text: "It uses tsc." }]),
        { type: "session/title", seq: 4, data: { title: "Explain build" } },
        {
          type: "turn/end",
          seq: 5,
          data: { turn: 1, reason: { kind: "completed" } },
        },
      ]),
    ]);
    // A blank session (header only) is not listed.
    await writeSession("session-blank", []);

    const reader = new DshSessionReader({
      sessionsDir: root,
      projectPath: CWD,
    });
    const sessions = await reader.listSessions(PROJECT_ID);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: "session-r",
      provider: "dsh",
      title: "Explain build",
      messageCount: 2,
      lastTurnStatus: "completed",
      contextUsage: { contextWindow: 100_000, percentage: 1 },
    });

    const loaded = await reader.getSession("session-r", PROJECT_ID);
    expect(loaded?.data.provider).toBe("dsh");
    const normalized = loaded ? normalizeSession(loaded) : null;
    expect(normalized?.messages.map((message) => message.type)).toEqual([
      "user",
      "assistant",
    ]);

    const projects = await new DshSessionScanner({
      sessionsDir: root,
    }).listProjects();
    expect(projects).toMatchObject([
      { path: CWD, sessionCount: 1, provider: "dsh", hasDshSessions: true },
    ]);
  });
});
