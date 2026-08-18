import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionMetadataService } from "../../src/metadata/SessionMetadataService.js";
import { encodeProjectId } from "../../src/projects/paths.js";

describe("SessionMetadataService", () => {
  let testDir: string;
  let service: SessionMetadataService;

  beforeEach(async () => {
    testDir = join(tmpdir(), `claude-metadata-test-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
    service = new SessionMetadataService({ dataDir: testDir });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("initialization", () => {
    it("starts with empty state when file doesn't exist", async () => {
      await service.initialize();

      expect(service.getAllMetadata()).toEqual({});
    });

    it("creates file on first update when file doesn't exist", async () => {
      await service.initialize();
      await service.setTitle("session-1", "My Custom Title");

      const content = await readFile(
        join(testDir, "session-metadata.json"),
        "utf-8",
      );
      const state = JSON.parse(content);
      expect(state.version).toBe(2);
      expect(state.sessions["session-1"]).toBeDefined();
      expect(state.sessions["session-1"].customTitle).toBe("My Custom Title");
    });

    it("loads existing state from JSON file", async () => {
      const existingState = {
        version: 1,
        sessions: {
          "session-1": { customTitle: "Test Title" },
          "session-2": { isArchived: true },
          "session-3": { customTitle: "Archived One", isArchived: true },
        },
      };
      await writeFile(
        join(testDir, "session-metadata.json"),
        JSON.stringify(existingState),
      );

      await service.initialize();

      expect(service.getMetadata("session-1")).toEqual({
        customTitle: "Test Title",
      });
      expect(service.getMetadata("session-2")).toEqual({ isArchived: true });
      expect(service.getMetadata("session-3")).toEqual({
        customTitle: "Archived One",
        isArchived: true,
      });
    });

    it("retains but does not reactivate a retired persisted provider", async () => {
      await writeFile(
        join(testDir, "session-metadata.json"),
        JSON.stringify({
          version: 2,
          sessions: {
            legacy: { provider: "opencode", customTitle: "Keep this" },
            current: { provider: "codex" },
          },
        }),
      );

      await service.initialize();

      expect(service.getMetadata("legacy")).toMatchObject({
        provider: "opencode",
        customTitle: "Keep this",
      });
      expect(service.getPersistedProvider("legacy")).toBe("opencode");
      expect(service.getProvider("legacy")).toBeUndefined();
      expect(service.getProvider("current")).toBe("codex");
    });

    it("handles corrupted JSON gracefully", async () => {
      await writeFile(
        join(testDir, "session-metadata.json"),
        "not valid json{{{",
      );

      // Should not throw
      await service.initialize();

      // Should start fresh
      expect(service.getAllMetadata()).toEqual({});
    });
  });

  describe("setTitle", () => {
    it("sets custom title for a session", async () => {
      await service.initialize();

      await service.setTitle("session-1", "My Project Work");

      expect(service.getMetadata("session-1")).toEqual({
        customTitle: "My Project Work",
      });
    });

    it("trims whitespace from title", async () => {
      await service.initialize();

      await service.setTitle("session-1", "  Padded Title  ");

      expect(service.getMetadata("session-1")?.customTitle).toBe(
        "Padded Title",
      );
    });

    it("clears title when empty string provided", async () => {
      await service.initialize();
      await service.setTitle("session-1", "Initial Title");

      await service.setTitle("session-1", "");

      expect(service.getMetadata("session-1")).toBeUndefined();
    });

    it("clears title when undefined provided", async () => {
      await service.initialize();
      await service.setTitle("session-1", "Initial Title");

      await service.setTitle("session-1", undefined);

      expect(service.getMetadata("session-1")).toBeUndefined();
    });

    it("preserves archived status when updating title", async () => {
      await service.initialize();
      await service.setArchived("session-1", true);

      await service.setTitle("session-1", "New Title");

      expect(service.getMetadata("session-1")).toEqual({
        customTitle: "New Title",
        isArchived: true,
      });
    });

    it("persists title to disk", async () => {
      await service.initialize();
      await service.setTitle("session-1", "Persistent Title");

      // Create new instance and verify it loads the persisted data
      const newService = new SessionMetadataService({ dataDir: testDir });
      await newService.initialize();

      expect(newService.getMetadata("session-1")?.customTitle).toBe(
        "Persistent Title",
      );
    });
  });

  describe("setArchived", () => {
    it("sets archived status for a session", async () => {
      await service.initialize();

      await service.setArchived("session-1", true);

      expect(service.getMetadata("session-1")).toEqual({ isArchived: true });
    });

    it("clears archived status when set to false", async () => {
      await service.initialize();
      await service.setArchived("session-1", true);

      await service.setArchived("session-1", false);

      expect(service.getMetadata("session-1")).toBeUndefined();
    });

    it("preserves custom title when updating archived status", async () => {
      await service.initialize();
      await service.setTitle("session-1", "My Title");

      await service.setArchived("session-1", true);

      expect(service.getMetadata("session-1")).toEqual({
        customTitle: "My Title",
        isArchived: true,
      });
    });

    it("persists archived status to disk", async () => {
      await service.initialize();
      await service.setArchived("session-1", true);

      const newService = new SessionMetadataService({ dataDir: testDir });
      await newService.initialize();

      expect(newService.getMetadata("session-1")?.isArchived).toBe(true);
    });
  });

  describe("setPermissionMode", () => {
    it("persists a session mode across service restarts", async () => {
      await service.initialize();
      await service.setPermissionMode("session-1", "bypassPermissions");

      const reloaded = new SessionMetadataService({ dataDir: testDir });
      await reloaded.initialize();

      expect(reloaded.getPermissionMode("session-1")).toBe("bypassPermissions");
    });

    it("clears the mode without removing other metadata", async () => {
      await service.initialize();
      await service.setTitle("session-1", "Keep me");
      await service.setPermissionMode("session-1", "plan");

      await service.setPermissionMode("session-1", undefined);

      expect(service.getMetadata("session-1")).toEqual({
        customTitle: "Keep me",
      });
    });
  });

  describe("setAiTitle", () => {
    it("sets AI title for a session", async () => {
      await service.initialize();

      await service.setAiTitle("session-1", "Short Title");

      expect(service.getMetadata("session-1")).toEqual({
        aiTitle: "Short Title",
      });
    });

    it("trims whitespace from AI title", async () => {
      await service.initialize();

      await service.setAiTitle("session-1", "  Short Title  ");

      expect(service.getMetadata("session-1")?.aiTitle).toBe("Short Title");
    });

    it("preserves custom title when updating AI title", async () => {
      await service.initialize();
      await service.setTitle("session-1", "Manual Title");

      await service.setAiTitle("session-1", "AI Title");

      expect(service.getMetadata("session-1")).toEqual({
        customTitle: "Manual Title",
        aiTitle: "AI Title",
      });
    });

    it("persists AI title to disk", async () => {
      await service.initialize();
      await service.setAiTitle("session-1", "Persistent AI Title");

      const newService = new SessionMetadataService({ dataDir: testDir });
      await newService.initialize();

      expect(newService.getMetadata("session-1")?.aiTitle).toBe(
        "Persistent AI Title",
      );
    });
  });

  describe("setCreatedBy", () => {
    it("persists creation source to disk", async () => {
      await service.initialize();
      await service.setCreatedBy("session-1", "yep");

      const newService = new SessionMetadataService({ dataDir: testDir });
      await newService.initialize();

      expect(newService.getMetadata("session-1")?.createdBy).toBe("yep");
    });

    it("clears creation source when undefined", async () => {
      await service.initialize();
      await service.setCreatedBy("session-1", "yep");

      await service.setCreatedBy("session-1", undefined);

      expect(service.getMetadata("session-1")).toBeUndefined();
    });
  });

  describe("setOrigin", () => {
    it("persists channel ownership without chat or user identity", async () => {
      await service.initialize();
      await service.setOrigin("session-1", {
        createdBy: "channel",
        originChannel: "feishu",
      });

      const reloaded = new SessionMetadataService({ dataDir: testDir });
      await reloaded.initialize();
      expect(reloaded.getMetadata("session-1")).toMatchObject({
        createdBy: "channel",
        originChannel: "feishu",
      });
      const serialized = JSON.stringify(reloaded.getMetadata("session-1"));
      expect(serialized).not.toContain("chat_fixture");
      expect(serialized).not.toContain("user_fixture");
    });
  });

  describe("fork lineage", () => {
    it("persists a child-to-source relationship without aliasing the source", async () => {
      await service.initialize();
      await service.setProvider("source-session", "codex");
      await service.setForkParentSessionId("child-session", "source-session");

      const reloaded = new SessionMetadataService({ dataDir: testDir });
      await reloaded.initialize();

      expect(reloaded.getForkParentSessionId("child-session")).toBe(
        "source-session",
      );
      expect(reloaded.getCanonicalSessionId("source-session")).toBe(
        "source-session",
      );
      expect(reloaded.getMetadata("source-session")).toEqual({
        provider: "codex",
      });
    });
  });

  describe("setProjectLocation", () => {
    it("persists the owning project so a bare session id stays resolvable", async () => {
      await service.initialize();
      await service.setProjectLocation(
        "session-1",
        encodeProjectId("/Users/someone/work/alpha"),
        "/Users/someone/work/alpha",
      );

      const newService = new SessionMetadataService({ dataDir: testDir });
      await newService.initialize();

      expect(newService.getProjectLocation("session-1")).toEqual({
        projectId: encodeProjectId("/Users/someone/work/alpha"),
        projectPath: "/Users/someone/work/alpha",
      });
    });

    it("reports unknown when only half the location was recorded", async () => {
      await service.initialize();
      await service.setProjectLocation(
        "session-1",
        encodeProjectId("/Users/someone/work/alpha"),
        undefined,
      );

      expect(service.getProjectLocation("session-1")).toBeUndefined();
    });

    it("reports unknown for sessions Yep never started", async () => {
      await service.initialize();

      expect(service.getProjectLocation("session-unknown")).toBeUndefined();
    });

    it("preserves the recorded location when other fields change", async () => {
      await service.initialize();
      await service.setProjectLocation(
        "session-1",
        encodeProjectId("/Users/someone/work/alpha"),
        "/Users/someone/work/alpha",
      );
      await service.setProvider("session-1", "codex");
      await service.setTitle("session-1", "Renamed");

      expect(service.getProjectLocation("session-1")).toEqual({
        projectId: encodeProjectId("/Users/someone/work/alpha"),
        projectPath: "/Users/someone/work/alpha",
      });
    });

    it("follows a durable id remap", async () => {
      await service.initialize();
      await service.setProjectLocation(
        "temporary-id",
        encodeProjectId("/Users/someone/work/alpha"),
        "/Users/someone/work/alpha",
      );

      await service.remapSessionId("temporary-id", "durable-id");

      expect(service.getProjectLocation("durable-id")?.projectPath).toBe(
        "/Users/someone/work/alpha",
      );
      expect(service.getProjectLocation("temporary-id")?.projectPath).toBe(
        "/Users/someone/work/alpha",
      );
    });
  });

  describe("remapSessionId", () => {
    it("moves temporary session metadata to the durable provider ID", async () => {
      await service.initialize();
      await service.setProvider("temporary-id", "codex");
      await service.setCodexMcpMode("temporary-id", "standard");
      await service.setPermissionMode("temporary-id", "bypassPermissions");
      await service.setCreatedBy("temporary-id", "yep");

      await service.remapSessionId("temporary-id", "durable-id");

      expect(service.getMetadata("durable-id")).toEqual({
        provider: "codex",
        codexMcpMode: "standard",
        permissionMode: "bypassPermissions",
        createdBy: "yep",
      });
      expect(service.getMetadata("temporary-id")).toEqual(
        service.getMetadata("durable-id"),
      );

      const reloaded = new SessionMetadataService({ dataDir: testDir });
      await reloaded.initialize();
      expect(reloaded.getCanonicalSessionId("temporary-id")).toBe("durable-id");
      expect(reloaded.getMetadata("temporary-id")).toEqual(
        reloaded.getMetadata("durable-id"),
      );
      expect(reloaded.getMetadata("durable-id")?.createdBy).toBe("yep");
    });

    it("persists an ID alias even when no metadata exists yet", async () => {
      await service.initialize();
      await service.remapSessionId("temporary-id", "durable-id");

      const reloaded = new SessionMetadataService({ dataDir: testDir });
      await reloaded.initialize();

      expect(reloaded.getCanonicalSessionId("temporary-id")).toBe("durable-id");
    });

    it("redirects metadata writes that race after the ID change", async () => {
      await service.initialize();

      await service.remapSessionId("temporary-id", "durable-id");
      await service.setCreatedBy("temporary-id", "yep");

      expect(service.getMetadata("durable-id")?.createdBy).toBe("yep");
      const allMetadata = service.getAllMetadata();
      expect(allMetadata["temporary-id"]).toBeUndefined();
      expect(allMetadata["durable-id"]?.createdBy).toBe("yep");
    });

    it("preserves metadata already written under the durable ID", async () => {
      await service.initialize();
      await service.setProvider("temporary-id", "codex");
      await service.setTitle("temporary-id", "Temporary title");
      await service.setTitle("durable-id", "Durable title");

      await service.remapSessionId("temporary-id", "durable-id");

      expect(service.getMetadata("durable-id")).toEqual({
        provider: "codex",
        customTitle: "Durable title",
      });
    });
  });

  describe("setStarred", () => {
    it("sets starred status for a session", async () => {
      await service.initialize();

      await service.setStarred("session-1", true);

      expect(service.getMetadata("session-1")).toEqual({ isStarred: true });
    });

    it("clears starred status when set to false", async () => {
      await service.initialize();
      await service.setStarred("session-1", true);

      await service.setStarred("session-1", false);

      expect(service.getMetadata("session-1")).toBeUndefined();
    });

    it("preserves other fields when updating starred status", async () => {
      await service.initialize();
      await service.setTitle("session-1", "My Title");
      await service.setArchived("session-1", true);

      await service.setStarred("session-1", true);

      expect(service.getMetadata("session-1")).toEqual({
        customTitle: "My Title",
        isArchived: true,
        isStarred: true,
      });
    });

    it("persists starred status to disk", async () => {
      await service.initialize();
      await service.setStarred("session-1", true);

      const newService = new SessionMetadataService({ dataDir: testDir });
      await newService.initialize();

      expect(newService.getMetadata("session-1")?.isStarred).toBe(true);
    });
  });

  describe("updateMetadata", () => {
    it("updates title, archived, and starred at once", async () => {
      await service.initialize();

      await service.updateMetadata("session-1", {
        title: "New Title",
        archived: true,
        starred: true,
      });

      expect(service.getMetadata("session-1")).toEqual({
        customTitle: "New Title",
        isArchived: true,
        isStarred: true,
      });
    });

    it("updates only title when others not provided", async () => {
      await service.initialize();
      await service.setArchived("session-1", true);
      await service.setStarred("session-1", true);

      await service.updateMetadata("session-1", { title: "Just Title" });

      expect(service.getMetadata("session-1")).toEqual({
        customTitle: "Just Title",
        isArchived: true,
        isStarred: true,
      });
    });

    it("updates only starred when others not provided", async () => {
      await service.initialize();
      await service.setTitle("session-1", "Existing Title");
      await service.setArchived("session-1", true);

      await service.updateMetadata("session-1", { starred: false });

      expect(service.getMetadata("session-1")).toEqual({
        customTitle: "Existing Title",
        isArchived: true,
      });
    });

    it("clears title with empty string while setting archived", async () => {
      await service.initialize();
      await service.setTitle("session-1", "Old Title");

      await service.updateMetadata("session-1", { title: "", archived: true });

      expect(service.getMetadata("session-1")).toEqual({ isArchived: true });
    });
  });

  describe("clearSession", () => {
    it("removes all metadata for a session", async () => {
      await service.initialize();
      await service.setTitle("session-1", "Title");
      await service.setArchived("session-1", true);

      await service.clearSession("session-1");

      expect(service.getMetadata("session-1")).toBeUndefined();
    });

    it("persists removal to disk", async () => {
      await service.initialize();
      await service.setTitle("session-1", "Title");
      await service.clearSession("session-1");

      const newService = new SessionMetadataService({ dataDir: testDir });
      await newService.initialize();

      expect(newService.getMetadata("session-1")).toBeUndefined();
    });

    it("does nothing if session not tracked", async () => {
      await service.initialize();

      // Should not throw
      await service.clearSession("nonexistent-session");

      expect(service.getMetadata("nonexistent-session")).toBeUndefined();
    });
  });

  describe("getAllMetadata", () => {
    it("returns copy of all entries", async () => {
      await service.initialize();

      await service.setTitle("session-1", "Title One");
      await service.setArchived("session-2", true);
      await service.updateMetadata("session-3", {
        title: "Title Three",
        archived: true,
      });

      const all = service.getAllMetadata();

      expect(all).toEqual({
        "session-1": { customTitle: "Title One" },
        "session-2": { isArchived: true },
        "session-3": { customTitle: "Title Three", isArchived: true },
      });

      // Verify it's a copy (modifying shouldn't affect internal state)
      all["session-4"] = { customTitle: "Injected" };
      expect(service.getMetadata("session-4")).toBeUndefined();
    });
  });

  describe("concurrent operations", () => {
    it("handles concurrent updates gracefully", async () => {
      await service.initialize();

      // Fire off multiple concurrent updates
      await Promise.all([
        service.setTitle("session-1", "Title 1"),
        service.setArchived("session-2", true),
        service.updateMetadata("session-3", {
          title: "Title 3",
          archived: true,
        }),
        service.setTitle("session-1", "Updated Title 1"), // Update session-1 again
      ]);

      // All should be persisted
      const newService = new SessionMetadataService({ dataDir: testDir });
      await newService.initialize();

      expect(newService.getMetadata("session-1")?.customTitle).toBe(
        "Updated Title 1",
      );
      expect(newService.getMetadata("session-2")?.isArchived).toBe(true);
      expect(newService.getMetadata("session-3")).toEqual({
        customTitle: "Title 3",
        isArchived: true,
      });
    });
  });

  describe("file path", () => {
    it("returns the correct file path", async () => {
      expect(service.getFilePath()).toBe(
        join(testDir, "session-metadata.json"),
      );
    });
  });

  describe("LLM gateway session configuration", () => {
    it("persists the request protocol and model configuration for resume", async () => {
      await service.initialize();
      const config = {
        model: "glm-5.2",
        requestProtocol: "anthropic" as const,
        limits: { context: 1_000_000, output: 65_536 },
        capabilities: { reasoning: true, toolCall: true },
        advanced: {
          model: { options: { thinking: { type: "enabled" } } },
        },
      };

      await service.setLlmGatewayConfig("session-1", config);

      const reloaded = new SessionMetadataService({ dataDir: testDir });
      await reloaded.initialize();
      expect(reloaded.getLlmGatewayConfig("session-1")).toEqual(config);
    });
  });

  describe("setExecutor", () => {
    it("sets executor for a session", async () => {
      await service.initialize();

      await service.setExecutor("session-1", "my-remote-server");

      expect(service.getMetadata("session-1")).toEqual({
        executor: "my-remote-server",
      });
    });

    it("clears executor when undefined provided", async () => {
      await service.initialize();
      await service.setExecutor("session-1", "my-remote-server");

      await service.setExecutor("session-1", undefined);

      expect(service.getMetadata("session-1")).toBeUndefined();
    });

    it("clears executor when empty string provided", async () => {
      await service.initialize();
      await service.setExecutor("session-1", "my-remote-server");

      await service.setExecutor("session-1", "");

      expect(service.getMetadata("session-1")).toBeUndefined();
    });

    it("preserves other fields when updating executor", async () => {
      await service.initialize();
      await service.setTitle("session-1", "My Title");
      await service.setArchived("session-1", true);

      await service.setExecutor("session-1", "remote-host");

      expect(service.getMetadata("session-1")).toEqual({
        customTitle: "My Title",
        isArchived: true,
        executor: "remote-host",
      });
    });

    it("persists executor to disk", async () => {
      await service.initialize();
      await service.setExecutor("session-1", "persistent-executor");

      const newService = new SessionMetadataService({ dataDir: testDir });
      await newService.initialize();

      expect(newService.getMetadata("session-1")?.executor).toBe(
        "persistent-executor",
      );
    });
  });

  describe("getExecutor", () => {
    it("returns executor for a session", async () => {
      await service.initialize();
      await service.setExecutor("session-1", "my-server");

      expect(service.getExecutor("session-1")).toBe("my-server");
    });

    it("returns undefined for session without executor", async () => {
      await service.initialize();
      await service.setTitle("session-1", "No Executor");

      expect(service.getExecutor("session-1")).toBeUndefined();
    });

    it("returns undefined for unknown session", async () => {
      await service.initialize();

      expect(service.getExecutor("nonexistent")).toBeUndefined();
    });
  });

  describe("executor with other metadata", () => {
    it("loads executor from existing state", async () => {
      const existingState = {
        version: 1,
        sessions: {
          "session-1": { executor: "saved-host" },
          "session-2": { customTitle: "Title", executor: "another-host" },
        },
      };
      await writeFile(
        join(testDir, "session-metadata.json"),
        JSON.stringify(existingState),
      );

      await service.initialize();

      expect(service.getExecutor("session-1")).toBe("saved-host");
      expect(service.getExecutor("session-2")).toBe("another-host");
      expect(service.getMetadata("session-2")).toEqual({
        customTitle: "Title",
        executor: "another-host",
      });
    });

    it("preserves executor when updating other fields", async () => {
      await service.initialize();
      await service.setExecutor("session-1", "my-executor");

      await service.setTitle("session-1", "New Title");
      await service.setArchived("session-1", true);
      await service.setStarred("session-1", true);

      expect(service.getMetadata("session-1")).toEqual({
        customTitle: "New Title",
        isArchived: true,
        isStarred: true,
        executor: "my-executor",
      });
    });

    it("clears executor when session is cleared", async () => {
      await service.initialize();
      await service.setExecutor("session-1", "to-clear");
      await service.setTitle("session-1", "Title");

      await service.clearSession("session-1");

      expect(service.getExecutor("session-1")).toBeUndefined();
      expect(service.getMetadata("session-1")).toBeUndefined();
    });
  });
});
