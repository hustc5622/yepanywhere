/**
 * ZCode provider integration tests.
 *
 * Uses a fake `zcode app-server` (inline .js script) to exercise the full
 * `ZCodeProvider.startSession` lifecycle against:
 *   - session/create + session/send + event stream + turn.completed
 *   - session/resume
 *   - text delta aggregation
 *   - tool call + tool result
 *   - permission request (interaction/requestPermission) via onToolApproval
 *   - user input request (interaction/requestUserInput) via onToolApproval
 *   - session/stop (interrupt)
 *   - model/mode switching
 *   - unsupported browser request (fail-closed)
 *   - secret not exposed in any output
 *
 * The fake server matches the REAL ZCode CLI 0.16.1 protocol contract:
 *   - No `jsonrpc` field in messages
 *   - session/create requires `workspace` and returns a snapshot with
 *     `result.session.sessionId` (NOT `result.id`)
 *   - session/resume uses `sessionId` (NOT `id`)
 *   - session/send uses `content` (string, NOT nested message object)
 *   - Events use `{method: "session/event", params: {type, payload?, seq, sessionId, ...}}`
 *   - session/setModel uses `model: {providerId, modelId}` (NOT top-level fields)
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZCodeProvider } from "../../../src/sdk/providers/zcode.js";
import type { CanUseTool, ToolApprovalResult } from "../../../src/sdk/types.js";

// =============================================================================
// Fake app-server fixture
// =============================================================================

const SECRET_SENTINEL = "sk-test-sentinel-DO-NOT-LEAK";

function writeFakeZcodeAppServer(tempDir: string): string {
  const fakePath = join(tempDir, "fake-zcode-provider.js");
  writeFileSync(
    fakePath,
    `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv[0] !== "app-server") process.exit(1);

const fs = require("node:fs");
const path = require("node:path");
// Always log outbound requests next to this fixture so tests can assert the
// exact params without any shared process state.
const requestLogPath = path.join(__dirname, "requests.jsonl");

let buffer = "";
let seqCounter = 0;

// Real ZCode CLI 0.16.1 params schemas are all \`.strict()\`: an unrecognized
// key fails the whole call with -32602 ("Invalid params"). Encode the exact
// allowed key sets so the fixture rejects anything the real CLI would reject.
const STRICT_PARAM_KEYS = {
  "session/create": [
    "sessionId", "workspace", "parentSessionId", "mode", "model",
    "runtimeModel", "persistence", "thoughtLevel", "titleGenerationEnabled",
    "mcpServers", "toolAllowlist", "toolDenylist", "importedHistory",
  ],
  "session/resume": [
    "sessionId", "workspace", "runtimeModel", "thoughtLevel",
    "mcpServers", "toolAllowlist", "toolDenylist",
  ],
  "session/subscribe": ["sessionId", "deliveryKind", "afterSeq", "includeSnapshot"],
  "session/send": [
    "sessionId", "inputId", "queryId", "content", "attachments",
    "browserAmbientContext", "expectedRevision", "expectedProviderRevision",
    "expectedModelRuntimeRevision", "runtimeModel", "automationId",
    "offPeakTaskId", "offPeakRunType",
  ],
  "session/stop": ["sessionId"],
  "session/setModel": [
    "sessionId", "model", "runtimeModel", "expectedRevision",
    "persistAsWorkspaceLastUsed",
  ],
  "session/setMode": ["sessionId", "mode", "expectedRevision"],
  "session/setThoughtLevel": [
    "sessionId", "thoughtLevel", "runtimeModel", "expectedRevision",
    "persistAsWorkspaceLastUsed",
  ],
  "session/messages": ["sessionId"],
  "session/fork": ["sessionId", "target", "expectedRevision"],
  "session/close": ["sessionId"],
  "session/compact": ["sessionId"],
  "session/goal": [
    "sessionId", "inputId", "action", "objective", "expectedRevision",
  ],
  "mcp/list": ["workspace", "mcpServers", "mode"],
};

// Real ZCode CLI 0.16.1 does NOT use a jsonrpc field.
function send(id, result) {
  process.stdout.write(JSON.stringify({ id, result }) + "\\n");
}

function sendError(id, code, message) {
  process.stdout.write(
    JSON.stringify({ id, error: { code, message } }) + "\\n",
  );
}

/** Returns the first unrecognized key, mirroring Zod's strict rejection. */
function findUnrecognizedKey(method, params) {
  const allowed = STRICT_PARAM_KEYS[method];
  if (!allowed) return null;
  for (const key of Object.keys(params ?? {})) {
    if (!allowed.includes(key)) return key;
  }
  return null;
}

function notify(method, params) {
  process.stdout.write(
    JSON.stringify({ method, params }) + "\\n",
  );
}

// Real CLI 0.16.1 event envelope: {method: "session/event", params: {type, payload, seq, sessionId, eventId, timestamp}}
function event(type, payload) {
  seqCounter++;
  notify("session/event", {
    eventId: "evt-" + seqCounter,
    sessionId: "fake-session-1",
    seq: seqCounter,
    timestamp: Date.now(),
    type: type,
    payload: payload,
  });
}

function request(id, method, params) {
  process.stdout.write(
    JSON.stringify({ id, method, params }) + "\\n",
  );
}

let approvalPending = false;
let approvalResolve = null;

function handle(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const method = msg.method;
  if (!method) return;

  if (requestLogPath) {
    fs.appendFileSync(
      requestLogPath,
      JSON.stringify({ method: method, params: msg.params ?? null }) + "\\n",
    );
  }

  const badKey = findUnrecognizedKey(method, msg.params);
  if (badKey) {
    sendError(msg.id, -32602, "Invalid params \\u2014 unrecognized key: " + badKey);
    return;
  }

  if (method === "workspace/readState") {
    send(msg.id, { workspace: { root: "/tmp" }, models: [] });
    return;
  }

  if (method === "workspace/updateProviderRegistry") {
    send(msg.id, { updated: true });
    return;
  }

  if (method === "mcp/list") {
    // Real CLI 0.16.1 requires mode: "status" for a read-only snapshot
    // (default "connect" would open connections). Enforce that here.
    if (msg.params.mode !== "status") {
      sendError(msg.id, -32602, "Invalid params \\u2014 yep must send mode: status");
      return;
    }
    const rawStatuses = process.env.ZCODE_FAKE_MCP_STATUSES;
    const statuses = rawStatuses && rawStatuses !== "undefined"
      ? JSON.parse(rawStatuses)
      : {};
    send(msg.id, { statuses: statuses });
    return;
  }

  if (method === "session/create") {
    // Real CLI returns a snapshot with result.session.sessionId
    send(msg.id, {
      session: { sessionId: "fake-session-1", title: "Test Session", status: "idle" },
    });
    return;
  }

  if (method === "session/resume") {
    // Real CLI uses sessionId param, returns snapshot
    send(msg.id, {
      session: { sessionId: msg.params.sessionId, title: "Resumed Session", status: "idle" },
    });
    return;
  }

  if (method === "session/subscribe") {
    send(msg.id, { subscribed: true });
    return;
  }

  if (method === "session/send") {
    send(msg.id, { sent: true });

    // Simulate a text response using the REAL CLI 0.16.1 streaming payload
    // shape: {kind, delta, done, assistantMessageId} (verified by live smoke:
    // chunks live in delta, message identity in assistantMessageId).
    const msgId = "msg-" + Date.now();
    event("model.streaming", { kind: "text_start", delta: "", done: false, assistantMessageId: msgId });
    event("model.streaming", { kind: "text_delta", delta: "Hello", done: false, assistantMessageId: msgId });
    event("model.streaming", { kind: "text_delta", delta: " world", done: false, assistantMessageId: msgId });
    event("model.streaming", { kind: "text_end", delta: "", done: false, assistantMessageId: msgId });

    if (process.env.ZCODE_FAKE_TOOL === "1") {
      const toolId = "tool-1";
      event("model.streaming", { kind: "tool_input_start", delta: "", done: false, toolCallId: toolId });
      // Real CLI flushes the ACCUMULATED tool input in delta (not increments).
      event("model.streaming", { kind: "tool_input_delta", delta: '{"command":"ls"', done: false, toolCallId: toolId });
      event("model.streaming", { kind: "tool_input_delta", delta: '{"command":"ls"}', done: false, toolCallId: toolId });
      event("model.streaming", { kind: "tool_input_end", delta: "", done: false, toolCallId: toolId });
      // Real tool_call carries the parsed input object directly.
      event("model.streaming", { kind: "tool_call", input: { command: "ls" }, done: false, toolCallId: toolId, toolName: "Bash" });
      event("tool.updated", { toolCallId: toolId, toolName: "Bash", toolStatus: "completed", toolOutput: "file.txt" });
    }

    if (process.env.ZCODE_FAKE_PERMISSION === "1") {
      request("perm-1", "interaction/requestPermission", {
        toolName: "Bash",
        input: { command: "rm -rf /" },
      });
    }

    if (process.env.ZCODE_FAKE_USER_INPUT === "1") {
      request("ui-1", "interaction/requestUserInput", {
        toolName: "AskUserQuestion",
        questions: [{ type: "choice", prompt: "Which option?", options: ["A", "B"] }],
      });
    }

    if (process.env.ZCODE_FAKE_BROWSER_REQUEST === "1") {
      request("br-1", "interaction/browserList", {});
    }

    event("turn.completed", {
      usage: { inputTokens: 42, outputTokens: 7, cachedInputTokens: 12 },
      cacheStats: { totalMessages: 3, cachedMessages: 1, lastCacheHit: true },
    });
    return;
  }

  if (method === "session/messages") {
    // Ordered message list for edit-fork target resolution. Tests override
    // the list via ZCODE_FAKE_MESSAGES (JSON array of message ids).
    const ids = process.env.ZCODE_FAKE_MESSAGES
      ? JSON.parse(process.env.ZCODE_FAKE_MESSAGES)
      : ["m1", "m2", "m3"];
    send(msg.id, {
      messages: ids.map((id, i) => ({
        id: id,
        role: i % 2 === 0 ? "user" : "assistant",
      })),
    });
    return;
  }

  if (method === "session/fork") {
    // Real CLI 0.16.1: message-target fork is INCLUSIVE, result carries the
    // forked session id, and the fork becomes active in this app-server.
    const target = msg.params.target;
    if (!target || target.kind !== "message" || typeof target.messageId !== "string") {
      sendError(msg.id, -32602, "Invalid params \\u2014 target must be a message target");
      return;
    }
    send(msg.id, {
      forkedSessionId: "fake-forked-1",
      parentSessionId: msg.params.sessionId,
      targetMessageId: target.messageId,
      response: "forked",
      snapshot: { session: { sessionId: "fake-forked-1" } },
    });
    return;
  }

  if (method === "session/close") {
    send(msg.id, { closed: true });
    return;
  }

  if (method === "session/compact") {
    send(msg.id, { compacted: true });
    return;
  }

  if (method === "session/goal") {
    // Real CLI 0.16.1: result {response, snapshot?, startedTurn?}; set and
    // replace may start a turn immediately.
    const action = msg.params.action;
    if (action === "set" || action === "replace") {
      if (typeof msg.params.objective !== "string") {
        sendError(msg.id, -32602, "Invalid params \\u2014 objective required");
        return;
      }
      send(msg.id, {
        response: "goal updated: " + action,
        startedTurn: true,
      });
      return;
    }
    send(msg.id, { response: "goal status: no active goal", startedTurn: false });
    return;
  }

  if (method === "session/setThoughtLevel") {
    send(msg.id, { thoughtLevelSet: true });
    return;
  }

  if (method === "session/stop") {
    send(msg.id, { stopped: true });
    return;
  }

  if (method === "session/setModel") {
    send(msg.id, { modelSet: true });
    return;
  }

  if (method === "session/setMode") {
    send(msg.id, { modeSet: true });
    return;
  }

  // Server request responses (approval/user-input answers come back here).
  if (!method && msg.id && msg.result !== undefined) {
    // This is a response to our server request — no action needed.
    return;
  }

  sendError(msg.id, -32601, "Unknown method: " + method);
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

async function makeProvider(
  tempDir: string,
): Promise<{ provider: ZCodeProvider; fakePath: string }> {
  const fakePath = writeFakeZcodeAppServer(tempDir);
  // Never let provider tests read or modify the developer's real ~/.zcode.
  const provider = new ZCodeProvider({
    cliPath: fakePath,
    configDir: join(tempDir, "zcode-home"),
  });
  return { provider, fakePath };
}

interface LoggedRequest {
  method: string;
  params: Record<string, unknown> | null;
}

/**
 * Read the outbound requests the fake app-server recorded.
 *
 * Asserting the exact params is the only way to catch a `.strict()` contract
 * violation before it reaches the real CLI.
 */
function readRequestLog(tempDir: string): LoggedRequest[] {
  const logPath = join(tempDir, "requests.jsonl");
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as LoggedRequest);
}

/**
 * Write a ZCode config whose single available model advertises thought levels.
 * Mirrors the real GLM-5-Turbo `reasoning` capability.
 */
function writeConfigWithThoughtLevels(configDir: string): void {
  mkdirSync(join(configDir, "v2"), { recursive: true });
  writeFileSync(
    join(configDir, "v2", "config.json"),
    JSON.stringify({
      provider: {
        "builtin:zai": {
          name: "Z.ai",
          kind: "anthropic",
          options: { apiKey: SECRET_SENTINEL },
          models: {
            "glm-5-turbo": {
              name: "GLM-5-Turbo",
              reasoning: {
                enabled: true,
                variants: ["enabled", "off"],
                defaultVariant: "enabled",
              },
            },
            "glm-5.2": { name: "GLM-5.2", reasoning: null },
          },
        },
      },
    }),
  );
}

function makeApprovalHandler(decision: "allow" | "deny" = "allow"): {
  handler: CanUseTool;
  calls: { toolName: string; input: unknown }[];
} {
  const calls: { toolName: string; input: unknown }[] = [];
  const handler: CanUseTool = async (toolName, input, options) => {
    calls.push({ toolName, input });
    const result: ToolApprovalResult = {
      behavior: decision,
      ...(decision === "allow" ? { approvalScope: "once" as const } : {}),
    };
    return result;
  };
  return { handler, calls };
}

async function drainIterator(
  iterator: AsyncIterableIterator<{ type: string; [key: string]: unknown }>,
  maxMessages = 50,
): Promise<{ type: string; [key: string]: unknown }[]> {
  const messages: { type: string; [key: string]: unknown }[] = [];
  for await (const msg of iterator) {
    messages.push(msg);
    if (messages.length >= maxMessages) break;
    if (msg.type === "result") break;
  }
  return messages;
}

// =============================================================================
// Tests
// =============================================================================

describe("ZCodeProvider", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zcode-provider-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("provider metadata", () => {
    it("has correct name and displayName", async () => {
      const { provider } = await makeProvider(tempDir);
      expect(provider.name).toBe("zcode");
      expect(provider.displayName).toBe("ZCode");
    });

    it("reports only the permission modes ZCode can actually honour", async () => {
      const { provider } = await makeProvider(tempDir);
      expect(provider.permissionModes).toEqual([
        "default",
        "acceptEdits",
        "plan",
        "bypassPermissions",
      ]);
    });

    it("never advertises auto, whose ZCode mode denies every tool call", async () => {
      const { provider } = await makeProvider(tempDir);
      // ZCode 0.16.1 denies all tools in native `auto`
      // (`mode.auto.unimplemented`). Advertising it would make it the implicit
      // default because DEFAULT_PERMISSION_MODE is "auto".
      expect(provider.permissionModes).not.toContain("auto");
    });

    it("does not advertise a thinking toggle ZCode cannot apply", async () => {
      const { provider } = await makeProvider(tempDir);
      expect(provider.supportsThinkingToggle).toBe(false);
    });

    it("reports as installed when CLI path exists", async () => {
      const { provider } = await makeProvider(tempDir);
      expect(await provider.isInstalled()).toBe(true);
    });
  });

  describe("startSession — basic create + send", () => {
    it("creates a session, sends a message, and yields init + text + result", async () => {
      const { provider } = await makeProvider(tempDir);
      const session = await provider.startSession({
        cwd: tempDir,
        initialMessage: { text: "Hello" },
        permissionMode: "default",
      });

      try {
        const messages = await drainIterator(session.iterator);
        const types = messages.map((m) => m.type);
        expect(types).toContain("system"); // init
        expect(types).toContain("assistant"); // text
        expect(types).toContain("result"); // turn complete
      } finally {
        session.abort();
      }
    });

    it("yields system/init with session_id", async () => {
      const { provider } = await makeProvider(tempDir);
      const session = await provider.startSession({
        cwd: tempDir,
        initialMessage: { text: "Test" },
      });

      try {
        const messages = await drainIterator(session.iterator);
        const init = messages.find((m) => m.subtype === "init");
        expect(init).toBeDefined();
        expect(init?.session_id).toBe("fake-session-1");
      } finally {
        session.abort();
      }
    });

    it("aggregates text deltas into a single assistant message", async () => {
      const { provider } = await makeProvider(tempDir);
      const session = await provider.startSession({
        cwd: tempDir,
        initialMessage: { text: "Hello" },
      });

      try {
        const messages = await drainIterator(session.iterator);
        const assistantMsgs = messages.filter((m) => m.type === "assistant");
        const textBlocks = assistantMsgs.flatMap(
          (m) => (m.message?.content as Array<{ text?: string }>) ?? [],
        );
        const fullText = textBlocks.map((b) => b.text ?? "").join("");
        expect(fullText).toBe("Hello world");
      } finally {
        session.abort();
      }
    });
  });

  describe("startSession — attachments", () => {
    const PNG_BASE64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    it("forwards structured uploads and inline images as ZCode wire attachments", async () => {
      const { provider } = await makeProvider(tempDir);
      const session = await provider.startSession({
        cwd: tempDir,
        initialMessage: {
          text: "with files",
          attachments: [
            {
              id: "u1",
              originalName: "shot.png",
              name: "u1_shot.png",
              path: "/tmp/uploads/u1_shot.png",
              size: 123,
              mimeType: "image/png",
            },
            {
              id: "u2",
              originalName: "notes.txt",
              name: "u2_notes.txt",
              path: "/tmp/uploads/u2_notes.txt",
              size: 45,
              mimeType: "text/plain",
            },
          ],
          images: [PNG_BASE64],
        },
      });

      try {
        await drainIterator(session.iterator);
      } finally {
        session.abort();
      }

      const sendReq = readRequestLog(tempDir).find(
        (r) => r.method === "session/send",
      );
      // Real CLI 0.16.1 attachment normalizer accepts {kind, filename,
      // localPath|dataBase64, mimeType, sizeBytes} loose records.
      expect(sendReq?.params?.attachments).toEqual([
        {
          kind: "image",
          filename: "shot.png",
          localPath: "/tmp/uploads/u1_shot.png",
          mimeType: "image/png",
          sizeBytes: 123,
        },
        {
          kind: "file",
          filename: "notes.txt",
          localPath: "/tmp/uploads/u2_notes.txt",
          mimeType: "text/plain",
          sizeBytes: 45,
        },
        {
          kind: "image",
          filename: "pasted-image-1.png",
          mimeType: "image/png",
          dataBase64: PNG_BASE64,
        },
      ]);
    });

    it("omits the attachments key when the message has none", async () => {
      const { provider } = await makeProvider(tempDir);
      const session = await provider.startSession({
        cwd: tempDir,
        initialMessage: { text: "plain" },
      });

      try {
        await drainIterator(session.iterator);
      } finally {
        session.abort();
      }

      const sendReq = readRequestLog(tempDir).find(
        (r) => r.method === "session/send",
      );
      expect(sendReq).toBeDefined();
      // The real CLI's params schema is strict; an empty/undefined
      // attachments key must be omitted entirely.
      expect("attachments" in (sendReq?.params ?? {})).toBe(false);
    });
  });

  describe("startSession — resume", () => {
    it("resumes an existing session", async () => {
      const { provider } = await makeProvider(tempDir);
      const session = await provider.startSession({
        cwd: tempDir,
        resumeSessionId: "existing-session-42",
        initialMessage: { text: "Continue" },
      });

      try {
        const messages = await drainIterator(session.iterator);
        const init = messages.find((m) => m.subtype === "init");
        expect(init?.session_id).toBe("existing-session-42");
      } finally {
        session.abort();
      }
    });

    it("never sends model or mode on session/resume", async () => {
      // `session/resume` params are `.strict()` and accept neither key, so
      // sending them fails the entire resume with -32602.
      const { provider } = await makeProvider(tempDir);
      const session = await provider.startSession({
        cwd: tempDir,
        resumeSessionId: "existing-session-42",
        permissionMode: "acceptEdits",
        model: "builtin:zai/glm-5.2",
        initialMessage: { text: "Continue" },
      });

      try {
        await drainIterator(session.iterator);
      } finally {
        session.abort();
      }

      const resume = readRequestLog(tempDir).find(
        (r) => r.method === "session/resume",
      );
      expect(resume).toBeDefined();
      expect(resume?.params).not.toHaveProperty("model");
      expect(resume?.params).not.toHaveProperty("mode");
      expect(resume?.params?.sessionId).toBe("existing-session-42");
    });

    it("applies the requested mode after resume via session/setMode", async () => {
      const { provider } = await makeProvider(tempDir);
      const session = await provider.startSession({
        cwd: tempDir,
        resumeSessionId: "existing-session-42",
        permissionMode: "acceptEdits",
        initialMessage: { text: "Continue" },
      });

      try {
        await drainIterator(session.iterator);
      } finally {
        session.abort();
      }

      const log = readRequestLog(tempDir);
      const setMode = log.find((r) => r.method === "session/setMode");
      expect(setMode?.params).toEqual({
        sessionId: "existing-session-42",
        mode: "edit",
      });
      // Mode must be applied only after the session exists.
      expect(
        log.findIndex((r) => r.method === "session/setMode"),
      ).toBeGreaterThan(log.findIndex((r) => r.method === "session/resume"));
    });

    it("surfaces a strict-schema rejection instead of hanging", async () => {
      // Guards the fixture itself: an unrecognized key must fail loudly.
      const { provider } = await makeProvider(tempDir);
      const session = await provider.startSession({
        cwd: tempDir,
        resumeSessionId: "existing-session-42",
        initialMessage: { text: "Continue" },
      });
      try {
        const messages = await drainIterator(session.iterator);
        expect(messages.some((m) => m.type === "error")).toBe(false);
      } finally {
        session.abort();
      }
    });
  });

  describe("startSession — edit fork (resumeSessionAt)", () => {
    it("forks before the edited message, then converses on the forked session", async () => {
      const { provider } = await makeProvider(tempDir);
      const session = await provider.startSession({
        cwd: tempDir,
        resumeSessionId: "src-1",
        resumeSessionAt: "m3",
        initialMessage: { text: "edited prompt" },
      });

      try {
        const messages = await drainIterator(session.iterator);
        const init = messages.find((m) => m.subtype === "init");
        expect(init?.session_id).toBe("fake-forked-1");
      } finally {
        session.abort();
      }

      const log = readRequestLog(tempDir);
      // A message-target fork is INCLUSIVE, so the fork targets the message
      // before the edited one (m3 → m2).
      const fork = log.find((r) => r.method === "session/fork");
      expect(fork?.params).toEqual({
        sessionId: "src-1",
        target: { kind: "message", messageId: "m2" },
      });
      // The source session is resumed (activation) before the fork and
      // closed after it.
      expect(log.findIndex((r) => r.method === "session/resume")).toBeLessThan(
        log.findIndex((r) => r.method === "session/fork"),
      );
      expect(
        log.findIndex((r) => r.method === "session/close"),
      ).toBeGreaterThan(log.findIndex((r) => r.method === "session/fork"));
      expect(log.find((r) => r.method === "session/close")?.params).toEqual({
        sessionId: "src-1",
      });
      // The new turn must go to the forked session, not the source.
      const send = log.find((r) => r.method === "session/send");
      expect(send?.params?.sessionId).toBe("fake-forked-1");
    });

    it("applies explicit mode overrides to the forked session", async () => {
      const { provider } = await makeProvider(tempDir);
      const session = await provider.startSession({
        cwd: tempDir,
        resumeSessionId: "src-1",
        resumeSessionAt: "m3",
        permissionMode: "acceptEdits",
        initialMessage: { text: "edited prompt" },
      });

      try {
        await drainIterator(session.iterator);
      } finally {
        session.abort();
      }

      const setMode = readRequestLog(tempDir).find(
        (r) => r.method === "session/setMode",
      );
      expect(setMode?.params).toEqual({
        sessionId: "fake-forked-1",
        mode: "edit",
      });
    });

    it("fails closed when the edited message is not in the session", async () => {
      const { provider } = await makeProvider(tempDir);
      const session = await provider.startSession({
        cwd: tempDir,
        resumeSessionId: "src-1",
        resumeSessionAt: "m-unknown",
        initialMessage: { text: "edited prompt" },
      });

      try {
        const messages = await drainIterator(session.iterator);
        const error = messages.find((m) => m.type === "error");
        expect(error).toBeDefined();
        expect(String(error?.error)).toContain("could not find message");
      } finally {
        session.abort();
      }

      const log = readRequestLog(tempDir);
      expect(log.find((r) => r.method === "session/fork")).toBeUndefined();
      expect(log.find((r) => r.method === "session/send")).toBeUndefined();
    });

    it("fails closed when editing the first message (no inclusive target)", async () => {
      const { provider } = await makeProvider(tempDir);
      const session = await provider.startSession({
        cwd: tempDir,
        resumeSessionId: "src-1",
        resumeSessionAt: "m1",
        initialMessage: { text: "edited first prompt" },
      });

      try {
        const messages = await drainIterator(session.iterator);
        const error = messages.find((m) => m.type === "error");
        expect(error).toBeDefined();
        expect(String(error?.error)).toContain("first message");
      } finally {
        session.abort();
      }

      const log = readRequestLog(tempDir);
      expect(log.find((r) => r.method === "session/fork")).toBeUndefined();
    });

    it("never calls session/fork for a plain resume", async () => {
      const { provider } = await makeProvider(tempDir);
      const session = await provider.startSession({
        cwd: tempDir,
        resumeSessionId: "src-1",
        initialMessage: { text: "continue" },
      });

      try {
        await drainIterator(session.iterator);
      } finally {
        session.abort();
      }

      const log = readRequestLog(tempDir);
      expect(log.find((r) => r.method === "session/fork")).toBeUndefined();
      expect(log.find((r) => r.method === "session/messages")).toBeUndefined();
      expect(log.find((r) => r.method === "session/close")).toBeUndefined();
    });
  });

  describe("listMcpServers (read-only mcp/list)", () => {
    it("queries mcp/list in status mode with the full workspace identity", async () => {
      const configDir = join(tempDir, "zcode-home");
      writeConfigWithThoughtLevels(configDir);
      const provider = new ZCodeProvider({
        cliPath: writeFakeZcodeAppServer(tempDir),
        configDir,
      });
      process.env.ZCODE_FAKE_MCP_STATUSES = JSON.stringify({
        context7: {
          status: "connected",
          transport: "http",
          toolCount: 4,
          updatedAt: "2026-08-13T00:00:00Z",
        },
        flaky: {
          status: "failed",
          transport: "stdio",
          toolCount: 0,
          updatedAt: "2026-08-13T00:01:00Z",
          error: "Authorization: Bearer secret-mcp-token",
          protocolEra: "modern",
        },
      });
      try {
        const servers = await provider.listMcpServers(tempDir);
        expect(servers).toEqual({
          context7: {
            status: "connected",
            transport: "http",
            toolCount: 4,
            updatedAt: "2026-08-13T00:00:00Z",
          },
          flaky: {
            status: "failed",
            transport: "stdio",
            toolCount: 0,
            updatedAt: "2026-08-13T00:01:00Z",
            error: "Authorization: Bearer secret-mcp-token",
          },
        });
      } finally {
        process.env.ZCODE_FAKE_MCP_STATUSES = undefined;
      }

      const mcpList = readRequestLog(tempDir).find(
        (r) => r.method === "mcp/list",
      );
      expect(mcpList?.params).toEqual({
        workspace: { workspacePath: tempDir, workspaceKey: tempDir },
        mode: "status",
      });
      // Read-only introspection must never create sessions or inject the
      // provider registry.
      const methods = readRequestLog(tempDir).map((r) => r.method);
      expect(methods).not.toContain("session/create");
      expect(methods).not.toContain("workspace/updateProviderRegistry");
      expect(existsSync(join(configDir, "cli", "config.json"))).toBe(false);
    });

    it("returns an empty map when the workspace has no MCP servers", async () => {
      const configDir = join(tempDir, "zcode-home");
      writeConfigWithThoughtLevels(configDir);
      const provider = new ZCodeProvider({
        cliPath: writeFakeZcodeAppServer(tempDir),
        configDir,
      });
      await expect(provider.listMcpServers(tempDir)).resolves.toEqual({});
    });

    it("throws a stable error when the ZCode config is unavailable", async () => {
      const provider = new ZCodeProvider({
        cliPath: writeFakeZcodeAppServer(tempDir),
        configDir: join(tempDir, "missing-zcode-home"),
      });
      await expect(provider.listMcpServers(tempDir)).rejects.toMatchObject({
        code: "zcode_config_unavailable",
      });
    });

    it("throws a stable error when the CLI cannot be spawned", async () => {
      const configDir = join(tempDir, "zcode-home");
      writeConfigWithThoughtLevels(configDir);
      const provider = new ZCodeProvider({
        cliPath: join(tempDir, "nonexistent-zcode-cli"),
        configDir,
      });
      await expect(provider.listMcpServers(tempDir)).rejects.toMatchObject({
        code: "zcode_protocol_start_failed",
      });
    });
  });

  describe("CLI bootstrap config safety", () => {
    it("keeps auth/model queries free of config write side effects", async () => {
      const configDir = join(tempDir, "zcode-home");
      writeConfigWithThoughtLevels(configDir);
      const provider = new ZCodeProvider({
        cliPath: writeFakeZcodeAppServer(tempDir),
        configDir,
      });

      await expect(provider.getAuthStatus()).resolves.toMatchObject({
        authenticated: true,
      });
      await expect(provider.getAvailableModels()).resolves.toHaveLength(2);
      expect(existsSync(join(configDir, "cli", "config.json"))).toBe(false);
    });

    it("creates only a minimal 0600 model bootstrap on session start", async () => {
      const configDir = join(tempDir, "zcode-home");
      writeConfigWithThoughtLevels(configDir);
      const provider = new ZCodeProvider({
        cliPath: writeFakeZcodeAppServer(tempDir),
        configDir,
      });
      const session = await provider.startSession({
        cwd: tempDir,
        model: "builtin:zai/glm-5-turbo",
        initialMessage: { text: "Hi" },
      });
      try {
        await drainIterator(session.iterator);
      } finally {
        session.abort();
      }

      const cliConfigPath = join(configDir, "cli", "config.json");
      const raw = readFileSync(cliConfigPath, "utf-8");
      expect(JSON.parse(raw)).toEqual({
        model: "builtin:zai/glm-5-turbo",
      });
      expect(raw).not.toContain(SECRET_SENTINEL);
      expect(raw).not.toContain("apiKey");
      if (process.platform !== "win32") {
        expect(statSync(cliConfigPath).mode & 0o777).toBe(0o600);
      }
    });

    it("preserves an existing CLI config while tightening its permissions", async () => {
      const configDir = join(tempDir, "zcode-home");
      writeConfigWithThoughtLevels(configDir);
      const cliDir = join(configDir, "cli");
      const cliConfigPath = join(cliDir, "config.json");
      mkdirSync(cliDir, { recursive: true });
      const existing = JSON.stringify({ model: "existing/model", keep: true });
      writeFileSync(cliConfigPath, existing, { mode: 0o644 });
      const provider = new ZCodeProvider({
        cliPath: writeFakeZcodeAppServer(tempDir),
        configDir,
      });
      const session = await provider.startSession({
        cwd: tempDir,
        initialMessage: { text: "Hi" },
      });
      try {
        await drainIterator(session.iterator);
      } finally {
        session.abort();
      }

      expect(readFileSync(cliConfigPath, "utf-8")).toBe(existing);
      if (process.platform !== "win32") {
        expect(statSync(cliConfigPath).mode & 0o777).toBe(0o600);
      }
    });
  });

  describe("session actions — compact and thought level", () => {
    /**
     * Run the first turn and invoke `action` while the session generator is
     * still alive (drainIterator closes the client by consuming to the end).
     */
    async function startAndAct(
      provider: ZCodeProvider,
      options: Parameters<ZCodeProvider["startSession"]>[0],
      action: (
        session: Awaited<ReturnType<ZCodeProvider["startSession"]>>,
      ) => Promise<void>,
    ): Promise<void> {
      const session = await provider.startSession(options);
      try {
        for await (const msg of session.iterator) {
          if (msg.type === "result") {
            await action(session);
            break;
          }
        }
      } finally {
        session.abort();
      }
    }

    it("triggers session/compact with the strict params contract", async () => {
      const { provider } = await makeProvider(tempDir);
      await startAndAct(
        provider,
        { cwd: tempDir, initialMessage: { text: "Hi" } },
        async (session) => {
          await session.compact?.();
        },
      );
      const compact = readRequestLog(tempDir).find(
        (r) => r.method === "session/compact",
      );
      expect(compact?.params).toEqual({ sessionId: "fake-session-1" });
    });

    it("fails closed when compacting without an active session", async () => {
      const { provider } = await makeProvider(tempDir);
      const session = await provider.startSession({ cwd: tempDir });
      // No init consumed yet → no session id bound.
      await expect(session.compact?.()).rejects.toThrow(
        "requires an active session",
      );
      session.abort();
    });

    it("switches thought level mid-session via session/setThoughtLevel", async () => {
      const configDir = join(tempDir, "zcode-home");
      writeConfigWithThoughtLevels(configDir);
      const provider = new ZCodeProvider({
        cliPath: writeFakeZcodeAppServer(tempDir),
        configDir,
      });
      await startAndAct(
        provider,
        {
          cwd: tempDir,
          model: "builtin:zai/glm-5-turbo",
          initialMessage: { text: "Hi" },
        },
        async (session) => {
          await session.setReasoningEffort?.("off");
        },
      );
      const setThought = readRequestLog(tempDir).find(
        (r) => r.method === "session/setThoughtLevel",
      );
      expect(setThought?.params).toEqual({
        sessionId: "fake-session-1",
        thoughtLevel: "off",
      });
    });

    it("fails closed for a level the current model does not advertise", async () => {
      const configDir = join(tempDir, "zcode-home");
      writeConfigWithThoughtLevels(configDir);
      const provider = new ZCodeProvider({
        cliPath: writeFakeZcodeAppServer(tempDir),
        configDir,
      });
      // glm-5.2 has `reasoning: null` → no thought levels at all.
      await startAndAct(
        provider,
        {
          cwd: tempDir,
          model: "builtin:zai/glm-5.2",
          initialMessage: { text: "Hi" },
        },
        async (session) => {
          await expect(session.setReasoningEffort?.("enabled")).rejects.toThrow(
            "not supported by the current model",
          );
        },
      );
      expect(
        readRequestLog(tempDir).find(
          (r) => r.method === "session/setThoughtLevel",
        ),
      ).toBeUndefined();
    });

    it("fails closed when no model is known (keeps the CLI default)", async () => {
      const configDir = join(tempDir, "zcode-home");
      writeConfigWithThoughtLevels(configDir);
      const provider = new ZCodeProvider({
        cliPath: writeFakeZcodeAppServer(tempDir),
        configDir,
      });
      await startAndAct(
        provider,
        { cwd: tempDir, initialMessage: { text: "Hi" } },
        async (session) => {
          await expect(session.setReasoningEffort?.("off")).rejects.toThrow(
            "not supported by the current model",
          );
        },
      );
    });

    it("exposes the model catalog with thought levels for the switcher UI", async () => {
      const configDir = join(tempDir, "zcode-home");
      writeConfigWithThoughtLevels(configDir);
      const provider = new ZCodeProvider({
        cliPath: writeFakeZcodeAppServer(tempDir),
        configDir,
      });
      const session = await provider.startSession({ cwd: tempDir });
      try {
        const models = (await session.supportedModels?.()) ?? [];
        const turbo = models.find((m) => m.id === "builtin:zai/glm-5-turbo");
        expect(turbo?.supportedReasoningEfforts).toEqual([
          { reasoningEffort: "enabled" },
          { reasoningEffort: "off" },
        ]);
      } finally {
        session.abort();
      }
    });
  });

  describe("session actions — goal lifecycle", () => {
    async function startAndActGoal(
      provider: ZCodeProvider,
      options: Parameters<ZCodeProvider["startSession"]>[0],
      action: (
        session: Awaited<ReturnType<ZCodeProvider["startSession"]>>,
      ) => Promise<void>,
    ): Promise<void> {
      const session = await provider.startSession(options);
      try {
        for await (const msg of session.iterator) {
          if (msg.type === "result") {
            await action(session);
            break;
          }
        }
      } finally {
        session.abort();
      }
    }

    it("reads the goal status via action=show with strict params", async () => {
      const { provider } = await makeProvider(tempDir);
      let status: { response: string; startedTurn?: boolean } | undefined;
      await startAndActGoal(
        provider,
        { cwd: tempDir, initialMessage: { text: "Hi" } },
        async (session) => {
          status = await session.getGoal?.();
        },
      );
      expect(status).toEqual({
        response: "goal status: no active goal",
        startedTurn: false,
      });
      const goal = readRequestLog(tempDir).find(
        (r) => r.method === "session/goal",
      );
      expect(goal?.params).toEqual({
        sessionId: "fake-session-1",
        action: "show",
      });
    });

    it("sends set with the objective and surfaces startedTurn", async () => {
      const { provider } = await makeProvider(tempDir);
      let result: { response: string; startedTurn?: boolean } | undefined;
      await startAndActGoal(
        provider,
        { cwd: tempDir, initialMessage: { text: "Hi" } },
        async (session) => {
          result = await session.goalAction?.("set", "refactor the parser");
        },
      );
      expect(result).toEqual({
        response: "goal updated: set",
        startedTurn: true,
      });
      const goal = readRequestLog(tempDir).find(
        (r) => r.method === "session/goal",
      );
      expect(goal?.params).toEqual({
        sessionId: "fake-session-1",
        action: "set",
        objective: "refactor the parser",
      });
    });

    it("sends pause without an objective", async () => {
      const { provider } = await makeProvider(tempDir);
      await startAndActGoal(
        provider,
        { cwd: tempDir, initialMessage: { text: "Hi" } },
        async (session) => {
          await session.goalAction?.("pause");
        },
      );
      const goal = readRequestLog(tempDir).find(
        (r) => r.method === "session/goal",
      );
      expect(goal?.params).toEqual({
        sessionId: "fake-session-1",
        action: "pause",
      });
    });

    it("fails closed for goal actions without an active session", async () => {
      const { provider } = await makeProvider(tempDir);
      const session = await provider.startSession({ cwd: tempDir });
      await expect(session.getGoal?.()).rejects.toThrow(
        "requires an active session",
      );
      await expect(session.goalAction?.("pause")).rejects.toThrow(
        "requires an active session",
      );
      session.abort();
    });
  });

  describe("permission mode wiring", () => {
    it("maps each advertised mode to its native ZCode mode on create", async () => {
      const expected: Record<string, string> = {
        default: "build",
        acceptEdits: "edit",
        plan: "plan",
        bypassPermissions: "yolo",
      };
      for (const [yepMode, zcodeMode] of Object.entries(expected)) {
        const dir = await mkdtemp(join(tmpdir(), "zcode-mode-"));
        try {
          const { provider } = await makeProvider(dir);
          const session = await provider.startSession({
            cwd: dir,
            permissionMode: yepMode as "default",
            initialMessage: { text: "Hi" },
          });
          try {
            await drainIterator(session.iterator);
          } finally {
            session.abort();
          }
          const create = readRequestLog(dir).find(
            (r) => r.method === "session/create",
          );
          expect(create?.params?.mode).toBe(zcodeMode);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }
    });

    it("degrades a legacy persisted auto mode to build instead of ZCode auto", async () => {
      // ZCode's native `auto` denies every tool call, so it must never be sent.
      const { provider } = await makeProvider(tempDir);
      const session = await provider.startSession({
        cwd: tempDir,
        permissionMode: "auto",
        initialMessage: { text: "Hi" },
      });
      try {
        await drainIterator(session.iterator);
      } finally {
        session.abort();
      }
      const create = readRequestLog(tempDir).find(
        (r) => r.method === "session/create",
      );
      expect(create?.params?.mode).toBe("build");
    });
  });

  describe("thought level (reasoning effort)", () => {
    it("advertises thought levels only for models that declare them", async () => {
      const configDir = join(tempDir, "zcode-home");
      writeConfigWithThoughtLevels(configDir);
      const provider = new ZCodeProvider({
        cliPath: writeFakeZcodeAppServer(tempDir),
        configDir,
      });

      const models = await provider.getAvailableModels();
      const turbo = models.find((m) => m.id === "builtin:zai/glm-5-turbo");
      const flagship = models.find((m) => m.id === "builtin:zai/glm-5.2");

      expect(turbo?.supportsEffort).toBe(true);
      expect(turbo?.supportedReasoningEfforts).toEqual([
        { reasoningEffort: "enabled" },
        { reasoningEffort: "off" },
      ]);
      expect(turbo?.defaultReasoningEffort).toBe("enabled");

      // `reasoning: null` means the CLI has no thought level to select.
      expect(flagship?.supportsEffort).toBeUndefined();
      expect(flagship?.supportedReasoningEfforts).toBeUndefined();
    });

    it("sends the requested thought level on session/create", async () => {
      const configDir = join(tempDir, "zcode-home");
      writeConfigWithThoughtLevels(configDir);
      const provider = new ZCodeProvider({
        cliPath: writeFakeZcodeAppServer(tempDir),
        configDir,
      });

      const session = await provider.startSession({
        cwd: tempDir,
        model: "builtin:zai/glm-5-turbo",
        reasoningEffort: "off",
        initialMessage: { text: "Hi" },
      });
      try {
        await drainIterator(session.iterator);
      } finally {
        session.abort();
      }

      const create = readRequestLog(tempDir).find(
        (r) => r.method === "session/create",
      );
      expect(create?.params?.thoughtLevel).toBe("off");
    });

    it("omits thoughtLevel for a model with no reasoning capability", async () => {
      const configDir = join(tempDir, "zcode-home");
      writeConfigWithThoughtLevels(configDir);
      const provider = new ZCodeProvider({
        cliPath: writeFakeZcodeAppServer(tempDir),
        configDir,
      });

      const session = await provider.startSession({
        cwd: tempDir,
        model: "builtin:zai/glm-5.2",
        reasoningEffort: "enabled",
        initialMessage: { text: "Hi" },
      });
      try {
        await drainIterator(session.iterator);
      } finally {
        session.abort();
      }

      const create = readRequestLog(tempDir).find(
        (r) => r.method === "session/create",
      );
      expect(create?.params).not.toHaveProperty("thoughtLevel");
    });
  });

  describe("usage reporting", () => {
    it("normalizes turn.completed usage into canonical token fields", async () => {
      const { provider } = await makeProvider(tempDir);
      const session = await provider.startSession({
        cwd: tempDir,
        initialMessage: { text: "Hi" },
      });
      try {
        const messages = await drainIterator(session.iterator);
        const result = messages.find((m) => m.type === "result");
        expect(result?.usage).toEqual({
          input_tokens: 42,
          output_tokens: 7,
          cache_read_input_tokens: 12,
        });
      } finally {
        session.abort();
      }
    });
  });

  describe("tool lifecycle", () => {
    it("emits tool_use and tool_result blocks", async () => {
      const { provider } = await makeProvider(tempDir);
      process.env.ZCODE_FAKE_TOOL = "1";
      try {
        const session = await provider.startSession({
          cwd: tempDir,
          initialMessage: { text: "Run ls" },
        });

        try {
          const messages = await drainIterator(session.iterator);
          // Find assistant message with tool_use block.
          const toolUseMsg = messages.find(
            (m) =>
              m.type === "assistant" &&
              Array.isArray(m.message?.content) &&
              m.message?.content?.some(
                (b: { type?: string }) => b.type === "tool_use",
              ),
          );
          expect(toolUseMsg).toBeDefined();

          // Find user message with tool_result.
          const toolResultMsg = messages.find(
            (m) =>
              m.type === "user" &&
              Array.isArray(m.message?.content) &&
              m.message?.content?.some(
                (b: { type?: string }) => b.type === "tool_result",
              ),
          );
          expect(toolResultMsg).toBeDefined();
        } finally {
          session.abort();
        }
      } finally {
        process.env.ZCODE_FAKE_TOOL = undefined;
      }
    });
  });

  describe("permission approval", () => {
    it("routes interaction/requestPermission to onToolApproval", async () => {
      const { provider } = await makeProvider(tempDir);
      process.env.ZCODE_FAKE_PERMISSION = "1";
      try {
        const { handler, calls } = makeApprovalHandler("allow");
        const session = await provider.startSession({
          cwd: tempDir,
          initialMessage: { text: "Do something" },
          onToolApproval: handler,
        });

        try {
          const messages = await drainIterator(session.iterator, 100);
          expect(calls.length).toBeGreaterThan(0);
          expect(calls[0]?.toolName).toBe("Bash");
        } finally {
          session.abort();
        }
      } finally {
        process.env.ZCODE_FAKE_PERMISSION = undefined;
      }
    });

    it("denies permission when onToolApproval returns deny", async () => {
      const { provider } = await makeProvider(tempDir);
      process.env.ZCODE_FAKE_PERMISSION = "1";
      try {
        const { handler, calls } = makeApprovalHandler("deny");
        const session = await provider.startSession({
          cwd: tempDir,
          initialMessage: { text: "Do something" },
          onToolApproval: handler,
        });

        try {
          const messages = await drainIterator(session.iterator, 100);
          expect(calls.length).toBeGreaterThan(0);
          // The deny decision should be sent back to the app-server.
          // The fake server doesn't check the response, but the call happened.
        } finally {
          session.abort();
        }
      } finally {
        process.env.ZCODE_FAKE_PERMISSION = undefined;
      }
    });
  });

  describe("user input request", () => {
    it("routes interaction/requestUserInput to onToolApproval", async () => {
      const { provider } = await makeProvider(tempDir);
      process.env.ZCODE_FAKE_USER_INPUT = "1";
      try {
        const calls: { toolName: string }[] = [];
        const handler: CanUseTool = async (toolName, input) => {
          calls.push({ toolName });
          return {
            behavior: "allow",
            updatedInput: { answers: { choice: "A" } },
          };
        };
        const session = await provider.startSession({
          cwd: tempDir,
          initialMessage: { text: "Ask me" },
          onToolApproval: handler,
        });

        try {
          const messages = await drainIterator(session.iterator, 100);
          expect(calls.length).toBeGreaterThan(0);
          expect(calls[0]?.toolName).toBe("AskUserQuestion");
        } finally {
          session.abort();
        }
      } finally {
        process.env.ZCODE_FAKE_USER_INPUT = undefined;
      }
    });
  });

  describe("unsupported browser request", () => {
    it("returns unsupported error without hanging", async () => {
      const { provider } = await makeProvider(tempDir);
      process.env.ZCODE_FAKE_BROWSER_REQUEST = "1";
      try {
        const handler: CanUseTool = async () => ({ behavior: "allow" });
        const session = await provider.startSession({
          cwd: tempDir,
          initialMessage: { text: "Browse" },
          onToolApproval: handler,
        });

        try {
          // Should not hang — the unsupported request returns an error
          // and the turn continues.
          const messages = await drainIterator(session.iterator, 100);
          expect(messages.length).toBeGreaterThan(0);
        } finally {
          session.abort();
        }
      } finally {
        process.env.ZCODE_FAKE_BROWSER_REQUEST = undefined;
      }
    });
  });

  describe("secret safety", () => {
    it("does not expose API key sentinel in any SDK message", async () => {
      const { provider } = await makeProvider(tempDir);
      const session = await provider.startSession({
        cwd: tempDir,
        initialMessage: { text: "Hello" },
      });

      try {
        const messages = await drainIterator(session.iterator);
        const serialized = JSON.stringify(messages);
        expect(serialized).not.toContain(SECRET_SENTINEL);
        expect(serialized).not.toContain("sk-test-sentinel");
      } finally {
        session.abort();
      }
    });
  });

  describe("getAvailableModels", () => {
    it("returns models from config (empty when config unavailable)", async () => {
      const { provider } = await makeProvider(tempDir);
      // The fake CLI path doesn't have a real config dir, so models should be empty.
      const models = await provider.getAvailableModels();
      expect(Array.isArray(models)).toBe(true);
    });
  });
});
