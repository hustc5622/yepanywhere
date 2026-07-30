import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { MockClaudeSDK } from "../../src/sdk/mock.js";

describe("Projects API", () => {
  let mockSdk: MockClaudeSDK;
  let testDir: string;
  const apiPath = (path: string) => path.replaceAll("\\", "/");

  beforeEach(async () => {
    mockSdk = new MockClaudeSDK();
    // Create temp directory structure mimicking ~/.claude/projects/
    testDir = join(tmpdir(), `claude-test-${randomUUID()}`);
    await mkdir(join(testDir, "localhost"), { recursive: true });
    await mkdir(join(testDir, "localhost", "-home-user-myproject"), {
      recursive: true,
    });
    // Create a sample session file with cwd field (required for project path discovery)
    await writeFile(
      join(testDir, "localhost", "-home-user-myproject", "sess-123.jsonl"),
      '{"type":"user","cwd":"/home/user/myproject","message":{"content":"Hello"}}\n',
    );
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("GET /api/projects", () => {
    it("returns list of projects", async () => {
      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });

      const res = await app.request("/api/projects");
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.projects).toBeDefined();
      expect(Array.isArray(json.projects)).toBe(true);
    });

    it("returns no scanned projects when projects directory is missing", async () => {
      const { app } = createApp({
        sdk: mockSdk,
        projectsDir: "/nonexistent/path",
      });

      const res = await app.request("/api/projects");
      const json = await res.json();

      expect(res.status).toBe(200);
      // No Claude projects with actual sessions should be found.
      // The home-directory fallback (sessionCount: 0) or Codex/Gemini
      // sessions may still appear.
      const claudeWithSessions = json.projects.filter(
        (p: { provider: string; sessionCount: number }) =>
          p.provider === "claude" && p.sessionCount > 0,
      );
      expect(claudeWithSessions).toEqual([]);
    });

    it("discovers projects from directory structure", async () => {
      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });

      const res = await app.request("/api/projects");
      const json = await res.json();

      expect(res.status).toBe(200);
      // Should find the project we created
      expect(json.projects.length).toBeGreaterThan(0);
    });
  });

  describe("GET /api/projects/:projectId", () => {
    it("returns 404 for unknown project", async () => {
      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });

      const res = await app.request("/api/projects/unknown-id");

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe("Project not found");
    });
  });

  describe("GET /api/projects/directories", () => {
    it("lists directories and supports a partial final path segment", async () => {
      const browseRoot = join(testDir, "browse-root");
      await mkdir(join(browseRoot, "alpha"), { recursive: true });
      await mkdir(join(browseRoot, "beta"), { recursive: true });
      await mkdir(join(browseRoot, ".hidden"), { recursive: true });
      await writeFile(join(browseRoot, "README.md"), "not a directory");
      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });

      const listResponse = await app.request(
        `/api/projects/directories?path=${encodeURIComponent(browseRoot)}`,
      );
      expect(listResponse.status).toBe(200);
      const listJson = await listResponse.json();
      expect(listJson).toMatchObject({
        path: apiPath(browseRoot),
        exact: true,
        truncated: false,
      });
      expect(
        listJson.directories.map((entry: { name: string }) => entry.name),
      ).toEqual(["alpha", "beta"]);

      const completionResponse = await app.request(
        `/api/projects/directories?path=${encodeURIComponent(join(browseRoot, "al"))}`,
      );
      expect(completionResponse.status).toBe(200);
      const completionJson = await completionResponse.json();
      expect(completionJson).toMatchObject({
        path: apiPath(browseRoot),
        exact: false,
      });
      expect(completionJson.directories).toEqual([
        {
          name: "alpha",
          path: apiPath(join(browseRoot, "alpha")),
          hidden: false,
        },
      ]);
    });

    it("can include hidden directories on request", async () => {
      const browseRoot = join(testDir, "hidden-root");
      await mkdir(join(browseRoot, ".config"), { recursive: true });
      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });

      const response = await app.request(
        `/api/projects/directories?path=${encodeURIComponent(browseRoot)}&includeHidden=true`,
      );
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.directories).toContainEqual({
        name: ".config",
        path: apiPath(join(browseRoot, ".config")),
        hidden: true,
      });
    });

    it("rejects relative paths", async () => {
      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });

      const response = await app.request(
        "/api/projects/directories?path=relative/path",
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: "Path must be absolute",
      });
    });
  });

  describe("GET /api/projects/:projectId/sessions", () => {
    it("returns 404 for unknown project", async () => {
      const { app } = createApp({ sdk: mockSdk, projectsDir: testDir });

      const res = await app.request("/api/projects/unknown-id/sessions");

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe("Project not found");
    });
  });
});
