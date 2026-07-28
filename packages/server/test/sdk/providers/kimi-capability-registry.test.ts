import { describe, expect, it } from "vitest";
import {
  type KimiProviderType,
  getKimiModelCapability,
  isUnknownDetectedCapability,
} from "../../../src/sdk/providers/kimi-capability-registry.js";

describe("getKimiModelCapability", () => {
  describe("openai wire", () => {
    it("detects gpt-4o as vision-capable", () => {
      const cap = getKimiModelCapability("openai", "gpt-4o");
      expect(cap.image_in).toBe(true);
      expect(cap.tool_use).toBe(true);
    });

    it("detects gpt-4-turbo as vision-capable", () => {
      const cap = getKimiModelCapability("openai", "gpt-4-turbo");
      expect(cap.image_in).toBe(true);
    });

    it("detects gpt-4.1 and gpt-4.5 as vision-capable", () => {
      expect(getKimiModelCapability("openai", "gpt-4.1").image_in).toBe(true);
      expect(getKimiModelCapability("openai", "gpt-4.5").image_in).toBe(true);
    });

    it("detects o-series as reasoning (no image_in)", () => {
      const cap = getKimiModelCapability("openai", "o3-mini");
      expect(cap.image_in).toBe(false);
      expect(cap.thinking).toBe(true);
      expect(cap.tool_use).toBe(true);
    });

    it("detects gpt-3.5-turbo as text-only (no image_in)", () => {
      const cap = getKimiModelCapability("openai", "gpt-3.5-turbo");
      expect(cap.image_in).toBe(false);
      expect(cap.thinking).toBe(false);
      expect(cap.tool_use).toBe(true);
    });

    it("returns unknown for uncatalogued openai models", () => {
      const cap = getKimiModelCapability("openai", "some-future-model");
      expect(isUnknownDetectedCapability(cap)).toBe(true);
      expect(cap.image_in).toBe(false);
    });

    it("matches case-insensitively", () => {
      expect(getKimiModelCapability("openai", "GPT-4O").image_in).toBe(true);
      expect(getKimiModelCapability("openai", "O3-MINI").image_in).toBe(false);
    });
  });

  describe("openai_responses wire", () => {
    it("detects gpt-4o as vision-capable", () => {
      expect(
        getKimiModelCapability("openai_responses", "gpt-4o").image_in,
      ).toBe(true);
    });

    it("detects o-series as reasoning", () => {
      expect(getKimiModelCapability("openai_responses", "o1").image_in).toBe(
        false,
      );
      expect(getKimiModelCapability("openai_responses", "o1").thinking).toBe(
        true,
      );
    });

    it("does not have the gpt-3.5-turbo text entry", () => {
      const cap = getKimiModelCapability("openai_responses", "gpt-3.5-turbo");
      expect(isUnknownDetectedCapability(cap)).toBe(true);
    });
  });

  describe("anthropic wire", () => {
    it("detects claude-3-* as vision-capable", () => {
      expect(
        getKimiModelCapability("anthropic", "claude-3-opus").image_in,
      ).toBe(true);
      expect(
        getKimiModelCapability("anthropic", "claude-3.5-sonnet").image_in,
      ).toBe(true);
      expect(
        getKimiModelCapability("anthropic", "claude-3.7-sonnet").image_in,
      ).toBe(true);
    });

    it("detects claude-4-* as vision + thinking", () => {
      const cap = getKimiModelCapability("anthropic", "claude-opus-4");
      expect(cap.image_in).toBe(true);
      expect(cap.thinking).toBe(true);
      expect(
        getKimiModelCapability("anthropic", "claude-sonnet-4").image_in,
      ).toBe(true);
      expect(
        getKimiModelCapability("anthropic", "claude-haiku-4").image_in,
      ).toBe(true);
      expect(getKimiModelCapability("anthropic", "claude-fable").image_in).toBe(
        true,
      );
    });

    it("returns unknown for non-claude anthropic models", () => {
      const cap = getKimiModelCapability("anthropic", "some-other-model");
      expect(isUnknownDetectedCapability(cap)).toBe(true);
    });
  });

  describe("google-genai / vertexai wire", () => {
    it("detects gemini-1.5-* as multimodal", () => {
      const cap = getKimiModelCapability("google-genai", "gemini-1.5-pro");
      expect(cap.image_in).toBe(true);
      expect(cap.thinking).toBe(false);
    });

    it("detects gemini-2.5-* as thinking multimodal", () => {
      const cap = getKimiModelCapability("google-genai", "gemini-2.5-pro");
      expect(cap.image_in).toBe(true);
      expect(cap.thinking).toBe(true);
    });

    it("detects gemini with 'thinking' in name as thinking multimodal", () => {
      const cap = getKimiModelCapability(
        "google-genai",
        "gemini-2.0-flash-thinking",
      );
      expect(cap.image_in).toBe(true);
      expect(cap.thinking).toBe(true);
    });

    it("returns unknown for non-gemini models", () => {
      expect(
        isUnknownDetectedCapability(
          getKimiModelCapability("google-genai", "palm-2"),
        ),
      ).toBe(true);
    });

    it("returns unknown for uncatalogued gemini variants", () => {
      expect(
        isUnknownDetectedCapability(
          getKimiModelCapability("google-genai", "gemini-0.5-pro"),
        ),
      ).toBe(true);
    });

    it("vertexai uses the same catalog as google-genai", () => {
      expect(
        getKimiModelCapability("vertexai", "gemini-2.5-pro").image_in,
      ).toBe(true);
    });
  });

  describe("kimi wire", () => {
    it("always returns unknown (catalog detection is not available)", () => {
      const cap = getKimiModelCapability("kimi", "kimi-k3");
      expect(isUnknownDetectedCapability(cap)).toBe(true);
    });
  });

  it("isUnknownDetectedCapability identifies the sentinel", () => {
    expect(
      isUnknownDetectedCapability(getKimiModelCapability("kimi", "x")),
    ).toBe(true);
    expect(
      isUnknownDetectedCapability(getKimiModelCapability("openai", "gpt-4o")),
    ).toBe(false);
  });
});
