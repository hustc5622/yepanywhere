import { describe, expect, it } from "vitest";
import { isGeneratedArtifactDownloadUrl } from "../src/generated-artifact.js";

describe("isGeneratedArtifactDownloadUrl", () => {
  it("accepts only a canonical relative managed upload route", () => {
    expect(
      isGeneratedArtifactDownloadUrl(
        `/api/projects/cHJvamVjdA/sessions/session-1/generated-artifact/ga_${"a".repeat(32)}/${"b".repeat(64)}/%E6%8A%A5%E5%91%8A.pdf`,
      ),
    ).toBe(true);
  });

  it.each([
    "https://attacker.example/artifact",
    `/api/projects/project/sessions/session/generated-artifact/ga_${"a".repeat(32)}/${"b".repeat(64)}/../../secret`,
    `/api/projects/%2e%2e/sessions/session/generated-artifact/ga_${"a".repeat(32)}/${"b".repeat(64)}/report.pdf`,
    `/api/projects/project/sessions/%2e%2e/generated-artifact/ga_${"a".repeat(32)}/${"b".repeat(64)}/report.pdf`,
    `/api/projects/project/sessions/session/generated-artifact/ga_${"a".repeat(32)}/${"b".repeat(64)}/%2Fsecret.pdf`,
    `/api/projects/project/sessions/session/generated-artifact/not-opaque/${"b".repeat(64)}/report.pdf`,
    `/api/projects/project/sessions/session/generated-artifact/ga_${"a".repeat(32)}/short/report.pdf`,
    "/api/projects/project/sessions/session/upload/123e4567-e89b-12d3-a456-426614174000_report.pdf",
  ])("rejects a forged or non-canonical route: %s", (url) => {
    expect(isGeneratedArtifactDownloadUrl(url)).toBe(false);
  });
});
