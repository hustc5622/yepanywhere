import { describe, expect, it } from "vitest";
import {
  sanitizeCodexPublicUserPrompt,
  sanitizeCodexUserContentBlockText,
  sanitizePublicUserPrompt,
} from "../../src/sessions/public-user-prompt.js";

describe("Plaintext user prompt projection", () => {
  it.each([
    "Review /workspace/project/README.md\n\nUser uploaded files:\n- report.pdf (2.0 KB, application/pdf): /test/runtime/uploads/report.pdf",
    '<image name=[Image #1] path="/test/runtime/private.png">binary</image>',
    'before <audio name=[Audio #1] path="/test/runtime/private.wav">',
    "Codex could not read the local image at `/test/runtime/broken.png`: denied",
    "api_key=fixture-secret-value",
  ])("keeps original content: %s", (text) => {
    expect(sanitizePublicUserPrompt(text)).toBe(text);
    expect(sanitizeCodexPublicUserPrompt(text)).toBe(text);
    expect(sanitizeCodexUserContentBlockText(text)).toBe(text);
  });
});
