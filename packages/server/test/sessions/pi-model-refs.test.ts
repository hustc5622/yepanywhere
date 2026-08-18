import { describe, expect, it } from "vitest";
import {
  PI_PROVIDER_ANTHROPIC,
  PI_PROVIDER_OPENAI,
  parsePiProviderId,
  piProviderId,
  qualifyPiModelId,
  stripPiChannelPrefix,
} from "../../src/sessions/pi-model-refs.js";

const defaultChannel = { id: "default", isDefault: true };
const extraChannel = { id: "aitl", isDefault: false };

describe("pi provider ids", () => {
  it("keeps the historic unsuffixed ids for the default channel", () => {
    expect(piProviderId("anthropic", defaultChannel)).toBe(
      PI_PROVIDER_ANTHROPIC,
    );
    expect(piProviderId("openai-compatible", defaultChannel)).toBe(
      PI_PROVIDER_OPENAI,
    );
  });

  it("suffixes extra channels", () => {
    expect(piProviderId("anthropic", extraChannel)).toBe("yep-anthropic-aitl");
    expect(piProviderId("openai-compatible", extraChannel)).toBe(
      "yep-openai-compatible-aitl",
    );
  });

  it("round-trips through parsePiProviderId", () => {
    expect(parsePiProviderId("yep-anthropic")).toEqual({
      protocol: "anthropic",
    });
    expect(parsePiProviderId("yep-openai-compatible")).toEqual({
      protocol: "openai-compatible",
    });
    expect(parsePiProviderId("yep-anthropic-aitl")).toEqual({
      protocol: "anthropic",
      channelId: "aitl",
    });
    expect(parsePiProviderId("yep-openai-compatible-aitl")).toEqual({
      protocol: "openai-compatible",
      channelId: "aitl",
    });
  });

  it("ignores providers Yep did not generate", () => {
    expect(parsePiProviderId("anthropic")).toEqual({});
    expect(parsePiProviderId(undefined)).toEqual({});
    expect(parsePiProviderId("openai")).toEqual({});
  });
});

describe("pi model ids", () => {
  it("namespaces only extra channels", () => {
    expect(qualifyPiModelId(defaultChannel, "claude-opus-5")).toBe(
      "claude-opus-5",
    );
    expect(qualifyPiModelId(extraChannel, "claude-opus-5")).toBe(
      "aitl/claude-opus-5",
    );
  });

  it("strips only a prefix that matches a configured channel", () => {
    expect(stripPiChannelPrefix("aitl/claude-opus-5", ["aitl"])).toEqual({
      channelId: "aitl",
      bareModelId: "claude-opus-5",
    });
    // Gateway ids may contain slashes themselves; those must survive intact.
    expect(stripPiChannelPrefix("openai/gpt-5", ["aitl"])).toEqual({
      bareModelId: "openai/gpt-5",
    });
    expect(stripPiChannelPrefix("claude-opus-5", ["aitl"])).toEqual({
      bareModelId: "claude-opus-5",
    });
    expect(
      stripPiChannelPrefix("aitl/openai/gpt-5", ["aitl"]).bareModelId,
    ).toBe("openai/gpt-5");
  });
});
