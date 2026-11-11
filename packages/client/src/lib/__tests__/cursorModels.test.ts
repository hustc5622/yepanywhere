import type { ModelInfo } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import catalog from "../../../../shared/test/fixtures/cursor-model-catalog.json";
import {
  buildCursorModelValue,
  getCursorModelSelection,
  getPreferredCursorModelId,
  parseCursorModelBadge,
} from "../cursorModels";

const models: ModelInfo[] = catalog.models.map((model) => ({
  id: model.value === "default" ? "auto" : model.value,
  name: model.name,
  cursorConfigOptions: model.configOptions,
}));

describe("Cursor model expressions", () => {
  it("makes native defaults explicit so the CLI's previous settings cannot override the displayed choices", () => {
    expect(getPreferredCursorModelId(models, "gpt-5.6-sol")).toBe(
      "gpt-5.6-sol[context=272k,reasoning=medium,fast=false]",
    );
    expect(getPreferredCursorModelId(models, "default")).toBe("auto");
    expect(getPreferredCursorModelId(models)).toBe("auto");
  });
  it("keeps all selected parameters through serialization and restores false values", () => {
    const value =
      "claude-opus-5[thinking=false,context=1m,effort=max,fast=false]";
    const selection = getCursorModelSelection(models, value);
    expect(selection.parameters).toEqual({
      thinking: "false",
      context: "1m",
      effort: "max",
      fast: "false",
    });
    if (!selection.model) throw new Error("Missing model");
    expect(buildCursorModelValue(selection.model, selection.parameters)).toBe(
      value,
    );
  });
  it("reads Fast, context, and reasoning out of a stored expression", () => {
    expect(
      parseCursorModelBadge(
        "grok-4.7[context=500k,reasoning_effort=high,fast=false]",
      ),
    ).toEqual({
      context: "500K",
      reasoning: "high",
      fast: "false",
    });
    expect(
      parseCursorModelBadge(
        "claude-opus-5[thinking=false,context=1m,effort=max,fast=true]",
      ),
    ).toEqual({
      context: "1M",
      thinking: "false",
      reasoning: "max",
      fast: "true",
    });
    expect(parseCursorModelBadge("gpt-5.6-sol-high-fast")).toBeNull();
    expect(parseCursorModelBadge("auto")).toBeNull();
    expect(parseCursorModelBadge("grok-4.7[unknown=true]")).toBeNull();
  });
  it.each([
    "gpt-5.6-sol-high-fast",
    "gpt-5.6-sol[context=2m]",
    "gpt-5.6-sol[unknown=true]",
  ])("preserves %s without silently substituting other choices", (value) => {
    expect(getCursorModelSelection(models, value).model).toBeUndefined();
    expect(getPreferredCursorModelId(models, value)).toBe(value);
  });
});
