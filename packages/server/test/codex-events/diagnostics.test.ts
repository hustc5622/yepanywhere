import { describe, expect, it, vi } from "vitest";

describe("Codex event compatibility diagnostics", () => {
  it("uses generated coverage to distinguish known and unknown server requests", async () => {
    vi.resetModules();
    const diagnostics = await import("../../src/codex-events/diagnostics.js");

    expect(
      diagnostics.isKnownCodexServerRequestMethod(
        "item/commandExecution/requestApproval",
      ),
    ).toBe(true);
    expect(
      diagnostics.isKnownCodexServerRequestMethod("currentTime/read"),
    ).toBe(true);
    expect(diagnostics.isKnownCodexServerRequestMethod("future/request")).toBe(
      false,
    );
    expect(diagnostics.isKnownCodexServerRequestMethod("__proto__")).toBe(
      false,
    );
  });

  it("bounds fingerprint-only method/runtime/schema buckets", async () => {
    vi.resetModules();
    const diagnostics = await import("../../src/codex-events/diagnostics.js");
    const runtime = {
      codexVersion: "secret-looking-runtime-version",
      schemaHash: "schema-with-/private/path-and-token",
      profile: "experimental" as const,
      experimentalApi: true,
    };
    const rawNotificationMethod = "future/notification?token=do-not-expose";
    const rawRequestMethod = "future/request//private/do-not-expose";

    diagnostics.recordUnknownCodexNotification(rawNotificationMethod, runtime);
    diagnostics.recordUnknownCodexNotification(rawNotificationMethod, runtime);
    diagnostics.recordUnknownCodexServerRequest(rawRequestMethod, runtime);
    for (
      let index = 0;
      index < diagnostics.CODEX_UNKNOWN_METHOD_BUCKET_LIMIT + 8;
      index += 1
    ) {
      diagnostics.recordUnknownCodexServerRequest(
        `future/request/${index}`,
        runtime,
      );
    }

    const snapshot = diagnostics.getCodexEventDiagnostics();
    expect(snapshot).toMatchObject({
      scope: "process_lifetime",
      unknownNotificationsTotal: 2,
      unknownServerRequestsTotal:
        diagnostics.CODEX_UNKNOWN_METHOD_BUCKET_LIMIT + 9,
      bucketLimit: diagnostics.CODEX_UNKNOWN_METHOD_BUCKET_LIMIT,
    });
    expect(snapshot.buckets).toHaveLength(
      diagnostics.CODEX_UNKNOWN_METHOD_BUCKET_LIMIT,
    );
    expect(snapshot.bucketOverflowTotal).toBeGreaterThan(0);
    expect(snapshot.buckets).toContainEqual(
      expect.objectContaining({
        direction: "server_notification",
        methodFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{20}$/),
        runtimeVersion: expect.stringMatching(/^other:sha256:[a-f0-9]{20}$/),
        schemaFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{20}$/),
        profile: "experimental",
        total: 2,
      }),
    );
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(rawNotificationMethod);
    expect(serialized).not.toContain(rawRequestMethod);
    expect(serialized).not.toContain(runtime.codexVersion);
    expect(serialized).not.toContain(runtime.schemaHash);
    expect(serialized).not.toContain("/private/");
    expect(serialized).not.toContain("do-not-expose");
  });
});
