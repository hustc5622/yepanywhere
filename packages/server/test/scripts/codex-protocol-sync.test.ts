import { describe, expect, it } from "vitest";
import { compareCodexVersions } from "../../../../scripts/update-codex-protocol.mjs";

describe("Codex protocol auto-sync version ordering", () => {
  it("allows only monotonic stable upgrades", () => {
    expect(compareCodexVersions("0.151.0", "0.150.0")).toBe(1);
    expect(compareCodexVersions("0.151.0", "0.151.0")).toBe(0);
    expect(compareCodexVersions("0.150.9", "0.151.0")).toBe(-1);
  });

  it("orders prereleases below their stable release", () => {
    expect(compareCodexVersions("0.151.0-beta.1", "0.151.0")).toBe(-1);
    expect(compareCodexVersions("0.151.0", "0.151.0-beta.1")).toBe(1);
  });

  it("fails closed for non-comparable version strings", () => {
    expect(compareCodexVersions("latest", "0.151.0")).toBeNull();
    expect(compareCodexVersions("0.151", "0.151.0")).toBeNull();
  });
});
