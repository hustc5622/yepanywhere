import { describe, expect, it } from "vitest";
import { SessionDisplayReducer } from "../../src/display/SessionDisplayReducer.js";

const view = { sessionId: "s", branchScopeId: "active", epoch: "e" };
const toolUse = (uuid: string, id: string) => ({
  uuid,
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "tool_use", id, name: "Bash", input: { command: "x" } }],
  },
});
const toolResult = (uuid: string, id: string) => ({
  uuid,
  type: "user",
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
  },
});

/**
 * Providers without native run ids (Pi, agy) share the `session` run. A turn
 * the agent starts on its own after a closed run must reopen it, or its tools
 * would stay attributed to (and closed by) the previous turn.
 */
describe("SessionDisplayReducer agent-initiated turns", () => {
  for (const provider of ["agy", "pi"] as const) {
    it(`reopens the session run for ${provider}`, () => {
      const model = new SessionDisplayReducer(view, provider);
      model.message({
        uuid: "q1",
        type: "user",
        message: { role: "user", content: "start a background job" },
      });
      model.setRuntime("running");
      model.message(toolUse("a1", "call-1"));
      model.message({ type: "result", uuid: "r1" });
      expect(model.snapshot().activity.state).toBe("completed");

      model.message({
        type: "system",
        subtype: "turn_started",
        origin: "agent",
      });
      model.setRuntime("running");
      model.message(toolUse("a2", "call-2"));
      const running = model.snapshot();
      expect(running.activity.state).toBe("running");
      expect(running.activity.runningCount).toBe(1);

      model.message(toolResult("t2", "call-2"));
      model.message({ type: "result", uuid: "r2" });
      expect(model.snapshot().activity.state).toBe("completed");
    });
  }
});
