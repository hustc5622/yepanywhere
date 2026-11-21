import type { SessionDisplaySnapshot } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type DisplaySourcePage,
  SessionDisplayService,
} from "../../src/display/SessionDisplayService.js";
import type { Message } from "../../src/supervisor/types.js";

/**
 * Pi and MiniMax Code publish tool blocks live and read prose back from the
 * session file. A mid-turn insert is the exception: it is a plain user prompt
 * with no tool blocks, and the persisted read cannot carry Yep's client
 * identity. It must therefore stream immediately, then be re-keyed to the
 * persisted row instead of duplicated.
 */
const selection = { projectId: "project", sessionId: "session" };

function questions(snapshot: SessionDisplaySnapshot) {
  return snapshot.nodes.flatMap((node) =>
    node.type === "question" ? [node.question] : [],
  );
}

const services: SessionDisplayService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
});

function fixture() {
  let push: (type: string, data: unknown) => void = () => {};
  const initial: DisplaySourcePage = {
    provider: "pi",
    messages: [
      {
        uuid: "run-user",
        type: "user",
        message: { role: "user", content: "Run the tests" },
      },
      {
        uuid: "run-assistant",
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "tool-1", name: "bash" }],
        },
      },
    ] as Message[],
    activity: "running",
    stamp: "1",
  };
  const source = {
    stamp: vi.fn(async () => "1"),
    read: vi.fn(async () => initial),
    detail: vi.fn(async () => [] as Message[]),
  };
  const runtime = {
    getProcessForSession: vi.fn(async () => ({ id: "process" }) as never),
    subscribeSession: vi.fn(async (_id: string, emit: typeof push) => {
      push = emit;
      return { cleanup: vi.fn() };
    }),
  };
  const service = new SessionDisplayService({ runtime, pollMs: 60_000 });
  service.configureSource(source);
  services.push(service);
  return {
    service,
    source,
    push: (type: string, data: unknown) => push(type, data),
  };
}

function optimisticPrompt(
  text: string,
  tempId: string,
  uuid: string,
  timestamp = new Date().toISOString(),
) {
  return {
    type: "user",
    uuid,
    clientUserMessageId: uuid,
    tempId,
    timestamp,
    isOptimistic: true,
    message: { role: "user", content: text },
  };
}

describe("SessionDisplayService pi mid-turn prompts", () => {
  it("shows an inserted prompt before it is persisted", async () => {
    const { service, push } = fixture();
    await service.subscribe(selection, vi.fn());

    push("message", optimisticPrompt("insert this", "t2", "client-2"));

    const shown = questions(await service.snapshot(selection));
    expect(shown.map((question) => question.content)).toContain("insert this");
    expect(shown.at(-1)?.tempId).toBe("t2");
  });

  it("still drops live assistant prose, which the persisted read supplies", async () => {
    const { service, push } = fixture();
    await service.subscribe(selection, vi.fn());

    push("message", {
      type: "assistant",
      uuid: "live-prose",
      message: { role: "assistant", content: "streamed prose" },
    });

    expect(JSON.stringify(await service.snapshot(selection))).not.toContain(
      "streamed prose",
    );
  });

  it("adopts the client identity when the persisted prompt arrives", async () => {
    const { service, source, push } = fixture();
    await service.subscribe(selection, vi.fn());
    push("message", optimisticPrompt("insert this", "t2", "client-2"));

    // Pi persisted the insert under its own entry id and never stored Yep's.
    source.read.mockResolvedValue({
      provider: "pi",
      messages: [
        {
          uuid: "run-user",
          type: "user",
          message: { role: "user", content: "Run the tests" },
        },
        {
          uuid: "run-assistant",
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "tool-1", name: "bash" }],
          },
        },
        {
          uuid: "insert-entry",
          type: "user",
          message: { role: "user", content: "insert this" },
        },
      ] as Message[],
      activity: "running",
      stamp: "2",
    });
    source.stamp.mockResolvedValue("2");
    push("message", { type: "result", uuid: "step-done" });

    await vi.waitFor(async () => {
      const shown = questions(await service.snapshot(selection));
      expect(shown).toHaveLength(2);
      expect(shown.at(-1)).toMatchObject({
        messageId: "insert-entry",
        tempId: "t2",
        clientUserMessageId: "client-2",
      });
    });
  });

  it("drops an insert the provider never persisted once the turn settles", async () => {
    const { service, source, push } = fixture();
    await service.subscribe(selection, vi.fn());
    // The prompt was published long enough ago that its turn has ended.
    push(
      "message",
      optimisticPrompt(
        "dropped insert",
        "t3",
        "client-3",
        new Date(Date.now() - 60_000).toISOString(),
      ),
    );

    // An aborted turn clears Pi's steering queue without persisting it.
    source.read.mockResolvedValue({
      provider: "pi",
      messages: [
        {
          uuid: "run-user",
          type: "user",
          message: { role: "user", content: "Run the tests" },
        },
      ] as Message[],
      activity: "completed",
      stamp: "2",
    });
    source.stamp.mockResolvedValue("2");
    push("message", { type: "result", uuid: "step-done" });

    await vi.waitFor(async () => {
      const shown = questions(await service.snapshot(selection));
      expect(shown.map((question) => question.content)).toEqual([
        "Run the tests",
      ]);
    });
  });
});
