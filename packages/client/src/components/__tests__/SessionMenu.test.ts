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
        provider: "pi",
      }),
    );

    expect(rows).toEqual({
      Title: "Yep Anywhere Session",
      "Session ID": SESSION_ID,
      Provider: "pi",
      Project: PROJECT_PATH,
      Link: `${window.location.origin}/projects/${PROJECT_ID}/sessions/${SESSION_ID}`,
      "Live transcript": `${window.location.origin}/api/projects/${PROJECT_ID}/sessions/${SESSION_ID}/transcript`,
    });
  });

  it("carries the provider file so it can be opened on disk", () => {
    const sourceFile =
      "/Users/someone/.yep-anywhere/pi-agent/sessions/2026-05-01T10-00-00_abc.jsonl";
    const rows = parse(
      buildSessionInfoText({
        sessionId: SESSION_ID,
        projectId: PROJECT_ID,
        title: "T",
        provider: "pi",
        sourceFile,
      }),
    );

    expect(rows.File).toBe(sourceFile);
  });

  it("marks a remote executor's file as living on that machine", () => {
    const rows = parse(
      buildSessionInfoText({
        sessionId: SESSION_ID,
        projectId: PROJECT_ID,
        sourceFile:
          "/Users/someone/Desktop/file/UTM/claude/projects/-x/abc.jsonl",
        sourceFileHost: "192.168.64.4",
      }),
    );

    expect(rows.File).toBe(
      "/Users/someone/Desktop/file/UTM/claude/projects/-x/abc.jsonl (on 192.168.64.4, not this machine)",
    );
  });

  it("drops the File row instead of guessing a path", () => {
    const text = buildSessionInfoText({
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      sourceFile: null,
      sourceFileHost: null,
    });

    expect(text).not.toContain("File:");
    expect(text).toContain(`Session ID: ${SESSION_ID}`);
  });

  it("keeps row order stable", () => {
    const text = buildSessionInfoText({
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      title: "T",
      provider: "codex",
      sourceFile: "/tmp/s.jsonl",
    });

    expect(text.split("\n").map((line) => line.split(": ")[0])).toEqual([
      "Title",
      "Session ID",
      "Provider",
      "Project",
      "File",
      "Link",
      "Live transcript",
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

  it("flattens a first-prompt preview title into one field line", () => {
    const text = buildSessionInfoText({
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      title:
        "看看这个 pi session\n\nUser uploaded files:\n- Screenshot_2026-09-03_com.yepan...",
      provider: "pi",
    });

    expect(text).not.toContain("User uploaded files:");
    expect(parse(text).Title).toBe("看看这个 pi session");
    expect(text.split("\n")).toHaveLength(6);
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
