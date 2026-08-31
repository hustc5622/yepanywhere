import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CODEX_NATIVE_CAPABILITIES } from "../../../src/sdk/providers/codex-controls.js";

interface ProtocolManifest {
  codex: { version: string };
  capabilityProfiles: Record<
    "stable" | "experimental",
    { clientRequests: string[]; initializeCapabilities: unknown }
  >;
}

const manifest = JSON.parse(
  readFileSync(
    new URL(
      "../../../src/sdk/providers/codex-protocol/manifest.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as ProtocolManifest;

describe("Codex native control capability contract", () => {
  it("keeps enabled controls inside the synchronized stable manifest", () => {
    expect(CODEX_NATIVE_CAPABILITIES.codexVersion).toBe(manifest.codex.version);
    expect(CODEX_NATIVE_CAPABILITIES.experimentalApi).toBe(false);

    const stable = new Set(manifest.capabilityProfiles.stable.clientRequests);
    for (const [method, enabled] of Object.entries(
      CODEX_NATIVE_CAPABILITIES.methods,
    )) {
      if (enabled) expect(stable.has(method)).toBe(true);
    }
  });

  it("keeps experimental background-terminal controls disabled", () => {
    expect(Object.isFrozen(CODEX_NATIVE_CAPABILITIES)).toBe(true);
    expect(Object.isFrozen(CODEX_NATIVE_CAPABILITIES.methods)).toBe(true);
    const stable = new Set(manifest.capabilityProfiles.stable.clientRequests);
    const experimental = new Set(
      manifest.capabilityProfiles.experimental.clientRequests,
    );
    for (const method of [
      "thread/backgroundTerminals/list",
      "thread/backgroundTerminals/terminate",
      "thread/backgroundTerminals/clean",
    ] as const) {
      expect(CODEX_NATIVE_CAPABILITIES.methods[method]).toBe(false);
      expect(stable.has(method)).toBe(false);
      expect(experimental.has(method)).toBe(true);
    }
  });
});
