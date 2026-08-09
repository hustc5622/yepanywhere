import type { CodexSessionEntry, UrlProjectId } from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import {
  type CodexEventStore,
  type CodexEventStoreSource,
  InMemoryCodexEventStore,
} from "../../src/codex-events/index.js";
import type { SessionInteractionService } from "../../src/interactions/SessionInteractionService.js";
import {
  type SessionsDeps,
  createSessionsRoutes,
} from "../../src/routes/sessions.js";
import type { LoadedSession } from "../../src/sessions/types.js";
import type { Project } from "../../src/supervisor/types.js";
import { testDraft } from "../codex-events/helpers.js";

const projectId = "proj-1" as UrlProjectId;
const sessionId = "session-1";

describe("sessions route canonical Codex refresh overlay", () => {
  it("uses the provider-first journal without mixing bridge sequences", async () => {
    const providerStore = await seededStore(
      "thread-provider",
      "turn-provider",
      "agent-provider",
      "provider answer",
    );
    const bridgeStore = await seededStore(
      "thread-bridge",
      "turn-bridge",
      "agent-bridge",
      "bridge answer",
    );
    const bridgeReplay = vi.spyOn(bridgeStore, "replay");
    const routes = createTestRoutes("provider answer", [
      fixedSource("provider", providerStore),
      fixedSource("bridge", bridgeStore),
    ]);

    const response = await routes.request(
      `/projects/${projectId}/sessions/${sessionId}`,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toMatchObject({
      type: "assistant",
      codexCanonicalRefresh: true,
      codexThreadId: "thread-provider",
      codexTurnId: "turn-provider",
      codexThreadItemLifecycle: "completed",
      codexThreadItem: {
        id: "agent-provider",
        type: "agentMessage",
        text: "provider answer",
      },
    });
    expect(JSON.stringify(body)).not.toContain("bridge answer");
    expect(bridgeReplay).not.toHaveBeenCalled();
  });

  it("keeps the normalized legacy response unchanged without a journal", async () => {
    const routes = createTestRoutes("legacy answer", []);

    const response = await routes.request(
      `/projects/${projectId}/sessions/${sessionId}`,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toMatchObject({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "legacy answer" }],
      },
    });
    expect(body.messages[0].codexThreadItem).toBeUndefined();
    expect(body.messages[0].codexCanonicalRefresh).toBeUndefined();
  });

  it("falls back to normalized rollout when the canonical journal is unreadable", async () => {
    const failingStore = {
      replay: vi.fn(async () => {
        throw new Error("synthetic canonical read failure");
      }),
    } as unknown as CodexEventStore;
    const routes = createTestRoutes("legacy fallback", [
      fixedSource("provider", failingStore),
    ]);

    const response = await routes.request(
      `/projects/${projectId}/sessions/${sessionId}`,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.messages[0]?.message?.content).toMatchObject([
      { type: "text", text: "legacy fallback" },
    ]);
    expect(body.messages[0]?.codexCanonicalRefresh).toBeUndefined();
  });

  it("keeps canonical refresh responses path-free without mutating rollout input", async () => {
    const managedPath = "/tmp/yep-test/uploads/session-1/report.pdf";
    const prompt = `Review report\n\nUser uploaded files:\n- report.pdf (4.0 KB, application/pdf): ${managedPath}`;
    const entries: CodexSessionEntry[] = [
      {
        type: "response_item",
        timestamp: "2026-08-08T00:00:00.500Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: prompt }],
        },
      },
      {
        type: "response_item",
        timestamp: "2026-08-08T00:00:01.000Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "provider answer" }],
        },
      },
    ];
    const providerStore = await seededStore(
      "thread-provider",
      "turn-provider",
      "agent-provider",
      "provider answer",
    );
    const routes = createTestRoutes(
      "provider answer",
      [fixedSource("provider", providerStore)],
      { entries, title: prompt },
    );

    const response = await routes.request(
      `/projects/${projectId}/sessions/${sessionId}`,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    const serialized = JSON.stringify(body);
    expect(serialized).toContain("[managed attachment]");
    expect(serialized).not.toContain(managedPath);
    expect(body.session.title).not.toContain(managedPath);
    expect(JSON.stringify(entries)).toContain(managedPath);
  });
});

function fixedSource(
  id: string,
  store: CodexEventStore,
): CodexEventStoreSource {
  return { id, createStore: () => store };
}

async function seededStore(
  threadId: string,
  turnId: string,
  itemId: string,
  text: string,
): Promise<InMemoryCodexEventStore> {
  const store = new InMemoryCodexEventStore({ now: () => 2_000 });
  await store.append(
    testDraft(
      "item/completed",
      {
        threadId,
        turnId,
        item: {
          id: itemId,
          type: "agentMessage",
          text,
          phase: "final_answer",
        },
      },
      { sessionId, eventId: `${itemId}-event` },
    ),
  );
  return store;
}

function createTestRoutes(
  text: string,
  codexEventStoreSources: readonly CodexEventStoreSource[],
  options: { entries?: CodexSessionEntry[]; title?: string } = {},
) {
  const project: Project = {
    id: projectId,
    path: "/tmp/codex-project",
    name: "codex-project",
    sessionCount: 1,
    sessionDir: "/tmp/codex-sessions",
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
    provider: "codex",
  };
  const entries: CodexSessionEntry[] = options.entries ?? [
    {
      type: "response_item",
      timestamp: "2026-08-08T00:00:01.000Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    },
  ];
  const loaded: LoadedSession = {
    summary: {
      id: sessionId,
      projectId,
      title: options.title ?? "Codex session",
      fullTitle: options.title ?? "Codex session",
      createdAt: "2026-08-08T00:00:00.000Z",
      updatedAt: "2026-08-08T00:00:01.000Z",
      messageCount: entries.length,
      ownership: { owner: "none" },
      provider: "codex",
    },
    data: {
      provider: "codex",
      session: { entries },
    },
  };

  return createSessionsRoutes({
    supervisor: {} as SessionsDeps["supervisor"],
    runtimeController: {
      getProcessSnapshotForSession: vi.fn(async () => null),
      wasEverOwned: vi.fn(async () => false),
    } as unknown as NonNullable<SessionsDeps["runtimeController"]>,
    sessionInteractionService: {
      getPendingInput: vi.fn(async () => null),
    } as unknown as SessionInteractionService,
    scanner: {
      getOrCreateProject: vi.fn(async () => project),
    } as unknown as SessionsDeps["scanner"],
    readerFactory: vi.fn(
      () =>
        ({
          getSession: vi.fn(async () => structuredClone(loaded)),
        }) as unknown as ReturnType<SessionsDeps["readerFactory"]>,
    ),
    codexEventStoreSources,
  });
}
