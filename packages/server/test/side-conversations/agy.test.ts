import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgyProvider } from "../../src/sdk/providers/agy.js";
import { findAgySessionRecord } from "../../src/sessions/agy-store.js";
import { AgySideSessionRegistry } from "../../src/side-conversations/agy-registry.js";
import {
  agySideSettingsConflict,
  allowAgySideTool,
  createAgySideConversation,
  isAgySideReadOnlyCommand,
  planAgySideFork,
} from "../../src/side-conversations/agy.js";
import {
  SIDE_BOUNDARY,
  type SideEvent,
} from "../../src/side-conversations/session.js";

const PARENT = "a0476472-2b9a-4ba8-807f-fa5b2b5adfac";

interface AppendMeta {
  antigravity?: { systemPrompt?: { append?: string } };
}

const step = (type: string, extra: Record<string, unknown> = {}) => ({
  type: `CORTEX_STEP_TYPE_${type}`,
  status: "CORTEX_STEP_STATUS_DONE",
  ...extra,
});
const user = (text: string) =>
  step("USER_INPUT", { userInput: { userResponse: text } });
const answer = () => step("PLANNER_RESPONSE", { plannerResponse: {} });
const call = () =>
  step("PLANNER_RESPONSE", {
    plannerResponse: { toolCalls: [{ name: "read_file" }] },
  });

describe("agy side read-only commands", () => {
  it.each([
    "rg -n foo src",
    "rg 'a|b' packages | head -20",
    'grep -rn "x" . 2>/dev/null | wc -l',
    "ls -la && cat package.json",
    "cd packages/server && git log --oneline -5",
    "git -C repo diff HEAD~1 -- src",
    "git status --short; git branch --show-current",
    "find . -name '*.ts' -type f",
    "sed -n '1,200p' src/app.ts",
    "tail -n 50 log.txt",
    "sort file | uniq -c",
  ])("allows %s", (command) => {
    expect(isAgySideReadOnlyCommand(command)).toBe(true);
  });

  it.each([
    "rm -rf build",
    "echo hi > file",
    "cat a >> b",
    "ls $(pwd)",
    "ls `pwd`",
    'echo "$HOME"',
    "rg --pre ./x foo",
    "find . -delete",
    "find . -exec rm {} ;",
    "sed -i 's/a/b/' f",
    "sed -n '1w out' f",
    "git commit -m x",
    "git -c core.pager=x log",
    "git diff --output=patch",
    "git branch feature",
    "sort -o out in",
    "uniq in out",
    "tail -f log",
    "FOO=1 ls",
    "./script.sh",
    "ls &",
    "ls\nrm x",
    "npm test",
    "",
  ])("refuses %s", (command) => {
    expect(isAgySideReadOnlyCommand(command)).toBe(false);
  });

  it("approves only read tools and read-only commands", () => {
    expect(allowAgySideTool("read_file", { Path: "/x" })).toBe(true);
    expect(allowAgySideTool("run_command", { CommandLine: "rg x" })).toBe(true);
    expect(allowAgySideTool("run_command", { CommandLine: "make" })).toBe(
      false,
    );
    for (const name of [
      "write_file",
      "edit_file",
      "search_web",
      "read_url_content",
      "call_mcp_tool",
      "invoke_subagent",
      "unknown_tool",
    ])
      expect(allowAgySideTool(name, {})).toBe(false);
  });
});

describe("agy side settings", () => {
  it("refuses presets and allow rules that skip approval", () => {
    expect(agySideSettingsConflict(null)).toBeNull();
    expect(agySideSettingsConflict({ trustedWorkspaces: ["/x"] })).toBeNull();
    expect(agySideSettingsConflict({ toolPermission: "strict" })).toBeNull();
    expect(
      agySideSettingsConflict({ permissions: { allow: ["read_file(src/)"] } }),
    ).toBeNull();
    expect(
      agySideSettingsConflict({ toolPermission: "always-proceed" }),
    ).toMatch(/always-proceed/);
    expect(
      agySideSettingsConflict({ permissions: { allow: ["command(git)"] } }),
    ).toMatch(/command\(git\)/);
  });
});

describe("agy side fork point", () => {
  it("forks a settled conversation at its tail, even after a system note", () => {
    const steps = [
      user("a"),
      answer(),
      user("b"),
      call(),
      step("GENERIC"),
      answer(),
    ];
    expect(planAgySideFork(steps)).toEqual({
      forkAt: [5, 1],
      pendingRequests: [],
    });
    expect(planAgySideFork([...steps, step("SYSTEM_MESSAGE")]).forkAt[0]).toBe(
      6,
    );
  });

  it("forks a running turn at the previous turn end and names its prompt", () => {
    const steps = [
      user("a"),
      answer(),
      user("explain the build"),
      step("SYSTEM_MESSAGE"),
      call(),
    ];
    expect(planAgySideFork(steps)).toEqual({
      forkAt: [1],
      pendingRequests: ["explain the build"],
    });
    const generating = [
      user("a"),
      answer(),
      user("b"),
      { ...answer(), status: "CORTEX_STEP_STATUS_GENERATING" },
    ];
    expect(planAgySideFork(generating).forkAt).toEqual([1]);
  });

  it("has nothing to fork during the first turn", () => {
    expect(planAgySideFork([user("first"), call()])).toEqual({
      forkAt: [],
      pendingRequests: ["first"],
    });
  });
});

describe("agy side registry", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("hides open and just-deleted conversations across instances", async () => {
    dir = await mkdtemp(join(tmpdir(), "yep-agy-registry-"));
    const owner = new AgySideSessionRegistry(dir);
    const reader = new AgySideSessionRegistry(dir);
    await owner.register("side-1", PARENT);
    expect(reader.isHidden("side-1")).toBe(true);
    expect(reader.isHidden(PARENT)).toBe(false);
    expect(await owner.staleIds()).toEqual([]);

    owner.release("side-1");
    expect(await owner.staleIds()).toEqual(["side-1"]);
    await owner.markDeleted("side-1");
    expect(reader.isHidden("side-1")).toBe(true);
    expect(await owner.staleIds()).toEqual([]);

    const file = JSON.parse(
      await readFile(join(dir, "agy-side-sessions.json"), "utf8"),
    );
    file.sessions.orphan = {
      parentSessionId: PARENT,
      pid: 2 ** 22 + 12345,
      createdAt: new Date().toISOString(),
    };
    await writeFile(join(dir, "agy-side-sessions.json"), JSON.stringify(file));
    expect(await reader.staleIds()).toEqual(["orphan"]);
  });

  it("keeps hidden conversations out of store lookups", async () => {
    await expect(
      findAgySessionRecord("side-1", {
        dataDir: "/nonexistent",
        isHidden: (id) => id === "side-1",
      }),
    ).resolves.toBeNull();
  });
});

/**
 * Mirrors `agy acp` 1.5.15 for side conversations: ACP over stdio, plus the
 * embedded language server (ForkConversation / GetCascadeTrajectorySteps /
 * DeleteCascadeTrajectory) whose port goes to `--log-file`.
 */
const FAKE_AGY = `#!/usr/bin/env node
const http = require("node:http");
const fs = require("node:fs");
const args = process.argv.slice(2);
const logFile = args[args.indexOf("--log-file") + 1];
const token = process.env.ANTIGRAVITY_SERVER_CSRF_TOKEN;
const record = (entry) => fs.appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify(entry) + "\\n");
const steps = JSON.parse(process.env.FAKE_AGY_STEPS || "[]");
const rejectForks = JSON.parse(process.env.FAKE_AGY_REJECT_FORKS || "[]");
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\\n");
let booted = false;
function boot() {
  if (booted) return;
  booted = true;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const method = req.url.split("/").pop();
      const params = JSON.parse(body);
      record({ ls: method, params, csrf: req.headers["x-antigravity-csrf-token"] === token });
      const ok = (value) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(value));
      if (method === "GetCascadeTrajectorySteps") return ok({ steps });
      if (method === "ForkConversation") {
        if (rejectForks.includes(params.forkAtStepIndex)) {
          res.writeHead(500).end(JSON.stringify({ code: "internal", message: "internal: a fork must be taken at the end of a turn, immediately before the next user message" }));
          return;
        }
        return ok({ newCascadeId: "side-fork", forkedAtStepIndex: params.forkAtStepIndex });
      }
      return ok({});
    });
  });
  server.listen(0, "127.0.0.1", () => {
    fs.appendFileSync(logFile, "I1124 server.go:1313] Language server listening on random port at " + server.address().port + " for HTTP\\n");
  });
}
const config = (model, tier) => [
  { id: "model", name: "Model", type: "select", currentValue: model, options: [{ value: "gemini-4-neon", name: "Neon" }, { value: "gemini-3.8-flash", name: "Flash" }] },
  { id: "thought_level", name: "Thinking", type: "select", currentValue: tier, options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
];
let current = config("gemini-3.8-flash", "low");
const modes = (id) => ({ currentModeId: id, availableModes: [{ id: "default", name: "Default" }, { id: "auto", name: "Auto" }] });
const waiting = new Map();
let nextId = 1000;
const ask = (method, params) => new Promise((resolve) => { const id = nextId++; waiting.set(id, resolve); send({ id, method, params }); });
const update = (sessionId, u) => send({ method: "session/update", params: { sessionId, update: u } });
async function prompt(msg) {
  const sid = msg.params.sessionId;
  update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Looking. " } });
  update(sid, { sessionUpdate: "tool_call", toolCallId: "c1", name: "read_file", title: "Read", kind: "read", status: "in_progress", rawInput: { Path: "/repo/a.ts" } });
  update(sid, { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", rawOutput: "export {}" });
  for (const [id, command, output] of [["c2", "rg -n foo src", "src/a.ts:1:foo"], ["c3", "rm -rf build", null]]) {
    const toolCall = { toolCallId: id, name: "run_command", title: "Run", kind: "execute", status: "pending", rawInput: { CommandLine: command } };
    update(sid, { sessionUpdate: "tool_call", ...toolCall, status: "in_progress" });
    const answer = await ask("session/request_permission", { sessionId: sid, toolCall, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] });
    record({ permission: id, answer });
    const allowed = answer.outcome && answer.outcome.optionId === "allow";
    update(sid, { sessionUpdate: "tool_call_update", toolCallId: id, status: allowed ? "completed" : "failed", rawOutput: allowed ? { output } : { error: "denied" } });
  }
  send({ id: msg.id, result: { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } });
  // agy resolves the prompt slightly before its last chunk.
  setTimeout(() => update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } }), 100);
}
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === undefined && waiting.has(msg.id)) { waiting.get(msg.id)(msg.result); waiting.delete(msg.id); continue; }
    record({ rpc: msg.method, params: msg.params });
    if (msg.method === "initialize") send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {}, list: {} } } } });
    else if (msg.method === "session/list") { boot(); send({ id: msg.id, result: { sessions: [] } }); }
    else if (msg.method === "session/new") { boot(); send({ id: msg.id, result: { sessionId: "side-new", modes: modes("default"), configOptions: current } }); }
    else if (msg.method === "session/resume") send({ id: msg.id, result: { modes: modes("auto"), configOptions: current } });
    else if (msg.method === "session/set_mode") send({ id: msg.id, result: {} });
    else if (msg.method === "session/set_config_option") {
      current = current.map((o) => (o.id === msg.params.configId ? { ...o, currentValue: msg.params.value } : o));
      send({ id: msg.id, result: { configOptions: current } });
    }
    else if (msg.method === "session/prompt") void prompt(msg);
    else if (msg.method === "session/close") send({ id: msg.id, result: {} });
    else if (msg.id !== undefined) send({ id: msg.id, result: {} });
  }
});
`;

describe("agy side conversation transport", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function setup(env: Record<string, string> = {}) {
    dir = await mkdtemp(join(tmpdir(), "yep-agy-side-test-"));
    const agyPath = join(dir, "agy");
    await writeFile(agyPath, FAKE_AGY);
    await chmod(agyPath, 0o755);
    const logPath = join(dir, "calls.jsonl");
    const events: SideEvent[] = [];
    const registry = new AgySideSessionRegistry(dir);
    const calls = async () =>
      (await readFile(logPath, "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    const create = (context: "snapshot" | "empty", settings?: unknown) =>
      (async () => {
        const settingsPath = join(dir as string, "settings.json");
        if (settings !== undefined)
          await writeFile(settingsPath, JSON.stringify(settings));
        return createAgySideConversation({
          agyPath,
          cwd: dir as string,
          env: {
            FAKE_AGY_LOG: logPath,
            FAKE_AGY_STEPS: JSON.stringify([
              user("a"),
              answer(),
              user("b"),
              call(),
              step("GENERIC"),
              answer(),
            ]),
            ...env,
          },
          parentSessionId: PARENT,
          model: "gemini-4-neon",
          reasoningEffort: "high",
          context,
          emit: (event) => events.push(event),
          registry,
          settingsPath,
        });
      })();
    return { create, events, calls, registry };
  }

  async function waitFor(check: () => boolean) {
    const deadline = Date.now() + 10_000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error("timed out");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it("forks the main conversation, keeps tools read-only and deletes the copy", async () => {
    const { create, events, calls, registry } = await setup();
    const side = await create("snapshot");
    expect(side.providerSessionId).toBe("side-fork");
    expect(side.model).toBe("gemini-4-neon");
    expect(side.reasoningEffort).toBe("high");
    expect(registry.isHidden("side-fork")).toBe(true);

    const log = await calls();
    const fork = log.find((entry) => entry.ls === "ForkConversation");
    expect(fork).toMatchObject({
      csrf: true,
      params: { sourceCascadeId: PARENT, forkAtStepIndex: 5 },
    });
    const resume = log.find((entry) => entry.rpc === "session/resume");
    const append = (resume?.params as { _meta?: AppendMeta })?._meta
      ?.antigravity?.systemPrompt?.append;
    expect(append).toContain(SIDE_BOUNDARY);
    expect(append).toContain("read-only shell commands");
    expect(log.some((entry) => entry.rpc === "session/new")).toBe(false);
    expect(log.find((entry) => entry.rpc === "session/set_mode")).toMatchObject(
      { params: { sessionId: "side-fork", modeId: "default" } },
    );

    const image = join(dir as string, "shot.png");
    await writeFile(image, Buffer.from("png"));
    await side.send("Why?", "q1", [
      { path: image, name: "shot.png", mimeType: "image/png" },
    ]);
    await waitFor(() => events.some((event) => event.type === "done"));

    const prompt = (await calls()).find(
      (entry) => entry.rpc === "session/prompt",
    );
    // The fork carries the boundary through systemPrompt.append; the
    // question is sent as the user wrote it.
    expect((prompt?.params as { prompt: unknown[] }).prompt).toEqual([
      { type: "text", text: "Why?" },
      {
        type: "image",
        mimeType: "image/png",
        data: Buffer.from("png").toString("base64"),
      },
    ]);
    const permissions = (await calls()).filter((entry) => entry.permission);
    expect(permissions).toEqual([
      {
        permission: "c2",
        answer: { outcome: { outcome: "selected", optionId: "allow" } },
      },
      {
        permission: "c3",
        answer: { outcome: { outcome: "selected", optionId: "deny" } },
      },
    ]);

    const text = events
      .filter((event) => event.type === "text")
      .map((event) => (event as { text: string }).text)
      .join("");
    expect(text).toContain("Looking. ");
    // The chunk after the prompt resolved still belongs to the turn.
    expect(text).toContain("Done.");
    expect(text).toContain("Declined run_command `rm -rf build`");
    const toolNames = events.flatMap((event) =>
      event.type === "blocks"
        ? event.blocks.flatMap((block) =>
            block.type === "tool_use" ? [block.name] : [],
          )
        : [],
    );
    expect(toolNames).toContain("Read");
    expect(toolNames).toContain("Bash");
    expect(events).toContainEqual({
      type: "tool_result",
      toolUseId: "c2",
      content: "src/a.ts:1:foo",
    });
    expect(events.find((event) => event.type === "done")).toEqual({
      type: "done",
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    await side.close();
    const after = await calls();
    expect(after.some((entry) => entry.rpc === "session/close")).toBe(true);
    expect(
      after.find((entry) => entry.ls === "DeleteCascadeTrajectory"),
    ).toMatchObject({ params: { cascadeId: "side-fork" } });
    // Still hidden until agy's catalog drops the row, but no longer stale.
    expect(registry.isHidden("side-fork")).toBe(true);
    expect(await registry.staleIds()).toEqual([]);
  });

  it("falls back to the previous turn end when the tail moved on", async () => {
    const { create, calls } = await setup({ FAKE_AGY_REJECT_FORKS: "[5]" });
    const side = await create("snapshot");
    const forks = (await calls()).filter(
      (entry) => entry.ls === "ForkConversation",
    );
    expect(
      forks.map(
        (entry) =>
          (entry.params as { forkAtStepIndex: number }).forkAtStepIndex,
      ),
    ).toEqual([5, 1]);
    await side.close();
  });

  it("starts a fresh session without the main context", async () => {
    const { create, calls, events, registry } = await setup();
    const side = await create("empty");
    const log = await calls();
    expect(log.some((entry) => entry.ls === "ForkConversation")).toBe(false);
    const created = log.find((entry) => entry.rpc === "session/new");
    expect(
      (created?.params as { _meta?: AppendMeta })._meta?.antigravity
        ?.systemPrompt?.append as string,
    ).toContain(SIDE_BOUNDARY);
    await side.send("Hello?", "q1");
    await waitFor(() => events.some((event) => event.type === "done"));
    // A fresh side lacks the inherited boundary, so the first question
    // carries it in front.
    const first = (await calls()).filter(
      (entry) => entry.rpc === "session/prompt",
    )[0];
    expect((first?.params as { prompt: unknown[] }).prompt).toEqual([
      { type: "text", text: SIDE_BOUNDARY },
      { type: "text", text: "Hello?" },
    ]);
    expect(registry.isHidden("side-new")).toBe(true);
    await side.close();
    expect(
      (await calls()).find((entry) => entry.ls === "DeleteCascadeTrajectory"),
    ).toMatchObject({ params: { cascadeId: "side-new" } });
  });

  it("keeps the idle parent process while a side conversation is open", async () => {
    // The parent runs in its own fake `agy acp`; the side gets another one.
    const root = await mkdtemp(join(tmpdir(), "yep-agy-side-parent-"));
    try {
      const agyPath = join(root, "agy");
      await writeFile(agyPath, FAKE_AGY);
      await chmod(agyPath, 0o755);
      // The parent's env reaches both `agy acp` processes it starts.
      vi.stubEnv("FAKE_AGY_LOG", join(root, "parent-calls.jsonl"));
      await writeFile(join(root, "settings.json"), "{}");
      const provider = new AgyProvider({ agyPath, dataDir: root });
      const session = await provider.startSession({
        cwd: root,
        permissionMode: "default",
      });
      const seen: unknown[] = [];
      const iterator = session.iterator;
      void (async () => {
        for (;;) {
          const next = await iterator.next();
          if (next.done) return;
          seen.push(next.value);
        }
      })();
      await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0), {
        timeout: 10_000,
      });
      expect(session.hasPendingBackgroundWork?.()).toBe(false);
      const control = session.sideConversations;
      if (!control) throw new Error("side conversations expected");
      const created = await control.execute({
        action: "create",
        requestId: "side",
        context: "empty",
      });
      expect(created.error).toBeUndefined();
      expect(created.conversation?.providerSessionId).toBe("side-new");
      // Reclaiming the idle parent would drop the conversation it asks about.
      expect(session.hasPendingBackgroundWork?.()).toBe(true);
      await control.execute({ action: "close", id: created.conversation?.id });
      expect(session.hasPendingBackgroundWork?.()).toBe(false);
      session.abort();
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("refuses settings that let agy skip approvals before starting agy", async () => {
    const { create, calls } = await setup();
    await expect(
      create("snapshot", { toolPermission: "always-proceed" }),
    ).rejects.toThrow(/always-proceed/);
    expect(await calls()).toEqual([]);
  });
});
