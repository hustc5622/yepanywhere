import { toUrlProjectId } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import { buildSessionInfoText } from "../SessionMenu";

const PROJECT_PATH = "/Users/someone/Desktop/work/M3_Inspector";
const PROJECT_ID = toUrlProjectId(PROJECT_PATH);
const SESSION_ID = "ses_057783e17ffefp2p2H3Xpz0mO4";

function parse(text: string): Record<string, string> {
  return Object.fromEntries(
    text.split("\n").map((line) => {
      const index = line.indexOf(": ");
      return [line.slice(0, index), line.slice(index + 2)];
    }),
  );
}

describe("buildSessionInfoText", () => {
  it("carries the project path and a deep link so a bare id is locatable", () => {
    const rows = parse(
      buildSessionInfoText({
        sessionId: SESSION_ID,
        projectId: PROJECT_ID,
        title: "Yep Anywhere Session",
        provider: "opencode",
      }),
    );

    expect(rows).toEqual({
      Title: "Yep Anywhere Session",
      "Session ID": SESSION_ID,
      Provider: "opencode",
      Project: PROJECT_PATH,
      Link: `${window.location.origin}/projects/${PROJECT_ID}/sessions/${SESSION_ID}`,
    });
  });

  it("keeps row order stable", () => {
    const text = buildSessionInfoText({
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      title: "T",
      provider: "codex",
    });

    expect(text.split("\n").map((line) => line.split(": ")[0])).toEqual([
      "Title",
      "Session ID",
      "Provider",
      "Project",
      "Link",
    ]);
  });

  it("omits rows that have no value", () => {
    const text = buildSessionInfoText({
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      title: "   ",
    });

    expect(text).not.toContain("Title:");
    expect(text).not.toContain("Provider:");
    expect(text).toContain(`Session ID: ${SESSION_ID}`);
    expect(text).toContain(`Project: ${PROJECT_PATH}`);
  });

  it("omits the project row when the id does not decode to a path", () => {
    const text = buildSessionInfoText({
      sessionId: SESSION_ID,
      // Valid base64url, but decodes to bytes that are not an absolute path.
      projectId: "AAAB",
    });

    expect(text).not.toContain("Project:");
    // The link stays usable — it round-trips whatever the router gave us.
    expect(text).toContain(`Link: ${window.location.origin}`);
  });

  it("handles non-ascii project paths", () => {
    const path = "/Users/someone/工作/项目";
    const text = buildSessionInfoText({
      sessionId: SESSION_ID,
      projectId: toUrlProjectId(path),
    });

    expect(text).toContain(`Project: ${path}`);
  });
});
