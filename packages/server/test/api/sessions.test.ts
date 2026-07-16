import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import type { SessionMetadataService } from "../../src/metadata/index.js";
import { MockClaudeSDK, createMockScenario } from "../../src/sdk/mock.js";
import { encodeProjectId } from "../../src/supervisor/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures", "agents");

describe("Sessions API", () => {
  let mockSdk: MockClaudeSDK;
  let testDir: string;
  let projectId: string;
  let sessionDir: string;

  beforeEach(async () => {
    mockSdk = new MockClaudeSDK();
    // Create temp directory structure with a valid project. The projectPath
    // must exist on disk because the spawn wrapper in ClaudeProvider now
    // pre-validates the cwd to avoid the SDK's misleading "binary failed to
    // launch" error when the working directory is missing.
    testDir = join(tmpdir(), `claude-test-${randomUUID()}`);
    const projectPath = join(testDir, "myproject");
    await mkdir(projectPath, { recursive: true });
    projectId = encodeProjectId(projectPath);
    const encodedPath = projectPath.replaceAll("/", "-");
    sessionDir = join(testDir, "localhost", encodedPath);

    await mkdir(sessionDir, { recursive: true });
    // Session file must include cwd field for project path discovery
    await writeFile(
      join(sessionDir, "sess-existing.jsonl"),
      `{"type":"user","cwd":"${projectPath}","message":{"content":"Hello"}}\n`,
    );
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("POST /api/projects/:projectId/sessions", () => {
    it("returns 400 if message is missing", async () => {
      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });

      const res = await app.request(`/api/projects/${projectId}/sessions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Yep-Anywhere": "true",
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("Message is required");
    });

    it("returns 400 for invalid JSON", async () => {
      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });

      const res = await app.request(`/api/projects/${projectId}/sessions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Yep-Anywhere": "true",
        },
        body: "not json",
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("Invalid JSON body");
    });

    it("returns 404 for unknown project", async () => {
      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });

      const res = await app.request("/api/projects/unknown/sessions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Yep-Anywhere": "true",
        },
        body: JSON.stringify({ message: "hello" }),
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toMatch(/Project not found/);
    });

    it("returns 400 for invalid executor alias", async () => {
      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });

      const res = await app.request(`/api/projects/${projectId}/sessions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Yep-Anywhere": "true",
        },
        body: JSON.stringify({
          message: "hello",
          executor: "-oProxyCommand=touch_/tmp/pwned",
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("executor must be a valid SSH host alias");
    });

    it("starts a session and returns processId", async () => {
      mockSdk.addScenario(createMockScenario("new-session", "Hello!"));
      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });

      const res = await app.request(`/api/projects/${projectId}/sessions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Yep-Anywhere": "true",
        },
        body: JSON.stringify({ message: "hello" }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.sessionId).toBeDefined();
      expect(json.processId).toBeDefined();
    });

    it("starts the displayed Claude default with an explicit Sonnet model", async () => {
      mockSdk.addScenario(createMockScenario("new-session", "Hello!"));
      const { app, supervisor } = createApp({
        sdk: mockSdk,
        projectsDir: testDir,
      });
      const startSession = vi.spyOn(supervisor, "startSession");

      const res = await app.request(`/api/projects/${projectId}/sessions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Yep-Anywhere": "true",
        },
        body: JSON.stringify({
          message: "hello",
          provider: "claude",
          model: "default",
        }),
      });

      expect(res.status).toBe(200);
      expect(startSession).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ text: "hello" }),
        undefined,
        expect.objectContaining({
          model: "sonnet",
          providerName: "claude",
        }),
      );
    });

    it("accepts permission mode parameter", async () => {
      mockSdk.addScenario(createMockScenario("new-session", "Hello!"));
      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });

      const res = await app.request(`/api/projects/${projectId}/sessions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Yep-Anywhere": "true",
        },
        body: JSON.stringify({ message: "hello", mode: "acceptEdits" }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.sessionId).toBeDefined();
      expect(json.processId).toBeDefined();
    });

    it("returns permissionMode and modeVersion in response", async () => {
      mockSdk.addScenario(createMockScenario("new-session", "Hello!"));
      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });

      const res = await app.request(`/api/projects/${projectId}/sessions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Yep-Anywhere": "true",
        },
        body: JSON.stringify({ message: "hello", mode: "acceptEdits" }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.permissionMode).toBe("acceptEdits");
      expect(json.modeVersion).toBe(0);
    });

    it("returns auto permissionMode when not specified", async () => {
      mockSdk.addScenario(createMockScenario("new-session", "Hello!"));
      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });

      const res = await app.request(`/api/projects/${projectId}/sessions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Yep-Anywhere": "true",
        },
        body: JSON.stringify({ message: "hello" }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.permissionMode).toBe("auto");
      expect(json.modeVersion).toBe(0);
    });
  });

  describe("GET /api/projects/:projectId/sessions/:sessionId", () => {
    it("returns pendingInputRequest for a persisted Claude AskUserQuestion", async () => {
      await writeFile(
        join(sessionDir, "sess-question.jsonl"),
        [
          JSON.stringify({
            type: "user",
            uuid: "user-1",
            parentUuid: null,
            message: { role: "user", content: "Find the old flow" },
          }),
          JSON.stringify({
            type: "assistant",
            uuid: "assistant-1",
            parentUuid: "user-1",
            timestamp: "2026-06-30T01:02:03.000Z",
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "Which flow did you mean?" },
                {
                  type: "tool_use",
                  id: "toolu-question",
                  name: "AskUserQuestion",
                  input: {
                    questions: [
                      {
                        question: "Which flow did you mean?",
                        header: "Flow",
                        multiSelect: false,
                        options: [
                          { label: "JumpServer", description: "Use devssh" },
                          { label: "MCP", description: "Use transfer tools" },
                        ],
                      },
                    ],
                  },
                },
              ],
            },
          }),
        ].join("\n"),
      );
      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });

      const res = await app.request(
        `/api/projects/${projectId}/sessions/sess-question`,
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.pendingInputRequest).toMatchObject({
        id: "toolu-question",
        sessionId: "sess-question",
        type: "question",
        prompt: "Which flow did you mean?",
        toolName: "AskUserQuestion",
        source: "persisted",
      });
      expect(
        json.pendingInputRequest.toolInput.questions[0].options,
      ).toHaveLength(2);
    });
  });

  describe("POST /api/projects/:projectId/sessions/:sessionId/resume", () => {
    it("returns 400 if message is missing", async () => {
      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });

      const res = await app.request(
        `/api/projects/${projectId}/sessions/sess-123/resume`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Yep-Anywhere": "true",
          },
          body: JSON.stringify({}),
        },
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("Message is required");
    });

    it("returns 404 for unknown project", async () => {
      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });

      const res = await app.request(
        "/api/projects/unknown/sessions/sess-123/resume",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Yep-Anywhere": "true",
          },
          body: JSON.stringify({ message: "hello" }),
        },
      );

      expect(res.status).toBe(404);
    });

    it("returns 400 for invalid executor alias", async () => {
      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });

      const res = await app.request(
        `/api/projects/${projectId}/sessions/sess-123/resume`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Yep-Anywhere": "true",
          },
          body: JSON.stringify({
            message: "continue",
            executor: "-oProxyCommand=touch_/tmp/pwned",
          }),
        },
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("executor must be a valid SSH host alias");
    });

    it("resumes a session and returns processId", async () => {
      mockSdk.addScenario(createMockScenario("sess-123", "Resumed!"));
      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });

      const res = await app.request(
        `/api/projects/${projectId}/sessions/sess-123/resume`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Yep-Anywhere": "true",
          },
          body: JSON.stringify({ message: "continue" }),
        },
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.processId).toBeDefined();
    });

    it("passes Codex rollbackNumTurns when resuming an edited Codex prompt", async () => {
      const sessionMetadataService = {
        getProvider: vi.fn(() => "codex"),
        getExecutor: vi.fn(() => undefined),
      };
      const { app, supervisor } = createApp({
        sdk: mockSdk,
        projectsDir: testDir,
        sessionMetadataService:
          sessionMetadataService as unknown as SessionMetadataService,
      });
      const resumeSpy = vi
        .spyOn(supervisor, "resumeSession")
        .mockResolvedValue({
          id: "process-codex",
          permissionMode: "default",
          modeVersion: 0,
        } as unknown as Awaited<ReturnType<typeof supervisor.resumeSession>>);

      const res = await app.request(
        `/api/projects/${projectId}/sessions/sess-existing/resume`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Yep-Anywhere": "true",
          },
          body: JSON.stringify({
            message: "q2-1",
            rollbackNumTurns: 2,
          }),
        },
      );

      expect(res.status).toBe(200);
      expect(resumeSpy).toHaveBeenCalledWith(
        "sess-existing",
        expect.any(String),
        expect.objectContaining({ text: "q2-1" }),
        undefined,
        expect.objectContaining({
          providerName: "codex",
          rollbackNumTurns: 2,
          resumeSessionAt: undefined,
        }),
      );
    });

    it("does not pass Codex rollbackNumTurns when resuming Claude", async () => {
      const sessionMetadataService = {
        getProvider: vi.fn(() => "claude"),
        getExecutor: vi.fn(() => undefined),
      };
      const { app, supervisor } = createApp({
        sdk: mockSdk,
        projectsDir: testDir,
        sessionMetadataService:
          sessionMetadataService as unknown as SessionMetadataService,
      });
      const resumeSpy = vi
        .spyOn(supervisor, "resumeSession")
        .mockResolvedValue({
          id: "process-claude",
          permissionMode: "default",
          modeVersion: 0,
        } as unknown as Awaited<ReturnType<typeof supervisor.resumeSession>>);

      const res = await app.request(
        `/api/projects/${projectId}/sessions/sess-existing/resume`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Yep-Anywhere": "true",
          },
          body: JSON.stringify({
            message: "q2-1",
            resumeSessionAt: "parent-uuid",
            rollbackNumTurns: 2,
          }),
        },
      );

      expect(res.status).toBe(200);
      expect(resumeSpy).toHaveBeenCalledWith(
        "sess-existing",
        expect.any(String),
        expect.objectContaining({ text: "q2-1" }),
        undefined,
        expect.objectContaining({
          providerName: "claude",
          rollbackNumTurns: undefined,
          resumeSessionAt: "parent-uuid",
        }),
      );
    });

    it("returns the OpenCode fork id and copies session metadata to it", async () => {
      const sessionMetadataService = {
        getProvider: vi.fn(() => "opencode"),
        getExecutor: vi.fn(() => undefined),
        setProvider: vi.fn(async () => undefined),
        setOpenCodeConfig: vi.fn(async () => undefined),
        setCreatedBy: vi.fn(async () => undefined),
      };
      const { app, supervisor } = createApp({
        sdk: mockSdk,
        projectsDir: testDir,
        sessionMetadataService:
          sessionMetadataService as unknown as SessionMetadataService,
      });
      const resumeSpy = vi
        .spyOn(supervisor, "resumeSession")
        .mockResolvedValue({
          id: "process-opencode-fork",
          sessionId: "ses_opencode_fork",
          permissionMode: "acceptEdits",
          modeVersion: 3,
        } as unknown as Awaited<ReturnType<typeof supervisor.resumeSession>>);
      const opencodeConfig = {
        model: "glm-5.2",
        requestProtocol: "anthropic" as const,
        limits: { context: 200_000, output: 16_000 },
      };

      const res = await app.request(
        `/api/projects/${projectId}/sessions/sess-existing/resume`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Yep-Anywhere": "true",
          },
          body: JSON.stringify({
            message: "edited OpenCode prompt",
            mode: "acceptEdits",
            resumeSessionAt: "msg_native_user",
            opencodeConfig,
          }),
        },
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        sessionId: "ses_opencode_fork",
        processId: "process-opencode-fork",
      });
      expect(resumeSpy).toHaveBeenCalledWith(
        "sess-existing",
        expect.any(String),
        expect.objectContaining({ text: "edited OpenCode prompt" }),
        "acceptEdits",
        expect.objectContaining({
          providerName: "opencode",
          resumeSessionAt: "msg_native_user",
          rollbackNumTurns: undefined,
          opencodeConfig,
        }),
      );
      expect(sessionMetadataService.setProvider).toHaveBeenCalledWith(
        "ses_opencode_fork",
        "opencode",
      );
      expect(sessionMetadataService.setOpenCodeConfig).toHaveBeenCalledWith(
        "ses_opencode_fork",
        opencodeConfig,
      );
      expect(sessionMetadataService.setCreatedBy).toHaveBeenCalledWith(
        "ses_opencode_fork",
        "yep",
      );
    });

    it("returns 400 for non-integer rollbackNumTurns", async () => {
      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });

      const res = await app.request(
        `/api/projects/${projectId}/sessions/sess-existing/resume`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Yep-Anywhere": "true",
          },
          body: JSON.stringify({
            message: "continue",
            rollbackNumTurns: 1.5,
          }),
        },
      );

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("rollbackNumTurns must be a positive integer");
    });

    it("accepts permission mode parameter", async () => {
      mockSdk.addScenario(createMockScenario("sess-123", "Resumed!"));
      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });

      const res = await app.request(
        `/api/projects/${projectId}/sessions/sess-123/resume`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Yep-Anywhere": "true",
          },
          body: JSON.stringify({ message: "continue", mode: "plan" }),
        },
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.processId).toBeDefined();
    });

    it("returns permissionMode and modeVersion in response", async () => {
      mockSdk.addScenario(createMockScenario("sess-123", "Resumed!"));
      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });

      const res = await app.request(
        `/api/projects/${projectId}/sessions/sess-123/resume`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Yep-Anywhere": "true",
          },
          body: JSON.stringify({
            message: "continue",
            mode: "bypassPermissions",
          }),
        },
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.permissionMode).toBe("bypassPermissions");
      expect(json.modeVersion).toBe(0);
    });
  });

  describe("POST /api/sessions/:sessionId/messages", () => {
    it("returns 404 if no active process", async () => {
      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });

      const res = await app.request("/api/sessions/unknown/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Yep-Anywhere": "true",
        },
        body: JSON.stringify({ message: "hello" }),
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe("No active process for session");
    });
  });

  describe("GET /api/sessions/:sessionId/pending-input", () => {
    it("returns null request when no active process", async () => {
      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });

      const res = await app.request("/api/sessions/unknown/pending-input");
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.request).toBeNull();
    });
  });

  describe("POST /api/sessions/:sessionId/input", () => {
    it("returns 404 if no active process", async () => {
      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });

      const res = await app.request("/api/sessions/unknown/input", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Yep-Anywhere": "true",
        },
        body: JSON.stringify({ requestId: "req-1", response: "approve" }),
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe("No active process for session");
    });

    it("returns 400 if process is not waiting for input", async () => {
      // Create a session that immediately completes (not waiting for input)
      mockSdk.addScenario(createMockScenario("sess-no-wait", "Done!"));
      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });

      // Start the session
      const startRes = await app.request(
        `/api/projects/${projectId}/sessions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Yep-Anywhere": "true",
          },
          body: JSON.stringify({ message: "hello" }),
        },
      );
      expect(startRes.status).toBe(200);
      const { sessionId } = await startRes.json();

      // Wait for session to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Try to send input - should fail because process completed
      const inputRes = await app.request(`/api/sessions/${sessionId}/input`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Yep-Anywhere": "true",
        },
        body: JSON.stringify({ requestId: "req-1", response: "approve" }),
      });

      // Process likely terminated or not waiting
      expect([400, 404]).toContain(inputRes.status);
    });

    it("returns 400 for missing required fields", async () => {
      // Create a session with tool approval
      mockSdk.addScenario({
        messages: [
          { type: "system", subtype: "init", session_id: "sess-tool" },
          {
            type: "system",
            subtype: "input_request",
            input_request: {
              id: "req-tool-1",
              type: "tool-approval",
              prompt: "Allow Edit?",
            },
          },
        ],
        delayMs: 5,
      });
      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });

      // Start the session
      const startRes = await app.request(
        `/api/projects/${projectId}/sessions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Yep-Anywhere": "true",
          },
          body: JSON.stringify({ message: "hello" }),
        },
      );
      expect(startRes.status).toBe(200);
      const { sessionId } = await startRes.json();

      // Wait for session to enter waiting-input state
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Try to send input without requestId
      const inputRes = await app.request(`/api/sessions/${sessionId}/input`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Yep-Anywhere": "true",
        },
        body: JSON.stringify({ response: "approve" }),
      });

      expect(inputRes.status).toBe(400);
      const json = await inputRes.json();
      expect(json.error).toBe("requestId and response are required");
    });

    it("returns 400 for invalid requestId", async () => {
      // Create a session with tool approval
      mockSdk.addScenario({
        messages: [
          { type: "system", subtype: "init", session_id: "sess-tool" },
          {
            type: "system",
            subtype: "input_request",
            input_request: {
              id: "req-tool-1",
              type: "tool-approval",
              prompt: "Allow Edit?",
            },
          },
        ],
        delayMs: 5,
      });
      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });

      // Start the session
      const startRes = await app.request(
        `/api/projects/${projectId}/sessions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Yep-Anywhere": "true",
          },
          body: JSON.stringify({ message: "hello" }),
        },
      );
      expect(startRes.status).toBe(200);
      const { sessionId } = await startRes.json();

      // Wait for session to enter waiting-input state
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Try to send input with wrong requestId
      const inputRes = await app.request(`/api/sessions/${sessionId}/input`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Yep-Anywhere": "true",
        },
        body: JSON.stringify({ requestId: "wrong-id", response: "approve" }),
      });

      expect(inputRes.status).toBe(400);
      const json = await inputRes.json();
      expect(json.error).toBe("Invalid request ID or no pending request");
    });

    it("accepts approve response with correct requestId", async () => {
      const requestId = `req-${Date.now()}`;
      // Create a session with tool approval
      mockSdk.addScenario({
        messages: [
          { type: "system", subtype: "init", session_id: "sess-tool-approve" },
          {
            type: "system",
            subtype: "input_request",
            input_request: {
              id: requestId,
              type: "tool-approval",
              prompt: "Allow Edit?",
            },
          },
        ],
        delayMs: 5,
      });
      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });

      // Start the session
      const startRes = await app.request(
        `/api/projects/${projectId}/sessions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Yep-Anywhere": "true",
          },
          body: JSON.stringify({ message: "hello" }),
        },
      );
      expect(startRes.status).toBe(200);
      const { sessionId } = await startRes.json();

      // Wait for session to enter waiting-input state
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify pending input exists
      const pendingRes = await app.request(
        `/api/sessions/${sessionId}/pending-input`,
      );
      expect(pendingRes.status).toBe(200);
      const pendingJson = await pendingRes.json();
      expect(pendingJson.request).toBeDefined();
      expect(pendingJson.request.id).toBe(requestId);

      // Send approve
      const inputRes = await app.request(`/api/sessions/${sessionId}/input`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Yep-Anywhere": "true",
        },
        body: JSON.stringify({ requestId, response: "approve" }),
      });

      expect(inputRes.status).toBe(200);
      const json = await inputRes.json();
      expect(json.accepted).toBe(true);
    });

    it("accepts deny response with correct requestId", async () => {
      const requestId = `req-${Date.now()}`;
      // Create a session with tool approval
      mockSdk.addScenario({
        messages: [
          { type: "system", subtype: "init", session_id: "sess-tool-deny" },
          {
            type: "system",
            subtype: "input_request",
            input_request: {
              id: requestId,
              type: "tool-approval",
              prompt: "Allow Edit?",
            },
          },
        ],
        delayMs: 5,
      });
      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });

      // Start the session
      const startRes = await app.request(
        `/api/projects/${projectId}/sessions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Yep-Anywhere": "true",
          },
          body: JSON.stringify({ message: "hello" }),
        },
      );
      expect(startRes.status).toBe(200);
      const { sessionId } = await startRes.json();

      // Wait for session to enter waiting-input state
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Send deny
      const inputRes = await app.request(`/api/sessions/${sessionId}/input`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Yep-Anywhere": "true",
        },
        body: JSON.stringify({ requestId, response: "deny" }),
      });

      expect(inputRes.status).toBe(200);
      const json = await inputRes.json();
      expect(json.accepted).toBe(true);
    });
  });

  describe("GET /api/projects/:projectId/sessions/:sessionId/agents/:agentId", () => {
    it("returns agent messages for existing agent file", async () => {
      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });

      // Copy completed agent fixture to session directory
      const fixtureContent = await readFile(
        join(fixturesDir, "agent-completed.jsonl"),
        "utf-8",
      );
      await writeFile(
        join(sessionDir, "agent-test-agent.jsonl"),
        fixtureContent,
      );

      const res = await app.request(
        `/api/projects/${projectId}/sessions/sess-existing/agents/test-agent`,
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.messages).toBeDefined();
      expect(Array.isArray(json.messages)).toBe(true);
      expect(json.messages.length).toBeGreaterThan(0);
      expect(json.status).toBe("completed");
    });

    it("returns 200 with empty messages for unknown agent", async () => {
      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });

      const res = await app.request(
        `/api/projects/${projectId}/sessions/sess-existing/agents/unknown-agent`,
      );

      // Graceful handling - don't 404, just return empty
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.messages).toHaveLength(0);
      expect(json.status).toBe("pending");
    });

    it("returns 404 for unknown project", async () => {
      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });

      const res = await app.request(
        "/api/projects/unknown/sessions/sess-1/agents/agent-1",
      );

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe("Project not found");
    });

    it("infers status correctly for failed agent", async () => {
      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });

      const fixtureContent = await readFile(
        join(fixturesDir, "agent-failed.jsonl"),
        "utf-8",
      );
      await writeFile(
        join(sessionDir, "agent-failed-agent.jsonl"),
        fixtureContent,
      );

      const res = await app.request(
        `/api/projects/${projectId}/sessions/sess-existing/agents/failed-agent`,
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.status).toBe("failed");
    });

    it("infers status correctly for running agent", async () => {
      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });

      const fixtureContent = await readFile(
        join(fixturesDir, "agent-running.jsonl"),
        "utf-8",
      );
      await writeFile(
        join(sessionDir, "agent-running-agent.jsonl"),
        fixtureContent,
      );

      const res = await app.request(
        `/api/projects/${projectId}/sessions/sess-existing/agents/running-agent`,
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.status).toBe("running");
    });
  });
});
