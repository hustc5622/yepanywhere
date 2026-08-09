import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { InteractionBroker } from "../src/interactions/InteractionBroker.js";

describe("createApp interaction authority", () => {
  it("shares the injected broker with the session routes and channel adapters", () => {
    const broker = new InteractionBroker();
    const result = createApp({
      projectsDir: "/path/to/synthetic-projects",
      interactionBroker: broker,
    });

    expect(result.interactionBroker).toBe(broker);
    expect(result.sessionInteractionService.getInteractionBroker()).toBe(
      broker,
    );

    result.sessionInteractionService.dispose();
    broker.shutdown();
  });
});
