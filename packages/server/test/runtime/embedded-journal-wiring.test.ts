import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, createEmbeddedRuntimeEventStore } from "../../src/app.js";

describe("embedded runtime event journal wiring", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("journals under the data directory by default", () => {
    vi.stubEnv("YEP_RUNTIME_EVENT_JOURNAL", undefined);
    expect(
      createEmbeddedRuntimeEventStore("/path/to/synthetic-data"),
    ).toBeDefined();
  });

  it("stays disabled without a data directory or when opted out", () => {
    vi.stubEnv("YEP_RUNTIME_EVENT_JOURNAL", undefined);
    expect(createEmbeddedRuntimeEventStore(undefined)).toBeUndefined();
    vi.stubEnv("YEP_RUNTIME_EVENT_JOURNAL", "0");
    expect(
      createEmbeddedRuntimeEventStore("/path/to/synthetic-data"),
    ).toBeUndefined();
  });

  it("gives the embedded controller a durable replay source", async () => {
    // Without a journal `subscribeSession` can only replay the Process
    // in-memory buffer (~15-30s), which is why a reconnecting shell used to
    // lose everything produced while it was hidden.
    const dataDir = path.join(tmpdir(), `embedded-journal-${randomUUID()}`);
    vi.stubEnv("YEP_RUNTIME_EVENT_JOURNAL", undefined);
    const app = createApp({
      projectsDir: "/path/to/synthetic-projects",
      dataDir,
    });
    try {
      await app.runtimeController.start();
      await expect(app.runtimeController.replay({})).resolves.toEqual([]);
      await expect(
        rm(path.join(dataDir, "runtime", "events"), { recursive: true }),
      ).resolves.toBeUndefined();
    } finally {
      app.sessionInteractionService.dispose();
      await app.runtimeController.shutdown({ abortActive: true });
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
