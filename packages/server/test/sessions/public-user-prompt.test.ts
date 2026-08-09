import { describe, expect, it } from "vitest";
import {
  sanitizeCodexPublicUserPrompt,
  sanitizeCodexUserContentBlockText,
  sanitizePublicUserPrompt,
} from "../../src/sessions/public-user-prompt.js";

describe("public user prompt projection", () => {
  it("removes only managed upload locations and preserves ordinary path prose", () => {
    const managedPath = "/test/runtime/uploads/report.pdf";
    const ordinaryPath = "/workspace/project/README.md";
    const prompt = `Review ${ordinaryPath}\n\nUser uploaded files:\n- report.pdf (2.0 KB, application/pdf): ${managedPath}`;

    const projected = sanitizePublicUserPrompt(prompt);

    expect(projected).toContain(ordinaryPath);
    expect(projected).toContain("report.pdf");
    expect(projected).toContain("[managed attachment]");
    expect(projected).not.toContain(managedPath);
  });

  it("projects pinned Codex local-media tags without scanning ordinary paths", () => {
    const imagePath = "/test/runtime/media/private.png";
    const ordinary = "Compare /workspace/project/a.ts with C:\\repo\\b.ts";
    const prompt = `${ordinary}\n<image name=[Image #1] path="${imagePath}">binary</image>`;

    const projected = sanitizeCodexPublicUserPrompt(prompt);

    expect(projected).toContain(ordinary);
    expect(projected).toContain("<image></image>");
    expect(projected).not.toContain(imagePath);
  });

  it("fails closed for malformed provider media markup and fixed read errors", () => {
    expect(
      sanitizeCodexPublicUserPrompt(
        'before <audio name=[Audio #1] path="/test/runtime/private.wav">',
      ),
    ).toBe("before [managed audio attachment]");
    expect(
      sanitizeCodexUserContentBlockText(
        "Codex could not read the local image at `/test/runtime/broken.png`: denied",
      ),
    ).toBe("Codex could not read the [managed image attachment].");
  });
});
