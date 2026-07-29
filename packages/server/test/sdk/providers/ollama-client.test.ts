import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OllamaClient,
  getOllamaUrl,
  normalizeOllamaUrl,
  setOllamaUrl,
} from "../../../src/sdk/providers/ollama-client.js";

describe("OllamaClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setOllamaUrl();
  });

  it("规范化 URL 并拒绝非 HTTP 协议", () => {
    expect(normalizeOllamaUrl("http://host:11434/")).toBe("http://host:11434");
    expect(() => normalizeOllamaUrl("file:///tmp/ollama")).toThrow(
      "http 或 https",
    );
  });

  it("远程 URL 同时作为共享 provider 配置", () => {
    setOllamaUrl("https://ollama.example.test/");
    expect(getOllamaUrl()).toBe("https://ollama.example.test");
  });

  it("通过 HTTP API 获取模型及上下文信息", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/api/tags")) {
          return new Response(
            JSON.stringify({ models: [{ name: "qwen:32k", size: 42 }] }),
          );
        }
        return new Response(
          JSON.stringify({
            parameters: "num_ctx 32768",
            details: { parameter_size: "32B", quantization_level: "Q4" },
          }),
        );
      }),
    );

    await expect(
      new OllamaClient("http://remote:11434").listModels(),
    ).resolves.toEqual([
      {
        id: "qwen:32k",
        name: "qwen:32k",
        size: 42,
        contextWindow: 32768,
        parameterSize: "32B",
        parentModel: undefined,
        quantizationLevel: "Q4",
      },
    ]);
  });
});
