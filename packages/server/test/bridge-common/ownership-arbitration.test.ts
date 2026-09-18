import { describe, expect, it } from "vitest";
import {
  BridgeHttpClient,
  type BridgePollEntry,
  type BridgePollReason,
  type BridgePollState,
} from "../../src/bridge-common/BridgeHttpClient.js";
import type { BridgeStatusBase } from "../../src/bridge-common/types.js";
import { type BusEvent, EventBus } from "../../src/watcher/index.js";

const PROJECT_ID = "cHJvamVjdA" as BusEvent extends { projectId: infer P }
  ? P
  : never;

type TestState = BridgePollState;

/**
 * Minimal concrete bridge client: the poll snapshot is supplied by the test so
 * the lifecycle diff (and the ownership arbitration inside it) can be driven
 * deterministically, without a sidecar or timers.
 */
class TestBridgeClient extends BridgeHttpClient<BridgeStatusBase, TestState> {
  private entries: BridgePollEntry<TestState>[] = [];

  setEntries(entries: BridgePollEntry<TestState>[]): void {
    this.entries = entries;
  }

  protected unavailableStatus(): BridgeStatusBase {
    return { running: false } as unknown as BridgeStatusBase;
  }

  protected async collectPollEntries(
    _reason: BridgePollReason,
  ): Promise<BridgePollEntry<TestState>[]> {
    return this.entries;
  }

  /** Run one full poll cycle, as the interval timer would. */
  async poll(): Promise<void> {
    await (
      this as unknown as {
        pollSessions(reason: BridgePollReason): Promise<void>;
      }
    ).pollSessions("interval");
  }

  getStatus(): BridgeStatusBase {
    return this.unavailableStatus();
  }
  listSessions(): never[] {
    return [];
  }
  listSessionViews(): never[] {
    return [];
  }
  getSessionView(): null {
    return null;
  }
  isSessionActive(): boolean {
    return false;
  }
  getPendingInputRequest(): null {
    return null;
  }
}

function activeEntry(sessionId: string): BridgePollEntry<TestState> {
  return {
    id: sessionId,
    view: {
      session: { id: sessionId, projectId: PROJECT_ID },
    } as unknown as BridgePollEntry<TestState>["view"],
    state: { projectId: PROJECT_ID, active: true },
  };
}

function setup(ownedSessionIds: string[]) {
  const eventBus = new EventBus();
  const events: BusEvent[] = [];
  eventBus.subscribe((event) => events.push(event));

  const client = new TestBridgeClient({
    baseUrl: "http://127.0.0.1:0",
    eventBus,
    authToken: "test-token",
  });
  const owned = new Set(ownedSessionIds);
  // Mirrors the external-runtime resolver installed by createApp: the answer
  // requires a round trip to another process, so it resolves asynchronously.
  client.setOwnershipResolver(async (sessionId) => {
    await Promise.resolve();
    return owned.has(sessionId);
  });

  const ownershipEvents = () =>
    events.filter((event) => event.type === "session-status-changed");

  return { client, events, ownershipEvents };
}

describe("bridge ownership arbitration with an async resolver", () => {
  it("stays silent about ownership for sessions the runtime owns", async () => {
    const sessionId = "runtime-owned";
    const { client, ownershipEvents } = setup([sessionId]);
    client.setEntries([activeEntry(sessionId)]);

    await client.poll();

    // The runtime drives this session's ownership. A bridge-emitted
    // external/none here is what produces the stuck "external session" banner.
    expect(ownershipEvents()).toEqual([]);
  });

  it("still reports ownership for sessions the runtime does not own", async () => {
    const sessionId = "genuinely-external";
    const { client, ownershipEvents } = setup([]);
    client.setEntries([activeEntry(sessionId)]);

    await client.poll();

    expect(ownershipEvents()).toHaveLength(1);
    expect(ownershipEvents()[0]).toMatchObject({
      sessionId,
      ownership: { owner: "external" },
    });
  });

  it("does not announce ownership when an owned session disappears", async () => {
    const sessionId = "runtime-owned-then-gone";
    const { client, ownershipEvents } = setup([sessionId]);

    client.setEntries([activeEntry(sessionId)]);
    await client.poll();
    client.setEntries([]);
    await client.poll();

    expect(ownershipEvents()).toEqual([]);
  });

  it("announces `none` when an unowned session disappears", async () => {
    const sessionId = "external-then-gone";
    const { client, ownershipEvents } = setup([]);

    client.setEntries([activeEntry(sessionId)]);
    await client.poll();
    client.setEntries([]);
    await client.poll();

    expect(ownershipEvents().map((event) => event.ownership)).toEqual([
      { owner: "external" },
      { owner: "none" },
    ]);
  });

  it("keeps the per-session emit sequence intact across the await", async () => {
    const sessionId = "ordering";
    const { client, events } = setup([]);
    client.setEntries([activeEntry(sessionId)]);

    await client.poll();

    // session-created must still precede the ownership event for the same
    // session: resolving ownership before emitting is what preserves this.
    expect(events.map((event) => event.type)).toEqual([
      "session-created",
      "session-status-changed",
      "process-state-changed",
    ]);
  });

  it("treats an unreachable runtime as not owned instead of aborting the poll", async () => {
    const sessionId = "resolver-throws";
    const eventBus = new EventBus();
    const events: BusEvent[] = [];
    eventBus.subscribe((event) => events.push(event));
    const client = new TestBridgeClient({
      baseUrl: "http://127.0.0.1:0",
      eventBus,
      authToken: "test-token",
    });
    client.setOwnershipResolver(async () => {
      throw new Error("runtime unreachable");
    });
    client.setEntries([activeEntry(sessionId)]);

    await expect(client.poll()).resolves.toBeUndefined();
    expect(
      events.filter((event) => event.type === "session-status-changed"),
    ).toHaveLength(1);
  });
});
