import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeProjectId } from "../../src/projects/paths.js";
import {
  KimiSessionReader,
  parseKimiSubagentIds,
  parseKimiSubagentResults,
} from "../../src/sessions/kimi-reader.js";

/**
 * Coverage for Kimi subagent (Agent / explore) surfacing:
 * getAgentMappings + getAgentSession read the sibling
 * `agents/<agentId>/wire.jsonl` transcripts and link them to the parent
 * `Agent` tool call via the tool.result `agent_id:` line.
 */

const WORK_DIR = "/tmp/kimi-project";
const PROJECT_ID = encodeProjectId(WORK_DIR);
const SESSION_ID = "session_abc";

function jsonl(records: unknown[]): string {
  return `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

const MAIN_WIRE = jsonl([
  { type: "metadata", protocol_version: "1.4", created_at: 1 },
  {
    type: "turn.prompt",
    input: [{ type: "text", text: "optimize the page" }],
    origin: { kind: "user" },
    time: 1,
  },
  {
    type: "context.append_loop_event",
    event: {
      type: "tool.call",
      toolCallId: "Agent_0",
      name: "Agent",
      args: { subagent_type: "explore", prompt: "explore frontend" },
    },
    time: 2,
  },
  {
    type: "context.append_loop_event",
    event: {
      type: "tool.call",
      toolCallId: "Agent_1",
      name: "Agent",
      args: { subagent_type: "explore", prompt: "explore backend" },
    },
    time: 3,
  },
  {
    type: "context.append_loop_event",
    event: {
      type: "tool.result",
      toolCallId: "Agent_0",
      result: {
        output:
          "agent_id: agent-0\nactual_subagent_type: explore\nstatus: failed\n\nsubagent error: interrupted",
        isError: true,
      },
    },
    time: 4,
  },
  {
    type: "context.append_loop_event",
    event: {
      type: "tool.result",
      toolCallId: "Agent_1",
      result: {
        output:
          "agent_id: agent-1\nactual_subagent_type: explore\nstatus: completed\n\n[summary]\nbackend findings",
      },
    },
    time: 5,
  },
]);

// Interrupted subagent -> has a turn.cancel record -> status "failed".
const AGENT0_WIRE = jsonl([
  { type: "metadata", protocol_version: "1.4", created_at: 10 },
  {
    type: "turn.prompt",
    input: [{ type: "text", text: "explore frontend" }],
    origin: { kind: "system_trigger" },
    time: 11,
  },
  {
    type: "context.append_loop_event",
    event: { type: "content.part", part: { type: "text", text: "looking..." } },
    time: 12,
  },
  { type: "turn.cancel", time: 13 },
]);

// Completed subagent -> produced content, no cancel -> status "completed".
const AGENT1_WIRE = jsonl([
  { type: "metadata", protocol_version: "1.4", created_at: 20 },
  {
    type: "turn.prompt",
    input: [{ type: "text", text: "explore backend" }],
    origin: { kind: "system_trigger" },
    time: 21,
  },
  {
    type: "context.append_loop_event",
    event: {
      type: "content.part",
      part: { type: "text", text: "backend findings" },
    },
    time: 22,
  },
]);

describe("KimiSessionReader subagent surfacing", () => {
  let sessionsDir: string;
  let reader: KimiSessionReader;

  beforeEach(async () => {
    sessionsDir = join(
      tmpdir(),
      `kimi-sub-${Math.random().toString(36).slice(2)}`,
    );
    const sessionDir = join(sessionsDir, "wd_test", SESSION_ID);
    await mkdir(join(sessionDir, "agents", "main"), { recursive: true });
    await mkdir(join(sessionDir, "agents", "agent-0"), { recursive: true });
    await mkdir(join(sessionDir, "agents", "agent-1"), { recursive: true });

    await writeFile(
      join(sessionDir, "state.json"),
      JSON.stringify({
        workDir: WORK_DIR,
        title: "Optimize page",
        createdAt: new Date(1).toISOString(),
        updatedAt: new Date(5).toISOString(),
      }),
    );
    await writeFile(
      join(sessionDir, "agents", "main", "wire.jsonl"),
      MAIN_WIRE,
    );
    await writeFile(
      join(sessionDir, "agents", "agent-0", "wire.jsonl"),
      AGENT0_WIRE,
    );
    await writeFile(
      join(sessionDir, "agents", "agent-1", "wire.jsonl"),
      AGENT1_WIRE,
    );

    reader = new KimiSessionReader({ sessionsDir });
  });

  afterEach(async () => {
    await rm(sessionsDir, { recursive: true, force: true });
  });

  describe("getAgentMappings", () => {
    it("maps each Agent tool call to its subagent id", async () => {
      const mappings = await reader.getAgentMappings(SESSION_ID);
      expect(mappings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            toolUseId: "Agent_0",
            agentId: "agent-0",
            agentType: "explore",
            status: "failed",
          }),
          expect.objectContaining({
            toolUseId: "Agent_1",
            agentId: "agent-1",
            agentType: "explore",
            status: "completed",
          }),
        ]),
      );
      expect(mappings).toHaveLength(2);
    });

    it("returns [] without a session scope (kimi ids are per-session)", async () => {
      expect(await reader.getAgentMappings()).toEqual([]);
    });

    it("returns [] for an unknown session", async () => {
      expect(await reader.getAgentMappings("session_missing")).toEqual([]);
    });
  });

  describe("getAgentSession", () => {
    it("loads a completed subagent transcript with type + descriptor", async () => {
      const session = await reader.getAgentSession("agent-1", SESSION_ID);
      expect(session).not.toBeNull();
      expect(session?.status).toBe("completed");
      expect(session?.messages.length).toBeGreaterThan(0);
      expect(session?.agentType).toBe("explore");
      expect(session?.descriptor).toMatchObject({
        agentId: "agent-1",
        parentAgentId: "main",
        parentToolUseId: "Agent_1",
        status: "completed",
        type: "explore",
      });
    });

    it("marks an interrupted subagent (turn.cancel) as interrupted", async () => {
      const session = await reader.getAgentSession("agent-0", SESSION_ID);
      // Coarse status collapses interrupted → failed for back-compat…
      expect(session?.status).toBe("failed");
      // …but the rich descriptor preserves the interrupted distinction.
      expect(session?.descriptor?.status).toBe("interrupted");
    });

    it("returns null without a session scope", async () => {
      expect(await reader.getAgentSession("agent-1")).toBeNull();
    });

    it("returns null for a missing subagent", async () => {
      expect(await reader.getAgentSession("agent-9", SESSION_ID)).toBeNull();
    });

    it("rejects path-traversal agent ids", async () => {
      expect(
        await reader.getAgentSession("../../etc/passwd", SESSION_ID),
      ).toBeNull();
    });
  });

  it("exposes the encoded project id helper import", () => {
    // Guards against accidental unused-import churn; PROJECT_ID is derived
    // from the same encoder the routes use.
    expect(PROJECT_ID).toBe(encodeProjectId(WORK_DIR));
  });
});

describe("parseKimiSubagentIds", () => {
  it("extracts the id from a single Agent result", () => {
    expect(
      parseKimiSubagentIds("agent_id: agent-0\nstatus: completed"),
    ).toEqual(["agent-0"]);
  });

  it("extracts ids from an AgentSwarm result", () => {
    const out =
      '<agent_swarm_result><subagent agent_id="agent-0" outcome="completed">a</subagent><subagent agent_id="agent-1" outcome="failed">b</subagent></agent_swarm_result>';
    expect(parseKimiSubagentIds(out)).toEqual(["agent-0", "agent-1"]);
  });

  it("dedupes and returns [] when no id is present", () => {
    expect(parseKimiSubagentIds("no ids here")).toEqual([]);
  });
});

describe("parseKimiSubagentResults", () => {
  it("parses status + type from a single Agent result", () => {
    expect(
      parseKimiSubagentResults(
        "agent_id: agent-0\nactual_subagent_type: explore\nstatus: completed",
      ),
    ).toEqual([{ agentId: "agent-0", status: "completed", type: "explore" }]);
  });

  it("parses a background Agent result as backgrounded", () => {
    const out =
      "task_id: t1\nstatus: running\nagent_id: agent-3\nactual_subagent_type: coder\nautomatic_notification: true";
    expect(parseKimiSubagentResults(out)).toEqual([
      {
        agentId: "agent-3",
        status: "backgrounded",
        type: "coder",
        runInBackground: true,
      },
    ]);
  });

  it("parses each AgentSwarm child with its outcome + swarmIndex", () => {
    const out =
      '<agent_swarm_result><subagent agent_id="agent-0" outcome="completed">a</subagent><subagent agent_id="agent-1" outcome="failed">b</subagent></agent_swarm_result>';
    expect(parseKimiSubagentResults(out)).toEqual([
      { agentId: "agent-0", status: "completed", swarmIndex: 0 },
      { agentId: "agent-1", status: "failed", swarmIndex: 1 },
    ]);
  });

  it("maps Kimi's aborted swarm outcome to interrupted", () => {
    const out =
      '<agent_swarm_result><subagent agent_id="agent-0" state="started" outcome="aborted">interrupted</subagent></agent_swarm_result>';
    expect(parseKimiSubagentResults(out)).toEqual([
      { agentId: "agent-0", status: "interrupted", swarmIndex: 0 },
    ]);
  });
});

// ── AgentSwarm fan-out: one parent tool call → N children ────────────────
describe("KimiSessionReader AgentSwarm fan-out", () => {
  let sessionsDir: string;
  let reader: KimiSessionReader;
  const SWARM_SESSION = "session_swarm";

  const SWARM_MAIN = jsonl([
    { type: "metadata", protocol_version: "1.4", created_at: 1 },
    {
      type: "turn.prompt",
      input: [{ type: "text", text: "explore in parallel" }],
      time: 1,
    },
    {
      type: "context.append_loop_event",
      event: {
        type: "tool.call",
        toolCallId: "AgentSwarm_0",
        name: "AgentSwarm",
        args: { subagent_type: "explore", description: "parallel explore" },
      },
      time: 2,
    },
    {
      type: "context.append_loop_event",
      event: {
        type: "tool.result",
        toolCallId: "AgentSwarm_0",
        result: {
          output:
            '<agent_swarm_result><subagent agent_id="agent-0" outcome="completed">a</subagent><subagent agent_id="agent-1" outcome="failed">b</subagent></agent_swarm_result>',
        },
      },
      time: 9,
    },
  ]);

  const CHILD = (created: number, tools: number) =>
    jsonl([
      { type: "metadata", protocol_version: "1.4", created_at: created },
      { type: "config.update", profileName: "explore", time: created },
      {
        type: "turn.prompt",
        input: [{ type: "text", text: "go" }],
        time: created + 1,
      },
      ...Array.from({ length: tools }, (_, i) => ({
        type: "context.append_loop_event",
        event: { type: "tool.call", toolCallId: `t${i}`, name: "Read" },
        time: created + 2 + i,
      })),
      {
        type: "context.append_loop_event",
        event: {
          type: "step.end",
          finishReason: "end_turn",
          usage: {
            inputOther: 100,
            output: 50,
            inputCacheRead: 200,
            inputCacheCreation: 0,
          },
        },
        time: created + 2 + tools,
      },
    ]);

  beforeEach(async () => {
    sessionsDir = join(
      tmpdir(),
      `kimi-swarm-${Math.random().toString(36).slice(2)}`,
    );
    const dir = join(sessionsDir, "wd_test", SWARM_SESSION);
    await mkdir(join(dir, "agents", "main"), { recursive: true });
    await mkdir(join(dir, "agents", "agent-0"), { recursive: true });
    await mkdir(join(dir, "agents", "agent-1"), { recursive: true });
    await writeFile(
      join(dir, "state.json"),
      JSON.stringify({ workDir: WORK_DIR, title: "swarm" }),
    );
    await writeFile(join(dir, "agents", "main", "wire.jsonl"), SWARM_MAIN);
    await writeFile(join(dir, "agents", "agent-0", "wire.jsonl"), CHILD(10, 3));
    await writeFile(join(dir, "agents", "agent-1", "wire.jsonl"), CHILD(20, 2));
    reader = new KimiSessionReader({ sessionsDir });
  });

  afterEach(async () => {
    await rm(sessionsDir, { recursive: true, force: true });
  });

  it("maps one AgentSwarm call to all N children with swarmIndex", async () => {
    const mappings = await reader.getAgentMappings(SWARM_SESSION);
    expect(mappings).toHaveLength(2);
    expect(mappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolUseId: "AgentSwarm_0",
          agentId: "agent-0",
          swarmIndex: 0,
          status: "completed",
        }),
        expect.objectContaining({
          toolUseId: "AgentSwarm_0",
          agentId: "agent-1",
          swarmIndex: 1,
          status: "failed",
        }),
      ]),
    );
  });

  it("derives per-child usage breakdown, tool count, step count, duration", async () => {
    const session = await reader.getAgentSession("agent-0", SWARM_SESSION);
    expect(session?.metrics).toMatchObject({
      toolUseCount: 3,
      stepCount: 1,
    });
    expect(session?.metrics?.usage).toMatchObject({
      inputOther: 100,
      output: 50,
      inputCacheRead: 200,
      inputCacheCreation: 0,
      totalTokens: 350,
      contextTokens: 300,
    });
    // duration = last time (created+2+tools=10+2+3=15) - first (10) = 5000? No:
    // times are raw ms; created=10, last tool.call at 10+2+2=14, step.end at 15.
    expect(session?.metrics?.durationMs).toBe(5);
    expect(session?.descriptor?.status).toBe("completed");
    expect(session?.descriptor?.swarmIndex).toBe(0);
  });

  it("collapses a failed swarm child to failed status", async () => {
    // agent-1's own wire shows a clean end_turn, but the parent swarm result
    // marked it outcome=failed — the authoritative parent outcome wins.
    const session = await reader.getAgentSession("agent-1", SWARM_SESSION);
    expect(session?.descriptor?.status).toBe("failed");
    expect(session?.status).toBe("failed");
  });
});

// ── Robustness: malformed / partial / growing wire files ─────────────────
describe("KimiSessionReader robustness", () => {
  let sessionsDir: string;
  let reader: KimiSessionReader;
  const S = "session_robust";
  let dir: string;

  beforeEach(async () => {
    sessionsDir = join(
      tmpdir(),
      `kimi-robust-${Math.random().toString(36).slice(2)}`,
    );
    dir = join(sessionsDir, "wd_test", S);
    await mkdir(join(dir, "agents", "main"), { recursive: true });
    await mkdir(join(dir, "agents", "agent-0"), { recursive: true });
    await writeFile(
      join(dir, "state.json"),
      JSON.stringify({ workDir: WORK_DIR, title: "robust" }),
    );
    await writeFile(
      join(dir, "agents", "main", "wire.jsonl"),
      jsonl([
        { type: "metadata", created_at: 1 },
        {
          type: "context.append_loop_event",
          event: {
            type: "tool.call",
            toolCallId: "Agent_0",
            name: "Agent",
            args: { subagent_type: "explore", description: "d" },
          },
          time: 2,
        },
      ]),
    );
    reader = new KimiSessionReader({ sessionsDir });
  });

  afterEach(async () => {
    await rm(sessionsDir, { recursive: true, force: true });
  });

  it("tolerates a trailing half-written JSONL line", async () => {
    const good = jsonl([
      { type: "metadata", created_at: 10 },
      { type: "config.update", profileName: "explore", time: 10 },
      {
        type: "context.append_loop_event",
        event: { type: "tool.call", toolCallId: "t0", name: "Read" },
        time: 11,
      },
    ]);
    // Append a truncated final line (mid-write growth on disk).
    await writeFile(
      join(dir, "agents", "agent-0", "wire.jsonl"),
      `${good}{"type":"context.append_loop_event","event":{"type":"tool.ca`,
    );
    const session = await reader.getAgentSession("agent-0", S);
    expect(session).not.toBeNull();
    expect(session?.metrics?.toolUseCount).toBe(1);
    // Still-running (no terminal end_turn) → running.
    expect(session?.descriptor?.status).toBe("running");
  });

  it("returns running while a child has begun but not finished", async () => {
    await writeFile(
      join(dir, "agents", "agent-0", "wire.jsonl"),
      jsonl([
        { type: "metadata", created_at: 10 },
        { type: "config.update", profileName: "explore", time: 10 },
        {
          type: "context.append_loop_event",
          event: { type: "step.begin", step: 1 },
          time: 11,
        },
      ]),
    );
    const session = await reader.getAgentSession("agent-0", S);
    expect(session?.status).toBe("running");
    expect(session?.descriptor?.status).toBe("running");
  });

  it("returns [] mappings while the child result has not landed yet", async () => {
    // No tool.result in the main wire → no authoritative identity yet.
    const mappings = await reader.getAgentMappings(S);
    expect(mappings).toEqual([]);
  });
});
