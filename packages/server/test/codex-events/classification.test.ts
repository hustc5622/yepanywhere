import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CODEX_NOTIFICATION_CLASSIFICATIONS,
  CODEX_THREAD_ITEM_KIND_BY_NATIVE_TYPE,
  classifyCodexNotification,
} from "../../src/codex-events/index.js";

interface ProtocolManifest {
  capabilityProfiles: Record<
    "stable" | "experimental",
    {
      serverNotifications: string[];
      threadItems: string[];
    }
  >;
}

const manifest = JSON.parse(
  readFileSync(
    new URL(
      "../../src/sdk/providers/codex-protocol/manifest.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as ProtocolManifest;

describe("Codex notification classification contract", () => {
  it("classifies every synchronized manifest notification explicitly", () => {
    const classified = Object.keys(CODEX_NOTIFICATION_CLASSIFICATIONS);
    const generated =
      manifest.capabilityProfiles.experimental.serverNotifications;

    expect([...classified].sort()).toEqual([...generated].sort());
    expect(classified).toHaveLength(generated.length);
    expect(CODEX_NOTIFICATION_CLASSIFICATIONS["rawResponse/completed"]).toEqual(
      { domain: "compatibility", disposition: "diagnostic" },
    );
  });

  it("keeps stable and experimental manifest coverage explicit", () => {
    for (const profile of ["stable", "experimental"] as const) {
      for (const method of manifest.capabilityProfiles[profile]
        .serverNotifications) {
        expect(classifyCodexNotification(method)).toMatchObject({
          known: true,
        });
      }
    }
  });

  it("uses a recorded compatibility fallback for a newer method", () => {
    expect(classifyCodexNotification("future/item/delta")).toEqual({
      known: false,
      domain: "compatibility",
      disposition: "record",
      compatibility: "newer_server",
    });
  });

  it("maps every generated ThreadItem variant", () => {
    const generated = manifest.capabilityProfiles.experimental.threadItems;
    expect(Object.keys(CODEX_THREAD_ITEM_KIND_BY_NATIVE_TYPE).sort()).toEqual(
      [...generated].sort(),
    );
    expect(
      new Set(Object.values(CODEX_THREAD_ITEM_KIND_BY_NATIVE_TYPE)).size,
    ).toBe(generated.length);
  });
});
