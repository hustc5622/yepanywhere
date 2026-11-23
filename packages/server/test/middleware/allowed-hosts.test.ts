import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AllowedHosts from "../../src/middleware/allowed-hosts.js";

// We need to re-import the module for each test group that changes env vars,
// because ALLOWED_HOSTS is parsed at module load time.

async function loadModule() {
  return (await import(
    "../../src/middleware/allowed-hosts.js"
  )) as typeof AllowedHosts;
}

describe("allowed-hosts", () => {
  describe("isAllowedHostname", () => {
    let isAllowedHostname: typeof AllowedHosts.isAllowedHostname;

    beforeEach(async () => {
      vi.resetModules();
      process.env.ALLOWED_HOSTS = undefined;
      const mod = await loadModule();
      isAllowedHostname = mod.isAllowedHostname;
    });

    it("allows localhost", () => {
      expect(isAllowedHostname("localhost")).toBe(true);
    });

    it("allows 127.0.0.1", () => {
      expect(isAllowedHostname("127.0.0.1")).toBe(true);
    });

    it("allows IPv6 loopback", () => {
      expect(isAllowedHostname("::1")).toBe(true);
      expect(isAllowedHostname("[::1]")).toBe(true);
    });

    it("allows private 192.168.x.x", () => {
      expect(isAllowedHostname("192.168.1.1")).toBe(true);
      expect(isAllowedHostname("192.168.0.100")).toBe(true);
    });

    it("allows private 10.x.x.x", () => {
      expect(isAllowedHostname("10.0.0.1")).toBe(true);
      expect(isAllowedHostname("10.255.255.255")).toBe(true);
    });

    it("allows private 172.16-31.x.x", () => {
      expect(isAllowedHostname("172.16.0.1")).toBe(true);
      expect(isAllowedHostname("172.31.255.255")).toBe(true);
      // 172.15 and 172.32 should NOT match
      expect(isAllowedHostname("172.15.0.1")).toBe(false);
      expect(isAllowedHostname("172.32.0.1")).toBe(false);
    });

    it("allows Tailscale *.ts.net (including nested subdomains)", () => {
      expect(isAllowedHostname("myhost.ts.net")).toBe(true);
      expect(isAllowedHostname("foo.bar.ts.net")).toBe(true);
      expect(isAllowedHostname("deep.nested.sub.ts.net")).toBe(true);
    });

    it("rejects public hostnames", () => {
      expect(isAllowedHostname("evil.com")).toBe(false);
      expect(isAllowedHostname("example.org")).toBe(false);
    });

    it("is case-insensitive", () => {
      expect(isAllowedHostname("LOCALHOST")).toBe(true);
      expect(isAllowedHostname("MyHost.TS.NET")).toBe(true);
    });
  });

  describe("isAllowedHost (Host header)", () => {
    let isAllowedHost: typeof AllowedHosts.isAllowedHost;

    beforeEach(async () => {
      vi.resetModules();
      process.env.ALLOWED_HOSTS = undefined;
      const mod = await loadModule();
      isAllowedHost = mod.isAllowedHost;
    });

    it("allows undefined (no Host = no DNS rebinding risk)", () => {
      expect(isAllowedHost(undefined)).toBe(true);
    });

    it("strips port from hostname", () => {
      expect(isAllowedHost("localhost:3400")).toBe(true);
      expect(isAllowedHost("127.0.0.1:8080")).toBe(true);
    });

    it("handles hostname without port", () => {
      expect(isAllowedHost("localhost")).toBe(true);
    });

    it("handles IPv6 with brackets and port", () => {
      expect(isAllowedHost("[::1]:3400")).toBe(true);
    });

    it("handles IPv6 with brackets without port", () => {
      expect(isAllowedHost("[::1]")).toBe(true);
    });

    it("returns false for malformed IPv6 bracket", () => {
      expect(isAllowedHost("[::1")).toBe(false);
    });

    it("rejects unknown hosts", () => {
      expect(isAllowedHost("evil.com:3400")).toBe(false);
    });
  });

  describe("isAllowedOrigin (Origin header)", () => {
    let isAllowedOrigin: typeof AllowedHosts.isAllowedOrigin;

    beforeEach(async () => {
      vi.resetModules();
      process.env.ALLOWED_HOSTS = undefined;
      const mod = await loadModule();
      isAllowedOrigin = mod.isAllowedOrigin;
    });

    it("allows missing origin (same-origin request)", () => {
      expect(isAllowedOrigin(undefined)).toBe(true);
    });

    it('rejects "null" origin (sandboxed iframes / cross-site credentialed reads)', () => {
      expect(isAllowedOrigin("null")).toBe(false);
    });

    it("allows localhost origins", () => {
      expect(isAllowedOrigin("http://localhost:3400")).toBe(true);
      expect(isAllowedOrigin("https://localhost")).toBe(true);
    });

    it("allows private IP origins", () => {
      expect(isAllowedOrigin("http://192.168.1.100:3400")).toBe(true);
      expect(isAllowedOrigin("http://10.0.0.1")).toBe(true);
    });

    it("allows Tailscale origins", () => {
      expect(isAllowedOrigin("http://myhost.ts.net:3400")).toBe(true);
      expect(isAllowedOrigin("https://foo.bar.ts.net")).toBe(true);
    });

    it("rejects public origins", () => {
      expect(isAllowedOrigin("https://evil.com")).toBe(false);
      expect(isAllowedOrigin("https://attacker.github.io")).toBe(false);
    });

    it("rejects invalid URLs", () => {
      expect(isAllowedOrigin("not-a-url")).toBe(false);
    });
  });

  describe("ALLOWED_HOSTS env var", () => {
    afterEach(() => {
      process.env.ALLOWED_HOSTS = undefined;
    });

    it("allows custom hostnames from env var", async () => {
      vi.resetModules();
      process.env.ALLOWED_HOSTS = "custom.example.com,my.dev";
      const mod = await loadModule();

      expect(mod.isAllowedHostname("custom.example.com")).toBe(true);
      expect(mod.isAllowedHostname("my.dev")).toBe(true);
      expect(mod.isAllowedHostname("other.com")).toBe(false);
      expect(mod.allowAllHosts()).toBe(false);
    });

    it("ALLOWED_HOSTS=* enables allowAllHosts()", async () => {
      vi.resetModules();
      process.env.ALLOWED_HOSTS = "*";
      const mod = await loadModule();

      expect(mod.allowAllHosts()).toBe(true);
      expect(mod.isAllowedHost("anything.com:1234")).toBe(true);
      expect(mod.isAllowedOrigin("https://anything.com")).toBe(true);
    });

    it("handles whitespace in env var", async () => {
      vi.resetModules();
      process.env.ALLOWED_HOSTS = " foo.com , bar.com ";
      const mod = await loadModule();

      expect(mod.isAllowedHostname("foo.com")).toBe(true);
      expect(mod.isAllowedHostname("bar.com")).toBe(true);
    });
  });

  describe("updateAllowedHosts (runtime settings)", () => {
    let mod: typeof AllowedHosts;

    beforeEach(async () => {
      vi.resetModules();
      process.env.ALLOWED_HOSTS = undefined;
      mod = await loadModule();
    });

    it("adds hostnames from settings at runtime", () => {
      expect(mod.isAllowedHostname("custom.dev")).toBe(false);
      mod.updateAllowedHosts("custom.dev");
      expect(mod.isAllowedHostname("custom.dev")).toBe(true);
    });

    it("supports comma-separated hostnames", () => {
      mod.updateAllowedHosts("a.com, b.com");
      expect(mod.isAllowedHostname("a.com")).toBe(true);
      expect(mod.isAllowedHostname("b.com")).toBe(true);
      expect(mod.isAllowedHostname("c.com")).toBe(false);
    });

    it("supports wildcard '*' to allow all", () => {
      expect(mod.allowAllHosts()).toBe(false);
      mod.updateAllowedHosts("*");
      expect(mod.allowAllHosts()).toBe(true);
      expect(mod.isAllowedHost("anything.com:3400")).toBe(true);
    });

    it("clears settings hosts with undefined", () => {
      mod.updateAllowedHosts("custom.dev");
      expect(mod.isAllowedHostname("custom.dev")).toBe(true);
      mod.updateAllowedHosts(undefined);
      expect(mod.isAllowedHostname("custom.dev")).toBe(false);
    });

    it("clears settings hosts with empty string", () => {
      mod.updateAllowedHosts("custom.dev");
      expect(mod.isAllowedHostname("custom.dev")).toBe(true);
      mod.updateAllowedHosts("");
      expect(mod.isAllowedHostname("custom.dev")).toBe(false);
    });

    it("env var and settings combine (both checked)", async () => {
      vi.resetModules();
      process.env.ALLOWED_HOSTS = "from-env.com";
      mod = await loadModule();

      mod.updateAllowedHosts("from-settings.com");
      expect(mod.isAllowedHostname("from-env.com")).toBe(true);
      expect(mod.isAllowedHostname("from-settings.com")).toBe(true);
      expect(mod.isAllowedHostname("neither.com")).toBe(false);
    });

    it("settings wildcard overrides even without env var wildcard", () => {
      mod.updateAllowedHosts("*");
      expect(mod.allowAllHosts()).toBe(true);
      expect(mod.isAllowedOrigin("https://anything.com")).toBe(true);
    });

    it("is case-insensitive", () => {
      mod.updateAllowedHosts("MyDomain.COM");
      expect(mod.isAllowedHostname("mydomain.com")).toBe(true);
      expect(mod.isAllowedHostname("MYDOMAIN.COM")).toBe(true);
    });
  });
});
