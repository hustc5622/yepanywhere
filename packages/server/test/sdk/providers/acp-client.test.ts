import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { ACPClient } from "../../../src/sdk/providers/acp/client.js";

type ACPConnectionStub = {
  loadSession: (params: unknown) => Promise<unknown>;
  resumeSession: (params: unknown) => Promise<unknown>;
};

type ACPClientInternals = {
  process: ChildProcess | null;
  connection: ACPConnectionStub | null;
};

function setChildState(
  client: ACPClient,
  state: {
    pid?: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    killed: boolean;
  } | null,
): void {
  (client as unknown as ACPClientInternals).process = state as ChildProcess;
}

function setConnection(client: ACPClient, connection: ACPConnectionStub): void {
  (client as unknown as ACPClientInternals).connection = connection;
}

describe("ACPClient process liveness", () => {
  it("reports a running child as alive", () => {
    const client = new ACPClient();
    setChildState(client, {
      pid: 123,
      exitCode: null,
      signalCode: null,
      killed: false,
    });

    expect(client.isAlive()).toBe(true);
  });

  it.each([
    {
      name: "exited normally",
      state: {
        pid: 123,
        exitCode: 0,
        signalCode: null,
        killed: false,
      },
    },
    {
      name: "terminated by an external signal",
      state: {
        pid: 123,
        exitCode: null,
        signalCode: "SIGTERM" as const,
        killed: false,
      },
    },
    {
      name: "was killed by this client",
      state: {
        pid: 123,
        exitCode: null,
        signalCode: null,
        killed: true,
      },
    },
    {
      name: "never spawned",
      state: null,
    },
  ])("reports a child that $name as dead", ({ state }) => {
    const client = new ACPClient();
    setChildState(client, state);

    expect(client.isAlive()).toBe(false);
  });
});

describe("ACPClient session lifecycle", () => {
  it("includes the required MCP server list when loading a session", async () => {
    const loadSession = vi.fn().mockResolvedValue({});
    const client = new ACPClient();
    setConnection(client, {
      loadSession,
      resumeSession: vi.fn(),
    });

    await client.loadSession("session-1", "/tmp/project");

    expect(loadSession).toHaveBeenCalledWith({
      sessionId: "session-1",
      cwd: "/tmp/project",
      mcpServers: [],
    });
  });

  it("uses the stable session/resume method", async () => {
    const resumeSession = vi.fn().mockResolvedValue({});
    const client = new ACPClient();
    setConnection(client, {
      loadSession: vi.fn(),
      resumeSession,
    });

    await expect(
      client.resumeSession("session-1", "/tmp/project"),
    ).resolves.toBe("session-1");
    expect(resumeSession).toHaveBeenCalledWith({
      sessionId: "session-1",
      cwd: "/tmp/project",
      mcpServers: [],
    });
  });
});
