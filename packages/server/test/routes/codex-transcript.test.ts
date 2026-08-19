import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import type { AuthService } from "../../src/auth/AuthService.js";
import {
  type CodexEventStore,
  InMemoryCodexEventStore,
  JsonlCodexEventStore,
} from "../../src/codex-events/index.js";
import {
  type CodexTranscriptStoreSource,
  createCodexTranscriptRoutes,
  createDefaultCodexTranscriptStoreSources,
} from "../../src/routes/codex-transcript.js";
import { MockClaudeSDK } from "../../src/sdk/mock.js";
import { testDraft } from "../codex-events/helpers.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

describe("canonical Codex transcript route", () => {
  it("exports Markdown by default with hardened attachment headers", async () => {
    const store = await seededStore("session-1", "canonical answer");
    const routes = createCodexTranscriptRoutes({
      sources: [fixedSource("provider", store)],
    });

    const first = await routes.request("/session-1/codex-transcript");
    const second = await routes.request("/session-1/codex-transcript");

    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8",
    );
    expect(first.headers.get("content-disposition")).toBe(
      'attachment; filename="codex-transcript-session-1.md"',
    );
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect(first.headers.get("x-content-type-options")).toBe("nosniff");
    expect(first.headers.get("x-yep-codex-transcript-source")).toBe("provider");
    expect(first.headers.get("x-yep-codex-transcript-source-kind")).toBe(
      "provider",
    );
    expect(first.headers.get("x-yep-codex-transcript-coverage")).toBe(
      "retained-complete-prefix",
    );
    expect(first.headers.get("x-yep-codex-transcript-fallback")).toBe(
      "rollout",
    );
    expect(first.headers.get("x-yep-codex-transcript-truncated")).toBe("false");
    const firstBody = await first.text();
    expect(firstBody).toContain("canonical answer");
    expect(await second.text()).toBe(firstBody);
  });

  it("exports structured JSON only when explicitly requested", async () => {
    const store = await seededStore("session-json", "json answer");
    const routes = createCodexTranscriptRoutes({
      sources: [fixedSource("provider", store)],
    });

    const response = await routes.request(
      "/session-json/codex-transcript?format=json",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="codex-transcript-session-json.json"',
    );
    const body = (await response.json()) as {
      schema: { name: string; version: number };
      sessionId: string;
      source: { kind: string; eventCount: number };
    };
    expect(body).toMatchObject({
      schema: { name: "yep.codex-canonical-transcript", version: 1 },
      sessionId: "session-json",
      source: { kind: "canonical_replay", eventCount: 2 },
    });
  });

  it("rejects unbounded or ambiguous route input with typed codes", async () => {
    const routes = createCodexTranscriptRoutes({ sources: [] });

    const badFormat = await routes.request(
      "/session-1/codex-transcript?format=html",
    );
    expect(badFormat.status).toBe(400);
    await expect(badFormat.json()).resolves.toMatchObject({
      code: "INVALID_CODEX_TRANSCRIPT_FORMAT",
    });

    const badSession = await routes.request("/bad%20session/codex-transcript");
    expect(badSession.status).toBe(400);
    await expect(badSession.json()).resolves.toMatchObject({
      code: "INVALID_CODEX_TRANSCRIPT_SESSION_ID",
    });
  });

  it("returns a typed 404 instead of falling back to legacy session files", async () => {
    const routes = createCodexTranscriptRoutes({
      sources: [fixedSource("provider", new InMemoryCodexEventStore())],
    });

    const response = await routes.request("/legacy-only/codex-transcript");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "No canonical Codex events found for this session",
      code: "CODEX_CANONICAL_TRANSCRIPT_NOT_FOUND",
    });
  });

  it("uses deterministic source precedence without mixing sequence spaces", async () => {
    const provider = await seededStore("shared-session", "provider answer");
    const bridge = await seededStore("shared-session", "bridge answer");
    const routes = createCodexTranscriptRoutes({
      sources: [
        fixedSource("provider", provider),
        fixedSource("bridge", bridge),
      ],
    });

    const response = await routes.request("/shared-session/codex-transcript");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-yep-codex-transcript-source")).toBe(
      "provider",
    );
    expect(body).toContain("provider answer");
    expect(body).not.toContain("bridge answer");
  });

  it("falls back to the bridge canonical journal when provider has no events", async () => {
    const bridge = await seededStore("bridge-session", "bridge answer");
    const routes = createCodexTranscriptRoutes({
      sources: [
        fixedSource("provider", new InMemoryCodexEventStore()),
        fixedSource("bridge", bridge),
      ],
    });

    const response = await routes.request("/bridge-session/codex-transcript");

    expect(response.status).toBe(200);
    expect(response.headers.get("x-yep-codex-transcript-source")).toBe(
      "bridge",
    );
    expect(await response.text()).toContain("bridge answer");
  });

  it("fails closed with bounded, non-sensitive store and event-limit errors", async () => {
    const failingStore = {
      replay: vi.fn(async () => {
        throw new Error("/test/private/codex-events.jsonl");
      }),
    } as unknown as CodexEventStore;
    const failedRoutes = createCodexTranscriptRoutes({
      sources: [fixedSource("provider", failingStore)],
    });
    const failed = await failedRoutes.request("/session-1/codex-transcript");
    expect(failed.status).toBe(500);
    const failedBody = await failed.text();
    expect(failedBody).toContain("CODEX_TRANSCRIPT_READ_FAILED");
    expect(failedBody).not.toContain("/test/private");

    const oversizedStore = {
      getStorageBytes: vi.fn(async () => 513 * 1024 * 1024),
      latestEventAtMs: vi.fn(),
      replay: vi.fn(),
    } as unknown as CodexEventStore;
    const oversizedRoutes = createCodexTranscriptRoutes({
      sources: [fixedSource("provider", oversizedStore)],
    });
    const oversized = await oversizedRoutes.request(
      "/session-1/codex-transcript",
    );
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({
      code: "CODEX_EVENT_SOURCE_ADMISSION_EXCEEDED",
      source: "unavailable",
      coverage: "unavailable",
      fallback: "rollout",
    });
    expect(oversizedStore.latestEventAtMs).not.toHaveBeenCalled();
    expect(oversizedStore.replay).not.toHaveBeenCalled();

    const boundedStore = await seededStore("bounded-session", "answer");
    const boundedRoutes = createCodexTranscriptRoutes({
      sources: [fixedSource("provider", boundedStore)],
      maxEvents: 1,
    });
    const bounded = await boundedRoutes.request(
      "/bounded-session/codex-transcript",
    );
    expect(bounded.status).toBe(413);
    await expect(bounded.json()).resolves.toMatchObject({
      code: "CODEX_TRANSCRIPT_EVENT_LIMIT_EXCEEDED",
      maxEvents: 1,
    });
  });

  it("creates fresh production file stores so later appends are visible", async () => {
    const dataDir = await makeTemporaryDirectory();
    const sources = createDefaultCodexTranscriptStoreSources({ dataDir });
    const routes = createCodexTranscriptRoutes({ sources });

    const beforeAppend = await routes.request(
      "/fresh-session/codex-transcript",
    );
    expect(beforeAppend.status).toBe(404);

    const writer = new JsonlCodexEventStore({
      filePath: join(dataDir, "codex-events", "events.jsonl"),
      now: () => 7_000,
    });
    await seed(writer, "fresh-session", "fresh answer");

    const afterAppend = await routes.request("/fresh-session/codex-transcript");
    expect(afterAppend.status).toBe(200);
    expect(afterAppend.headers.get("x-yep-codex-transcript-source")).toBe(
      "provider",
    );
    expect(await afterAppend.text()).toContain("fresh answer");
  });

  it("reads the production bridge journal as the ordered file fallback", async () => {
    const dataDir = await makeTemporaryDirectory();
    const writer = new JsonlCodexEventStore({
      filePath: join(dataDir, "codex-bridge", "codex-events.jsonl"),
      now: () => 8_000,
    });
    await seed(writer, "bridge-file-session", "bridge file answer");
    const routes = createCodexTranscriptRoutes({
      sources: createDefaultCodexTranscriptStoreSources({ dataDir }),
    });

    const response = await routes.request(
      "/bridge-file-session/codex-transcript",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-yep-codex-transcript-source")).toBe(
      "bridge",
    );
    expect(await response.text()).toContain("bridge file answer");
  });
});

describe("canonical Codex transcript app integration", () => {
  it("mounts the production data-dir journal behind global API auth", async () => {
    const dataDir = await makeTemporaryDirectory();
    const projectsDir = join(dataDir, "projects");
    await mkdir(projectsDir, { recursive: true });
    const writer = new JsonlCodexEventStore({
      filePath: join(dataDir, "codex-events", "events.jsonl"),
      now: () => 9_000,
    });
    await seed(writer, "authenticated-session", "authenticated answer");

    const validateSession = vi.fn(async (sessionId: string) => {
      return sessionId === "valid-session";
    });
    const authService = {
      isEnabled: () => true,
      hasAccount: () => true,
      validateSession,
    } as unknown as AuthService;
    const { app } = createApp({
      sdk: new MockClaudeSDK(),
      projectsDir,
      dataDir,
      authService,
    });

    const unauthenticated = await app.fetch(
      new Request(
        "http://localhost/api/sessions/authenticated-session/codex-transcript",
      ),
      {},
    );
    expect(unauthenticated.status).toBe(401);

    const authenticated = await app.fetch(
      new Request(
        "http://localhost/api/sessions/authenticated-session/codex-transcript",
        {
          headers: {
            Cookie: "yep-anywhere-session=valid-session",
          },
        },
      ),
      {},
    );
    expect(authenticated.status).toBe(200);
    expect(validateSession).toHaveBeenCalledWith("valid-session");
    expect(authenticated.headers.get("x-yep-codex-transcript-source")).toBe(
      "provider",
    );
    expect(await authenticated.text()).toContain("authenticated answer");
  });
});

function fixedSource(
  id: string,
  store: CodexEventStore,
): CodexTranscriptStoreSource {
  return { id, createStore: () => store };
}

async function seededStore(
  sessionId: string,
  answer: string,
): Promise<InMemoryCodexEventStore> {
  const store = new InMemoryCodexEventStore({ now: () => 5_000 });
  await seed(store, sessionId, answer);
  return store;
}

async function seed(
  store: CodexEventStore,
  sessionId: string,
  answer: string,
): Promise<void> {
  const suffix = randomUUID();
  await store.append(
    testDraft(
      "turn/started",
      {
        threadId: sessionId,
        turn: {
          id: `turn-${suffix}`,
          status: "inProgress",
          items: [],
          startedAt: 1,
        },
      },
      {
        sessionId,
        eventId: `turn-${suffix}`,
        receivedAtMs: 1_000,
      },
    ),
  );
  await store.append(
    testDraft(
      "item/completed",
      {
        threadId: sessionId,
        turnId: `turn-${suffix}`,
        item: {
          id: `answer-${suffix}`,
          type: "agentMessage",
          phase: "final_answer",
          text: answer,
        },
      },
      {
        sessionId,
        eventId: `answer-${suffix}`,
        receivedAtMs: 2_000,
      },
    ),
  );
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-transcript-route-"));
  temporaryDirectories.push(directory);
  return directory;
}
