import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ACPClient } from "../../../src/sdk/providers/acp/client.js";

type ACPClientInternals = {
  process: ChildProcess | null;
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
