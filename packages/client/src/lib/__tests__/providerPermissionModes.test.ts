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
