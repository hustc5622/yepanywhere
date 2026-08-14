import { describe, expect, it } from "vitest";
import { getAllProviders, getProvider } from "./registry";

describe("provider registry", () => {
  it("keeps retired Claude metadata for history without listing its SSH channel", () => {
    expect(getAllProviders().map((provider) => provider.id)).not.toContain(
      "claude",
    );
    expect(getProvider("claude")).toMatchObject({
      id: "claude",
      displayName: "Claude Code (SSH)",
    });
  });
});
