import { describe, expect, it } from "vitest";
import {
  getOpenCodeModelLimits,
  parseOpenCodeAdvancedInput,
} from "../NewSessionForm";

describe("OpenCode new-session configuration", () => {
  it("parses context and output values expressed in K tokens", () => {
    expect(getOpenCodeModelLimits("1000", "32")).toEqual({
      limits: { context: 1_000_000, output: 32_000 },
    });
  });

  it("requires both model limits when either one is set", () => {
    expect(getOpenCodeModelLimits("1000", "")).toEqual({
      error: "incomplete",
    });
  });

  it("accepts only JSON objects for advanced provider/model patches", () => {
    expect(
      parseOpenCodeAdvancedInput(
        '{"options":{"headers":{"X-Sub-Module":"coding"}}}',
      ),
    ).toEqual({
      value: {
        options: { headers: { "X-Sub-Module": "coding" } },
      },
    });
    expect(parseOpenCodeAdvancedInput("[]")).toEqual({ error: "invalid" });
    expect(parseOpenCodeAdvancedInput("{")).toEqual({ error: "invalid" });
  });
});
