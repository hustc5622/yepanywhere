import { randomUUID } from "node:crypto";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CodexSessionEntry, UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeProjectId } from "../../src/projects/paths.js";
import { CodexSessionReader } from "../../src/sessions/codex-reader.js";
import { invalidateCodexSessionManifest } from "../../src/sessions/codex-session-manifest.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("CodexSessionReader - OSS Support", () => {
  let testDir: string;
  let reader: CodexSessionReader;

  beforeEach(async () => {
    testDir = join(tmpdir(), `codex-reader-oss-test-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
    reader = new CodexSessionReader({ sessionsDir: testDir });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    invalidateCodexSessionManifest(testDir);
    await rm(testDir, { recursive: true, force: true });
  });

  const createSessionFile = async (
    sessionId: string,
    provider: string | undefined,
    model: string | undefined,
    originator?: string,
    tokenUsage?: {
      totalInputTokens: number;
      totalCachedInputTokens?: number;
      lastInputTokens?: number;
      lastCachedInputTokens?: number;
      modelContextWindow?: number;
    },
    forkedFromId?: string,
  ) => {
    const metaPayload = {
      id: sessionId,
      cwd: "/test/project",
      timestamp: new Date().toISOString(),
      ...(provider ? { model_provider: provider } : {}),
      ...(originator ? { originator } : {}),
      ...(forkedFromId ? { forked_from_id: forkedFromId } : {}),
    };

    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: new Date().toISOString(),
        payload: metaPayload,
      }),
    ];

    if (model) {
      lines.push(
        JSON.stringify({
          type: "turn_context",
          timestamp: new Date().toISOString(),
          payload: { model },
        }),
      );
    }

    // Add a user message so it's a valid session with messages
    lines.push(
      JSON.stringify({
        type: "event_msg",
        timestamp: new Date().toISOString(),
        payload: {
          type: "user_message",
          message: "Hello world",
        },
      }),
    );

    if (tokenUsage) {
      lines.push(
        JSON.stringify({
          type: "event_msg",
          timestamp: new Date().toISOString(),
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: tokenUsage.totalInputTokens,
                cached_input_tokens: tokenUsage.totalCachedInputTokens ?? 0,
                output_tokens: 10,
                total_tokens: tokenUsage.totalInputTokens + 10,
              },
              ...(tokenUsage.lastInputTokens !== undefined && {
                last_token_usage: {
                  input_tokens: tokenUsage.lastInputTokens,
                  cached_input_tokens: tokenUsage.lastCachedInputTokens ?? 0,
                  output_tokens: 5,
                  total_tokens: tokenUsage.lastInputTokens + 5,
                },
              }),
              model_context_window: tokenUsage.modelContextWindow ?? 258400,
            },
          },
        }),
      );
    }

    await writeFile(
      join(testDir, `${sessionId}.jsonl`),
      `${lines.join("\n")}\n`,
    );
  };

  it("serves concurrent session file listings from the shared manifest", async () => {
    const sessionId = randomUUID();
    await createSessionFile(sessionId, "openai", "gpt-5");

    const [first, second] = await Promise.all([
      reader.listSessionFiles(testDir),
      reader.listSessionFiles(testDir),
    ]);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]?.sessionId).toBe(sessionId);
    expect(second[0]?.sessionId).toBe(sessionId);
  });

  it("preserves native thread/fork lineage in the session summary", async () => {
    const parentId = randomUUID();
    const childId = randomUUID();
    await createSessionFile(
      childId,
      "openai",
      "gpt-5",
      undefined,
      undefined,
      parentId,
    );

    await expect(
      reader.getSessionSummary(childId, "test-project" as UrlProjectId),
    ).resolves.toMatchObject({
      id: childId,
      forkParentSessionId: parentId,
    });
  });

  it("filters manifest session files by project path", async () => {
    const matchingSessionId = randomUUID();
    const otherSessionId = randomUUID();
    await createSessionFile(matchingSessionId, "openai", "gpt-5");

    const now = new Date().toISOString();
    await writeFile(
      join(testDir, `${otherSessionId}.jsonl`),
      `${[
        JSON.stringify({
          type: "session_meta",
          timestamp: now,
          payload: {
            id: otherSessionId,
            cwd: "/test/other-project",
            timestamp: now,
            model_provider: "openai",
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: now,
          payload: {
            type: "user_message",
            message: "Hello world",
          },
        }),
      ].join("\n")}\n`,
    );

    const filteredReader = new CodexSessionReader({
      sessionsDir: testDir,
      projectPath: "/test/project",
    });

    const sessions = await filteredReader.listSessionFiles(testDir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe(matchingSessionId);
  });

  it("keeps Codex collaboration children out of top-level session files", async () => {
    const parentId = randomUUID();
    const childId = randomUUID();
    await createSessionFile(parentId, "openai", "gpt-5");

    const now = new Date().toISOString();
    await writeFile(
      join(testDir, `${childId}.jsonl`),
      `${[
        JSON.stringify({
          type: "session_meta",
          timestamp: now,
          payload: {
            session_id: parentId,
            id: childId,
            // fork_turns="none" children do not need forked_from_id.
            parent_thread_id: parentId,
            cwd: "/test/project",
            timestamp: now,
            thread_source: "subagent",
            source: {
              subagent: {
                thread_spawn: {
                  parent_thread_id: parentId,
                  depth: 1,
                  agent_path: "/root/review",
                },
              },
            },
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: now,
          payload: {
            type: "user_message",
            message: "Review the parent changes",
          },
        }),
      ].join("\n")}\n`,
    );

    const sessions = await reader.listSessionFiles(testDir);
    expect(sessions.map((session) => session.sessionId)).toEqual([parentId]);
    expect(
      await reader.getSessionSummary(childId, "test-project" as UrlProjectId),
    ).toBeNull();
  });

  const createRollbackSessionFile = async (sessionId: string) => {
    const now = new Date().toISOString();
    const responseMessage = (
      role: "user" | "assistant",
      text: string,
      index: number,
    ) =>
      JSON.stringify({
        type: "response_item",
        timestamp: `2024-01-01T00:00:${String(index).padStart(2, "0")}Z`,
        payload: {
          type: "message",
          role,
          content: [
            {
              type: role === "user" ? "input_text" : "output_text",
              text,
            },
          ],
        },
      });

    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: now,
        payload: {
          id: sessionId,
          cwd: "/test/project",
          timestamp: now,
          model_provider: "openai",
        },
      }),
      responseMessage("user", "q1", 1),
      responseMessage("assistant", "a1", 2),
      responseMessage("user", "q2", 3),
      responseMessage("assistant", "a2", 4),
      responseMessage("user", "q3", 5),
      responseMessage("assistant", "a3", 6),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2024-01-01T00:00:07Z",
        payload: {
          type: "thread_rolled_back",
          num_turns: 2,
        },
      }),
      responseMessage("user", "q2-1", 8),
      responseMessage("assistant", "a2-1", 9),
    ];

    await writeFile(
      join(testDir, `${sessionId}.jsonl`),
      `${lines.join("\n")}\n`,
    );
  };

  const visibleMessageTexts = (entries: CodexSessionEntry[]) =>
    entries.flatMap((entry) => {
      if (entry.type !== "response_item") return [];
      if (entry.payload.type !== "message") return [];
      const firstContent = entry.payload.content[0];
      return firstContent && "text" in firstContent ? [firstContent.text] : [];
    });

  it("identifies session as codex-oss when model_provider is ollama", async () => {
    const sessionId = "oss-session-1";
    await createSessionFile(sessionId, "ollama", "mistral");

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary?.provider).toBe("codex-oss");

    const session = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(session?.data.provider).toBe("codex-oss");
  });

  it("identifies session as codex-oss when model_provider is local", async () => {
    const sessionId = "oss-session-2";
    await createSessionFile(sessionId, "local", "deepseek-coder");

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary?.provider).toBe("codex-oss");
  });

  it("identifies session as codex when model_provider is openai", async () => {
    const sessionId = "openai-session-1";
    await createSessionFile(sessionId, "openai", "gpt-4o");

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary?.provider).toBe("codex");
  });

  it("identifies DeepSeek cloud sessions as codex, not codex-oss", async () => {
    // model_provider=deepseek is a cloud Responses-API source; the "deepseek"
    // brand in the model name must not misroute it to the local OSS provider.
    const sessionId = "deepseek-cloud-1";
    await createSessionFile(sessionId, "deepseek", "deepseek-v4-flash");

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary?.provider).toBe("codex");
    expect(summary?.codexModelProvider).toBe("deepseek");

    const session = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(session?.data.provider).toBe("codex");
  });

  it("uses the latest visible entry timestamp for updatedAt", async () => {
    const sessionId = "touched-codex-session";
    const messageTime = new Date("2026-01-01T00:00:00.000Z");
    const metadataTime = new Date("2025-12-31T23:59:00.000Z");
    const nonVisibleTime = new Date("2026-01-01T00:05:00.000Z");
    const touchedTime = new Date("2026-01-01T00:10:00.000Z");
    const filePath = join(testDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: metadataTime.toISOString(),
        payload: {
          id: sessionId,
          cwd: "/test/project",
          timestamp: metadataTime.toISOString(),
          model_provider: "openai",
        },
      }),
      JSON.stringify({
        type: "turn_context",
        timestamp: nonVisibleTime.toISOString(),
        payload: { model: "gpt-5" },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: messageTime.toISOString(),
        payload: {
          type: "user_message",
          message: "Already read",
        },
      }),
    ];

    await writeFile(filePath, `${lines.join("\n")}\n`);
    await utimes(filePath, touchedTime, touchedTime);

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );

    expect(summary?.updatedAt).toBe(messageTime.toISOString());
  });

  it("extracts runtime config from the latest turn context", async () => {
    const sessionId = "runtime-config-session";
    const now = new Date().toISOString();
    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: now,
        payload: {
          id: sessionId,
          cwd: "/test/project",
          timestamp: now,
          model_provider: "openai",
        },
      }),
      JSON.stringify({
        type: "turn_context",
        timestamp: now,
        payload: {
          cwd: "/test/project",
          approval_policy: "on-request",
          model: "gpt-5.5",
          effort: "medium",
          service_tier: "standard",
        },
      }),
      JSON.stringify({
        type: "turn_context",
        timestamp: now,
        payload: {
          cwd: "/test/project",
          approval_policy: "on-request",
          model: "gpt-5.5",
          effort: "xhigh",
          service_tier: "fast",
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: now,
        payload: {
          type: "user_message",
          message: "Hello world",
        },
      }),
    ];

    await writeFile(
      join(testDir, `${sessionId}.jsonl`),
      `${lines.join("\n")}\n`,
    );

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary?.model).toBe("gpt-5.5");
    expect(summary?.reasoningEffort).toBe("xhigh");
    expect(summary?.serviceTier).toBe("fast");
  });

  it("falls back to codex-oss based on model name (llama)", async () => {
    const sessionId = "heuristic-session-1";
    await createSessionFile(sessionId, undefined, "llama-3-8b");

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary?.provider).toBe("codex-oss");
  });

  it("falls back to codex-oss based on model name (qwen)", async () => {
    const sessionId = "heuristic-session-2";
    await createSessionFile(sessionId, undefined, "qwen2.5-coder");

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary?.provider).toBe("codex-oss");
  });

  it("defaults to codex when no provider and unknown model", async () => {
    const sessionId = "unknown-session";
    await createSessionFile(sessionId, undefined, "unknown-model");

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary?.provider).toBe("codex");
  });

  it("filters mixed-slash Windows cwd variants as the same project", async () => {
    const sessionId = "windows-mixed-slash";
    await createSessionFile(
      sessionId,
      "openai",
      "gpt-4o",
      undefined,
      undefined,
    );

    await writeFile(
      join(testDir, `${sessionId}.jsonl`),
      `${[
        JSON.stringify({
          type: "session_meta",
          timestamp: new Date().toISOString(),
          payload: {
            id: sessionId,
            cwd: "C:\\Users\\kyle\\Documents\\webvam",
            timestamp: new Date().toISOString(),
            model_provider: "openai",
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: new Date().toISOString(),
          payload: {
            type: "user_message",
            message: "Hello world",
          },
        }),
      ].join("\n")}\n`,
    );

    const filteredReader = new CodexSessionReader({
      sessionsDir: testDir,
      projectPath: "c:/Users/kyle/Documents/webvam",
    });

    const summaries = await filteredReader.listSessions(
      encodeProjectId("C:/Users/kyle/Documents/webvam"),
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0].id).toBe(sessionId);
  });

  it("identifies codex based on model name (gpt-4)", async () => {
    const sessionId = "heuristic-openai";
    await createSessionFile(sessionId, undefined, "gpt-4-turbo");

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary?.provider).toBe("codex");
  });

  it("uses last_token_usage input_tokens for context usage", async () => {
    const sessionId = "context-last-usage";
    await createSessionFile(sessionId, "openai", "gpt-5.3-codex", undefined, {
      totalInputTokens: 236_673,
      totalCachedInputTokens: 116_000,
      lastInputTokens: 120_000,
      lastCachedInputTokens: 118_000,
      modelContextWindow: 258_000,
    });

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );

    expect(summary?.contextUsage?.inputTokens).toBe(120_000);
    expect(summary?.contextUsage?.percentage).toBe(47);
    expect(summary?.contextUsage?.contextWindow).toBe(258_000);
  });

  it("falls back to total_token_usage input_tokens when last_token_usage is absent", async () => {
    const sessionId = "context-total-fallback";
    await createSessionFile(sessionId, "openai", "gpt-5.3-codex", undefined, {
      totalInputTokens: 85_000,
      totalCachedInputTokens: 40_000,
      modelContextWindow: 258_000,
    });

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );

    expect(summary?.contextUsage?.inputTokens).toBe(85_000);
    expect(summary?.contextUsage?.percentage).toBe(33);
  });

  it("uses compacted total_tokens when post-compaction input_tokens is zero", async () => {
    const sessionId = "context-post-compact-total";
    const now = new Date().toISOString();
    const lines: CodexSessionEntry[] = [
      {
        type: "session_meta",
        timestamp: now,
        payload: {
          id: sessionId,
          cwd: "/test/project",
          timestamp: now,
          model_provider: "openai",
        },
      },
      {
        type: "turn_context",
        timestamp: now,
        payload: { model: "gpt-5.3-codex" },
      },
      {
        type: "event_msg",
        timestamp: now,
        payload: {
          type: "user_message",
          message: "Hello world",
        },
      },
      {
        type: "event_msg",
        timestamp: "2024-01-01T00:00:01.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 227_243,
              cached_input_tokens: 0,
              output_tokens: 100,
              total_tokens: 227_343,
            },
            last_token_usage: {
              input_tokens: 227_243,
              cached_input_tokens: 0,
              output_tokens: 100,
              total_tokens: 227_343,
            },
            model_context_window: 258_000,
          },
          rate_limits: null,
        },
      },
      {
        type: "compacted",
        timestamp: "2024-01-01T00:00:02.000Z",
        payload: {
          message: "",
          replacement_history: [],
        },
      },
      {
        type: "event_msg",
        timestamp: "2024-01-01T00:00:02.004Z",
        payload: {
          type: "context_compacted",
        },
      },
      {
        type: "event_msg",
        timestamp: "2024-01-01T00:00:02.010Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 0,
              cached_input_tokens: 0,
              output_tokens: 0,
              total_tokens: 7_945,
            },
            last_token_usage: {
              input_tokens: 0,
              cached_input_tokens: 0,
              output_tokens: 0,
              total_tokens: 7_945,
            },
            model_context_window: 258_000,
          },
          rate_limits: null,
        },
      },
    ];

    await writeFile(
      join(testDir, `${sessionId}.jsonl`),
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    );

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );

    expect(summary?.contextUsage?.inputTokens).toBe(7_945);
    expect(summary?.contextUsage?.percentage).toBe(3);
    expect(summary?.contextUsage?.contextWindow).toBe(258_000);
    expect(summary?.compactCount).toBe(1);
    expect(summary?.compactEvents).toEqual([
      expect.objectContaining({
        timestamp: "2024-01-01T00:00:02.000Z",
        beforeTokens: 227_243,
        afterTokens: 7_945,
        reclaimedTokens: 219_298,
        trigger: "compacted",
      }),
    ]);
    expect(summary?.cumulativeUsage?.totalTokens).toBe(235_288);
    expect(summary?.cumulativeUsage?.inputTokens).toBe(227_243);
    expect(summary?.cumulativeUsage?.turnCount).toBe(2);
  });

  it("does not double-count monotonic Codex totals around compaction events", async () => {
    const sessionId = "context-post-compact-monotonic-total";
    const now = new Date().toISOString();
    const lines: CodexSessionEntry[] = [
      {
        type: "session_meta",
        timestamp: now,
        payload: {
          id: sessionId,
          cwd: "/test/project",
          timestamp: now,
          model_provider: "openai",
        },
      },
      {
        type: "event_msg",
        timestamp: now,
        payload: {
          type: "user_message",
          message: "Hello world",
        },
      },
      {
        type: "event_msg",
        timestamp: "2024-01-01T00:00:01.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 17_761_457,
              cached_input_tokens: 17_338_240,
              output_tokens: 38_570,
              total_tokens: 17_800_027,
            },
            last_token_usage: {
              input_tokens: 214_208,
              cached_input_tokens: 210_304,
              output_tokens: 403,
              total_tokens: 214_611,
            },
          },
          rate_limits: null,
        },
      },
      {
        type: "compacted",
        timestamp: "2024-01-01T00:00:02.000Z",
        payload: {
          message: "",
          replacement_history: [],
        },
      },
      {
        type: "event_msg",
        timestamp: "2024-01-01T00:00:02.004Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 17_761_457,
              cached_input_tokens: 17_338_240,
              output_tokens: 38_570,
              total_tokens: 17_800_027,
            },
            last_token_usage: {
              input_tokens: 0,
              cached_input_tokens: 0,
              output_tokens: 0,
              total_tokens: 7_375,
            },
          },
          rate_limits: null,
        },
      },
      {
        type: "event_msg",
        timestamp: "2024-01-01T00:00:02.006Z",
        payload: {
          type: "context_compacted",
        },
      },
      {
        type: "event_msg",
        timestamp: "2024-01-01T00:00:03.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 17_804_129,
              cached_input_tokens: 17_363_584,
              output_tokens: 39_713,
              total_tokens: 17_843_842,
            },
            last_token_usage: {
              input_tokens: 26_227,
              cached_input_tokens: 16_256,
              output_tokens: 471,
              total_tokens: 26_698,
            },
          },
          rate_limits: null,
        },
      },
    ];

    await writeFile(
      join(testDir, `${sessionId}.jsonl`),
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    );

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );

    expect(summary?.compactCount).toBe(1);
    expect(summary?.compactEvents).toEqual([
      expect.objectContaining({
        timestamp: "2024-01-01T00:00:02.000Z",
        beforeTokens: 214_208,
        afterTokens: 7_375,
        reclaimedTokens: 206_833,
        trigger: "compacted",
      }),
    ]);
    expect(summary?.cumulativeUsage?.totalTokens).toBe(17_843_842);
    expect(summary?.cumulativeUsage?.inputTokens).toBe(440_545);
    expect(summary?.cumulativeUsage?.cacheReadTokens).toBe(17_363_584);
    expect(summary?.cumulativeUsage?.turnCount).toBe(3);
  });

  it("excludes developer messages from messageCount", async () => {
    const sessionId = "developer-filter";
    const now = new Date().toISOString();
    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: now,
        payload: {
          id: sessionId,
          cwd: "/test/project",
          timestamp: now,
          model_provider: "openai",
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: now,
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "internal instructions" }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: now,
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "visible response" }],
        },
      }),
    ];

    await writeFile(
      join(testDir, `${sessionId}.jsonl`),
      `${lines.join("\n")}\n`,
    );

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary?.messageCount).toBe(1);
  });

  it("hides Codex rollout entries removed by thread_rolled_back markers", async () => {
    const sessionId = "rollback-visible-branch";
    await createRollbackSessionFile(sessionId);

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary?.provider).toBe("codex");
    expect(summary?.messageCount).toBe(4);

    const session = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(session).not.toBeNull();
    expect(visibleMessageTexts(session?.data.session.entries ?? [])).toEqual([
      "q1",
      "a1",
      "q2-1",
      "a2-1",
    ]);

    const oldQ2Branch = session?.codexBranchState?.branches.find(
      (branch) => branch.prompt === "q2",
    );
    expect(oldQ2Branch?.siblingCount).toBe(2);

    const oldBranchSession = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
      undefined,
      { branchId: oldQ2Branch?.id },
    );
    expect(
      visibleMessageTexts(oldBranchSession?.data.session.entries ?? []),
    ).toEqual(["q1", "a1", "q2", "a2", "q3", "a3"]);
  });

  it("falls back to a rolled-back Codex branch prompt when visible title is setup-only", async () => {
    const sessionId = "rollback-setup-only-title";
    const now = new Date().toISOString();
    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: now,
        payload: {
          id: sessionId,
          cwd: "/test/project",
          timestamp: now,
          model_provider: "openai",
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2024-01-01T00:00:01Z",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "# AGENTS.md instructions for /test/project\n\n<INSTRUCTIONS />",
            },
          ],
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2024-01-01T00:00:02Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "../eval-platform" }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2024-01-01T00:00:03Z",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "<turn_aborted>\nThe user interrupted.\n</turn_aborted>",
            },
          ],
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2024-01-01T00:00:04Z",
        payload: {
          type: "turn_aborted",
          turn_id: "turn-1",
          reason: "interrupted",
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2024-01-01T00:00:05Z",
        payload: {
          type: "thread_rolled_back",
          num_turns: 1,
        },
      }),
    ];

    await writeFile(
      join(testDir, `${sessionId}.jsonl`),
      `${lines.join("\n")}\n`,
    );

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary?.title).toBe("../eval-platform");
    expect(summary?.fullTitle).toBe("../eval-platform");

    const session = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(session?.codexBranchState?.branches[0]?.prompt).toBe(
      "../eval-platform",
    );
    expect(visibleMessageTexts(session?.data.session.entries ?? [])).toEqual([
      "# AGENTS.md instructions for /test/project\n\n<INSTRUCTIONS />",
    ]);
  });

  it("preserves originator from session metadata", async () => {
    const sessionId = "originator-passthrough";
    await createSessionFile(sessionId, "openai", "gpt-4o", "yep-anywhere");

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary?.originator).toBe("yep-anywhere");
  });
});
