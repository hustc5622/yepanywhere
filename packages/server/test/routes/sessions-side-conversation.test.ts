import { describe, expect, it, vi } from "vitest";
import type { SessionInteractionService } from "../../src/interactions/SessionInteractionService.js";
import { encodeProjectId } from "../../src/projects/paths.js";
import {
  type SessionsDeps,
  createSessionsRoutes,
} from "../../src/routes/sessions.js";
import type { RuntimeController } from "../../src/runtime/types.js";
import type { SessionCommandService } from "../../src/services/SessionCommandService.js";

const projectId = encodeProjectId("/test/project");

function setup(external = false) {
  const sideConversation = vi.fn(async () => ({ supported: true }));
  const routes = createSessionsRoutes({
    supervisor: {} as SessionsDeps["supervisor"],
    scanner: {} as SessionsDeps["scanner"],
    readerFactory: vi.fn(),
    runtimeController: {} as RuntimeController,
    sessionInteractionService: {} as SessionInteractionService,
    sessionCommandService: {
      sideConversation,
    } as unknown as SessionCommandService,
    externalTracker: {
      isExternal: () => external,
    } as SessionsDeps["externalTracker"],
  });
  const send = (query: string, body: unknown) =>
    routes.request(`/sessions/main/side-conversation${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  return { send, sideConversation };
}

describe("side conversation route", () => {
  it("passes the parent project so create can restore an inactive parent", async () => {
    const { send, sideConversation } = setup();
    const response = await send(`?projectId=${projectId}`, { action: "get" });
    expect(response.status).toBe(200);
    expect(sideConversation).toHaveBeenCalledWith({
      sessionId: "main",
      projectId,
      request: { action: "get" },
      allowRestore: true,
    });
  });

  it("never restores externally controlled sessions and ignores bad project IDs", async () => {
    const { send, sideConversation } = setup(true);
    await send("?projectId=not%20a%20project", { action: "get" });
    expect(sideConversation).toHaveBeenCalledWith({
      sessionId: "main",
      request: { action: "get" },
      allowRestore: false,
    });
  });

  it("rejects malformed requests before dispatch", async () => {
    const { send, sideConversation } = setup();
    expect((await send("", { action: "get", threadId: "x" })).status).toBe(400);
    expect(sideConversation).not.toHaveBeenCalled();
  });
});
