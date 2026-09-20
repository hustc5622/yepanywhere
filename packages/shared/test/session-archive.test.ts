import { expect, it } from "vitest";
import { getSessionArchiveBlock } from "../src/session-archive.js";

it("shares archive-block priority across local and external owners", () => {
  for (const owner of ["self", "external", "none"]) {
    expect(
      getSessionArchiveBlock({ owner }, "waiting-input").archiveBlockCode,
    ).toBe("waiting_input");
    expect(getSessionArchiveBlock({ owner }, "hold").archiveBlockCode).toBe(
      "agent_on_hold",
    );
    expect(getSessionArchiveBlock({ owner }, "in-turn").archiveBlockCode).toBe(
      "agent_in_turn",
    );
    expect(getSessionArchiveBlock({ owner }, "idle").archiveBlockCode).toBe(
      owner === "external" ? "external_active" : undefined,
    );
  }
});
