import type { ModelInfo } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import catalog from "../../../../shared/test/fixtures/cursor-model-catalog.json";
import {
  buildCursorModelValue,
  getCursorModelSelection,
  getPreferredCursorModelId,
  parseCursorModelBadge,
  selectCursorModels,
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
    expect(parseCursorModelBadge("auto")).toBeNull();
    expect(parseCursorModelBadge("grok-4.7")).toBeNull();
    expect(parseCursorModelBadge("grok-4.7[unknown=true]")).toBeNull();
  });
  it("reads effort and Fast out of a legacy variant slug without inventing context", () => {
    expect(parseCursorModelBadge("claude-opus-5-5-high")).toEqual({
      modelId: "claude-opus-5-5",
      reasoning: "high",
    });
    expect(parseCursorModelBadge("gpt-5.6-sol-high-fast")).toEqual({
      modelId: "gpt-5.6-sol",
      reasoning: "high",
      fast: "true",
    });
    expect(parseCursorModelBadge("gpt-5.6-sol-1m-extra-high")).toEqual({
      modelId: "gpt-5.6-sol",
      context: "1M",
      reasoning: "extra-high",
    });
  });
  it("keeps a known model when a saved parameter is stale or differently cased", () => {
    const value = "grok-4.7[context=500K,reasoning_effort=high,fast=true]";
    const selection = getCursorModelSelection(models, value);
    expect(selection.model?.id).toBe("grok-4.7");
    expect(selection.parameters).toMatchObject({
      context: "500k",
      reasoning_effort: "high",
      fast: "true",
    });
    expect(getPreferredCursorModelId(models, value)).toBe(
      "grok-4.7[context=500k,reasoning_effort=high,fast=true]",
    );
    expect(getPreferredCursorModelId(models, "gpt-5.6-sol[context=2m]")).toBe(
      "gpt-5.6-sol[context=272k,reasoning=medium,fast=false]",
    );
    expect(getPreferredCursorModelId(models, "gpt-5.6-sol[unknown=true]")).toBe(
      "gpt-5.6-sol[context=272k,reasoning=medium,fast=false]",
    );
  });
  it("maps a legacy variant onto that model's supported controls", () => {
    const selection = getCursorModelSelection(models, "gpt-5.6-sol-high-fast");
    expect(selection.parameters).toMatchObject({
      context: "272k",
      reasoning: "high",
      fast: "true",
    });
    expect(getPreferredCursorModelId(models, "gpt-5.6-sol-high-fast")).toBe(
      "gpt-5.6-sol[context=272k,reasoning=high,fast=true]",
    );
  });
  it("leaves an unrecognized model id unchanged", () => {
    const value = "not-a-cursor-model-high";
    expect(getCursorModelSelection(models, value).model).toBeUndefined();
    expect(getPreferredCursorModelId(models, value)).toBe(value);
  });
  it("lets a parameterized catalog replace a flat model list", () => {
    const flat = [{ id: "grok-4.7", name: "Grok 4.7" }];
    expect(selectCursorModels(flat, null)).toEqual(flat);
    expect(selectCursorModels(flat, models)).toBe(models);
    expect(selectCursorModels(models, flat)).toBe(models);
  });
});
