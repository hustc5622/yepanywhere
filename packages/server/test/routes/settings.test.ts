import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSettingsRoutes } from "../../src/routes/settings.js";
import type { OhMyRouterBenchmarkService } from "../../src/services/OhMyRouterBenchmarkService.js";
import type {
  ServerSettings,
  ServerSettingsService,
} from "../../src/services/ServerSettingsService.js";

describe("Settings Routes", () => {
  let settings: ServerSettings;
  let mockServerSettingsService: ServerSettingsService;

  beforeEach(() => {
    settings = {
      serviceWorkerEnabled: true,
      persistRemoteSessionsToDisk: false,
    };

    mockServerSettingsService = {
      getSettings: vi.fn(() => settings),
      getSetting: vi.fn((key: keyof ServerSettings) => settings[key]),
      updateSettings: vi.fn(async (updates: Partial<ServerSettings>) => {
        settings = { ...settings, ...updates };
        return settings;
      }),
    } as unknown as ServerSettingsService;
  });

  describe("remote executors", () => {
    it("persists a normalized shared-root mapping and applies it at runtime", async () => {
      const onRemoteExecutorsChanged = vi.fn();
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
        onRemoteExecutorsChanged,
      });

      const response = await routes.request("/remote-executors", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          executors: [
            {
              host: " 192.168.64.4 ",
              user: " yueyuan ",
              localRoot: "/Users/yueyuan/Desktop/file/UTM/",
              remoteRoot: "/mnt/utm/",
              claudePath: "/home/yueyuan/.local/bin/claude",
            },
          ],
        }),
      });

      expect(response.status).toBe(200);
      const expected = [
        {
          host: "192.168.64.4",
          user: "yueyuan",
          localRoot: "/Users/yueyuan/Desktop/file/UTM",
          remoteRoot: "/mnt/utm",
          claudePath: "/home/yueyuan/.local/bin/claude",
        },
      ];
      await expect(response.json()).resolves.toEqual({ executors: expected });
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        remoteExecutors: expected,
      });
      expect(onRemoteExecutorsChanged).toHaveBeenCalledWith(expected);
    });

    it("rejects an option-like SSH host", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/remote-executors", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          executors: [
            {
              host: "-oProxyCommand=bad",
              localRoot: "/local",
              remoteRoot: "/remote",
            },
          ],
        }),
      });

      expect(response.status).toBe(400);
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("round-trips a validated shared Claude projects directory", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });
      const executor = {
        host: "utm",
        localRoot: "/Users/me/UTM",
        remoteRoot: "/mnt/utm",
        sessionStorage: {
          mode: "shared",
          localProjectsDir: "/Users/me/UTM/claude/projects",
          remoteProjectsDir: "/mnt/utm/claude/projects",
        },
      };

      const response = await routes.request("/remote-executors", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ executors: [executor] }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ executors: [executor] });
    });
  });

  describe("PUT /", () => {
    it("accepts Claude as the default provider", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          newSessionDefaults: {
            provider: "claude",
            model: "sonnet",
          },
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        newSessionDefaults: {
          provider: "claude",
          model: "sonnet",
        },
      });
    });

    it("accepts clearing globalInstructions with null", async () => {
      settings = {
        ...settings,
        globalInstructions: "Existing instructions",
      };

      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          globalInstructions: null,
        }),
      });

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.settings.globalInstructions).toBeUndefined();
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        globalInstructions: undefined,
      });
    });

    it("accepts and normalizes valid aliases in chromeOsHosts setting", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chromeOsHosts: ["  chromeroot  ", "lab-book", "", " "],
        }),
      });

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.settings.chromeOsHosts).toEqual(["chromeroot", "lab-book"]);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        chromeOsHosts: ["chromeroot", "lab-book"],
      });
    });

    it("rejects invalid aliases in chromeOsHosts setting", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chromeOsHosts: ["chromeroot", "-oProxyCommand=touch_/tmp/pwned"],
        }),
      });

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toContain("Invalid ChromeOS host alias");
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("accepts lifecycle webhook settings", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lifecycleWebhooksEnabled: true,
          lifecycleWebhookUrl: "https://example.com/hook",
          lifecycleWebhookToken: "secret",
          lifecycleWebhookDryRun: false,
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        lifecycleWebhooksEnabled: true,
        lifecycleWebhookUrl: "https://example.com/hook",
        lifecycleWebhookToken: "secret",
        lifecycleWebhookDryRun: false,
      });
    });
  });

  describe("OhMyRouter throughput benchmark", () => {
    it("returns the persisted benchmark status", async () => {
      const ohmyrouterBenchmarkService = {
        getStatus: vi.fn(() => ({
          available: true,
          benchmark: { id: "run-1", status: "completed" },
        })),
      } as unknown as OhMyRouterBenchmarkService;
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
        ohmyrouterBenchmarkService,
      });

      const response = await routes.request("/ohmyrouter-throughput");

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        available: true,
        benchmark: { id: "run-1" },
      });
    });

    it("starts a new benchmark run", async () => {
      const ohmyrouterBenchmarkService = {
        start: vi.fn(async () => ({ id: "run-2", status: "running" })),
        getStatus: vi.fn(),
      } as unknown as OhMyRouterBenchmarkService;
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
        ohmyrouterBenchmarkService,
      });

      const response = await routes.request("/ohmyrouter-throughput", {
        method: "POST",
      });

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({
        benchmark: { id: "run-2", status: "running" },
      });
      expect(ohmyrouterBenchmarkService.start).toHaveBeenCalledOnce();
    });
  });
});
