import { describe, expect, it } from "vitest";
import {
  getProviderPermissionModes,
  normalizeProviderPermissionMode,
} from "../providerPermissionModes";

describe("provider permission modes", () => {
  it("keeps all native Claude permission modes", () => {
    expect(getProviderPermissionModes("claude")).toEqual([
      "auto",
      "default",
      "acceptEdits",
      "plan",
      "bypassPermissions",
    ]);
    expect(normalizeProviderPermissionMode("claude", "auto")).toBe("auto");
  });

  it("collapses Codex aliases to its cf-compatible default", () => {
    expect(getProviderPermissionModes("codex")).toEqual([
      "auto",
      "plan",
      "bypassPermissions",
    ]);
    expect(normalizeProviderPermissionMode("codex", "default")).toBe("auto");
    expect(normalizeProviderPermissionMode("codex", "acceptEdits")).toBe(
      "auto",
    );
  });

  it("shows only distinct OpenCode tool-approval policies", () => {
    expect(getProviderPermissionModes("opencode")).toEqual([
      "default",
      "acceptEdits",
      "bypassPermissions",
    ]);
    expect(normalizeProviderPermissionMode("opencode", "auto")).toBe("default");
    expect(normalizeProviderPermissionMode("opencode", "plan")).toBe("default");
  });

  it("excludes ZCode auto, whose native mode denies every tool call", () => {
    // ZCode CLI 0.16.1 denies all tools in native `auto`
    // (`mode.auto.unimplemented`), and its own picker offers only
    // build/edit/plan/yolo.
    expect(getProviderPermissionModes("zcode")).toEqual([
      "default",
      "acceptEdits",
      "plan",
      "bypassPermissions",
    ]);
    expect(getProviderPermissionModes("zcode")).not.toContain("auto");
    // DEFAULT_PERMISSION_MODE is "auto", so an unset mode must not resolve to it.
    expect(normalizeProviderPermissionMode("zcode", undefined)).toBe("default");
    expect(normalizeProviderPermissionMode("zcode", "auto")).toBe("default");
    expect(normalizeProviderPermissionMode("zcode", "plan")).toBe("plan");
    expect(normalizeProviderPermissionMode("zcode", "acceptEdits")).toBe(
      "acceptEdits",
    );
  });

  it("collapses Gemini auto and plan aliases to its default policy", () => {
    expect(getProviderPermissionModes("gemini-acp")).toEqual([
      "default",
      "acceptEdits",
      "bypassPermissions",
    ]);
    expect(normalizeProviderPermissionMode("gemini-acp", "auto")).toBe(
      "default",
    );
    expect(normalizeProviderPermissionMode("gemini-acp", "plan")).toBe(
      "default",
    );
  });

  it("uses Kimi's native modes and defaults to manual approval", () => {
    expect(getProviderPermissionModes("kimi")).toEqual([
      "default",
      "plan",
      "auto",
      "bypassPermissions",
    ]);
    expect(normalizeProviderPermissionMode("kimi", undefined)).toBe("default");
    expect(normalizeProviderPermissionMode("kimi", "acceptEdits")).toBe(
      "default",
    );
    expect(normalizeProviderPermissionMode("kimi", "auto")).toBe("auto");
  });

  it("prefers modes advertised by the server", () => {
    expect(
      getProviderPermissionModes("codex", ["plan", "bypassPermissions"]),
    ).toEqual(["plan", "bypassPermissions"]);
    expect(
      normalizeProviderPermissionMode("codex", "auto", [
        "plan",
        "bypassPermissions",
      ]),
    ).toBe("plan");
  });
});
