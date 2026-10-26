import { describe, expect, it } from "vitest";
import {
  getProviderPermissionModes,
  normalizeProviderPermissionMode,
} from "../providerPermissionModes";

describe("provider permission modes", () => {
  it("offers explicit session auto-approval for Cursor while defaulting to asks", () => {
    expect(getProviderPermissionModes("cursor")).toEqual([
      "default",
      "plan",
      "bypassPermissions",
    ]);
    expect(normalizeProviderPermissionMode("cursor", undefined)).toBe(
      "default",
    );
  });
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

  it("uses Codex-style explicit approval modes for Pi", () => {
    expect(getProviderPermissionModes("pi")).toEqual([
      "default",
      "acceptEdits",
      "plan",
      "bypassPermissions",
    ]);
    expect(normalizeProviderPermissionMode("pi", undefined)).toBe("default");
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
