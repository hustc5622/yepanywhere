import { afterEach, describe, expect, it, vi } from "vitest";
import { YepBridge } from "../../resources/opencode-plugin/yep-bridge.js";

describe("Yep OpenCode bridge plugin", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("does not block an awaited event hook while the bridge is unavailable", async () => {
    vi.stubEnv("YEP_MANAGED_OPENCODE", "");
    vi.stubEnv("YEP_OPENCODE_PLUGIN_DISABLE", "");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    const hooks = await YepBridge({ client: {}, directory: "/repo" });
    if (!("event" in hooks) || !hooks.event) {
      throw new Error("Expected the OpenCode event hook to be enabled");
    }

    const outcome = await Promise.race([
      hooks
        .event({
          event: {
            type: "session.status",
            properties: {
              sessionID: "ses_offline",
              status: { type: "busy" },
            },
          },
        })
        .then(() => "returned" as const),
      new Promise<"timeout">((resolve) => {
        setTimeout(() => resolve("timeout"), 50);
      }),
    ]);

    expect(outcome).toBe("returned");
  });
});
