import { describe, expect, it, vi } from "vitest";
import type { SessionInteractionService } from "../../src/interactions/SessionInteractionService.js";
import {
  type SessionsDeps,
  createSessionsRoutes,
} from "../../src/routes/sessions.js";
import type { RuntimeController } from "../../src/runtime/types.js";
import type { SessionCommandService } from "../../src/services/SessionCommandService.js";

describe("sessions Codex control route", () => {
  it("accepts only pinned native controls and delegates through the command service", async () => {
    const executeCodexControl = vi.fn(async () => ({
      ok: true as const,
      status: 200 as const,
      body: { control: "skills/list", data: { data: [] } },
    }));
    const routes = createTestRoutes(executeCodexControl);

    const response = await routes.request("/sessions/session-1/codex-control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ control: "skills/list" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      control: "skills/list",
      data: { data: [] },
    });
    expect(executeCodexControl).toHaveBeenCalledWith({
      sessionId: "session-1",
      request: { control: "skills/list" },
    });

    const unsupported = await routes.request(
      "/sessions/session-1/codex-control",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ control: "thread/unbounded" }),
      },
    );
    expect(unsupported.status).toBe(400);
    expect(executeCodexControl).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed JSON before application dispatch", async () => {
    const executeCodexControl = vi.fn();
    const routes = createTestRoutes(executeCodexControl);

    const response = await routes.request("/sessions/session-1/codex-control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });

    expect(response.status).toBe(400);
    expect(executeCodexControl).not.toHaveBeenCalled();
  });
});

function createTestRoutes(executeCodexControl: ReturnType<typeof vi.fn>) {
  return createSessionsRoutes({
    supervisor: {} as SessionsDeps["supervisor"],
    scanner: {} as SessionsDeps["scanner"],
    readerFactory: vi.fn() as SessionsDeps["readerFactory"],
    runtimeController: {} as RuntimeController,
    sessionInteractionService: {} as SessionInteractionService,
    sessionCommandService: {
      executeCodexControl,
    } as unknown as SessionCommandService,
  });
}
