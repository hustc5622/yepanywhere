import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEX_EVENT_RUNTIME_IDENTITY,
  CodexEventIngress,
  InMemoryCodexEventStore,
  JsonlCodexEventStore,
  resolveCodexEventJournalMode,
  shouldJournalCodexEvent,
} from "../../src/codex-events/index.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempFile(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), "codex-journal-mode-"));
  tempDirs.push(directory);
  return join(directory, name);
}

function notification(method: string, params: Record<string, unknown> = {}) {
  return { method, params };
}

describe("resolveCodexEventJournalMode", () => {
  it("defaults to lifecycle and accepts the documented modes", () => {
    expect(resolveCodexEventJournalMode(undefined)).toBe("lifecycle");
    expect(resolveCodexEventJournalMode("")).toBe("lifecycle");
    expect(resolveCodexEventJournalMode("nonsense")).toBe("lifecycle");
    expect(resolveCodexEventJournalMode(" FULL ")).toBe("full");
    expect(resolveCodexEventJournalMode("minimal")).toBe("minimal");
  });
});

describe("shouldJournalCodexEvent", () => {
  const notify = (method: string) => ({
    method,
    direction: "server_notification",
  });

  it("keeps everything in full mode", () => {
    expect(
      shouldJournalCodexEvent("full", notify("item/agentMessage/delta")),
    ).toBe(true);
  });

  it("drops only deltas in lifecycle mode", () => {
    for (const method of [
      "item/agentMessage/delta",
      "item/commandExecution/outputDelta",
      "turn/diff/updated",
    ]) {
      expect(shouldJournalCodexEvent("lifecycle", notify(method))).toBe(false);
    }
    for (const method of [
      "error",
      "turn/completed",
      "turn/started",
      "item/started",
      "item/completed",
      "thread/tokenUsage/updated",
    ]) {
      expect(shouldJournalCodexEvent("lifecycle", notify(method))).toBe(true);
    }
  });

  it("keeps request/response records in lifecycle mode", () => {
    // These carry the correlation identities the reducer needs and are rare.
    expect(
      shouldJournalCodexEvent("lifecycle", {
        method: "turn/start",
        direction: "client_request",
      }),
    ).toBe(true);
  });

  it("keeps only the always-on overlay methods in minimal mode", () => {
    expect(shouldJournalCodexEvent("minimal", notify("error"))).toBe(true);
    expect(shouldJournalCodexEvent("minimal", notify("turn/completed"))).toBe(
      true,
    );
    expect(shouldJournalCodexEvent("minimal", notify("item/completed"))).toBe(
      false,
    );
  });
});

describe("CodexEventIngress journal mode", () => {
  it("projects a delta without journalling it", async () => {
    const store = new InMemoryCodexEventStore();
    const ingress = await CodexEventIngress.create({
      store,
      runtime: CODEX_EVENT_RUNTIME_IDENTITY,
      sessionId: "session-1",
      journalMode: "lifecycle",
    });

    const delta = await ingress.ingestNotification(
      notification("item/agentMessage/delta", { delta: "hello" }),
    );

    // The envelope still exists, so the live projection is unchanged...
    expect(delta.method).toBe("item/agentMessage/delta");
    expect(ingress.notificationFromEvent(delta).params).toMatchObject({
      delta: "hello",
    });
    // ...but nothing was recorded, and it consumed no sequence.
    expect(delta.sequence).toBe(0);
    await expect(store.replay({ sessionId: "session-1" })).resolves.toEqual([]);
  });

  it("keeps journalled sequences dense when deltas are dropped", async () => {
    const store = new InMemoryCodexEventStore();
    const ingress = await CodexEventIngress.create({
      store,
      runtime: CODEX_EVENT_RUNTIME_IDENTITY,
      sessionId: "session-1",
      journalMode: "lifecycle",
    });

    await ingress.ingestNotification(notification("turn/started"));
    await ingress.ingestNotification(
      notification("item/agentMessage/delta", { delta: "a" }),
    );
    await ingress.ingestNotification(
      notification("item/agentMessage/delta", { delta: "b" }),
    );
    await ingress.ingestNotification(notification("turn/completed"));

    const journalled = await store.replay({ sessionId: "session-1" });
    expect(journalled.map((event) => event.method)).toEqual([
      "turn/started",
      "turn/completed",
    ]);
    // Dense sequences matter: a gap would be reported as a pruned journal
    // prefix by reportJournalGaps.
    expect(journalled.map((event) => event.sequence)).toEqual([1, 2]);
  });

  it("journals deltas when explicitly configured for full retention", async () => {
    const store = new InMemoryCodexEventStore();
    const ingress = await CodexEventIngress.create({
      store,
      runtime: CODEX_EVENT_RUNTIME_IDENTITY,
      sessionId: "session-1",
      journalMode: "full",
    });

    await ingress.ingestNotification(
      notification("item/agentMessage/delta", { delta: "a" }),
    );

    await expect(
      store.replay({ sessionId: "session-1" }),
    ).resolves.toHaveLength(1);
  });

  it("does not replay the journal for a fresh connection", async () => {
    const store = new InMemoryCodexEventStore();
    let replays = 0;
    const observed = new Proxy(store, {
      get(target, property, receiver) {
        if (property === "replay") {
          return (...args: Parameters<typeof target.replay>) => {
            replays += 1;
            return target.replay(...args);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });

    await CodexEventIngress.create({
      store: observed,
      runtime: CODEX_EVENT_RUNTIME_IDENTITY,
      sessionId: "session-1",
    });
    expect(replays).toBe(0);

    // A caller that manages its own connection id may be resuming, so the
    // journal still has to be consulted to restore its event counter.
    await CodexEventIngress.create({
      store: observed,
      runtime: CODEX_EVENT_RUNTIME_IDENTITY,
      sessionId: "session-1",
      connectionId: "bridge:1",
    });
    expect(replays).toBe(1);
  });
});

describe("JsonlCodexEventStore append-only mode", () => {
  it("continues sequences from an existing journal without retaining it", async () => {
    const filePath = tempFile("events.jsonl");

    const seed = new JsonlCodexEventStore({ filePath });
    const ingress = await CodexEventIngress.create({
      store: seed,
      runtime: CODEX_EVENT_RUNTIME_IDENTITY,
      sessionId: "session-1",
      journalMode: "lifecycle",
    });
    await ingress.ingestNotification(notification("turn/started"));
    await ingress.ingestNotification(notification("turn/completed"));

    const writer = new JsonlCodexEventStore({ filePath, appendOnly: true });
    const appendIngress = await CodexEventIngress.create({
      store: writer,
      runtime: CODEX_EVENT_RUNTIME_IDENTITY,
      sessionId: "session-1",
      journalMode: "lifecycle",
    });
    const next = await appendIngress.ingestNotification(
      notification("thread/status/changed"),
    );
    expect(next.sequence).toBe(3);

    // A separate reader instance sees the complete journal.
    const reader = new JsonlCodexEventStore({ filePath });
    const events = await reader.replay({ sessionId: "session-1" });
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(readFileSync(filePath, "utf8").trimEnd().split("\n")).toHaveLength(
      3,
    );
  });

  it("refuses to serve reads so a reader cannot attach to a writer", async () => {
    const writer = new JsonlCodexEventStore({
      filePath: tempFile("events.jsonl"),
      appendOnly: true,
    });
    await expect(writer.replay({ sessionId: "session-1" })).rejects.toThrow(
      /cannot replay/i,
    );
  });
});
