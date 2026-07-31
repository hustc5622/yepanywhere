import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeProjectId } from "../../src/projects/paths.js";
import {
  KimiSessionReader,
  parseKimiSubagentIds,
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
          { toolUseId: "Agent_0", agentId: "agent-0" },
          { toolUseId: "Agent_1", agentId: "agent-1" },
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
    it("loads a completed subagent transcript", async () => {
      const session = await reader.getAgentSession("agent-1", SESSION_ID);
      expect(session).not.toBeNull();
      expect(session?.status).toBe("completed");
      expect(session?.messages.length).toBeGreaterThan(0);
    });

    it("marks an interrupted subagent as failed", async () => {
      const session = await reader.getAgentSession("agent-0", SESSION_ID);
      expect(session?.status).toBe("failed");
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
