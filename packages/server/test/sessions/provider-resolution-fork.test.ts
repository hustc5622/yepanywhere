import type { UrlProjectId } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import {
  findSessionSummaryAcrossProviders,
  listSessionsAcrossProviders,
} from "../../src/sessions/provider-resolution.js";
import type { ISessionReader } from "../../src/sessions/types.js";
import type { Project, SessionSummary } from "../../src/supervisor/types.js";

const projectId = "L3JlcG8" as UrlProjectId;
const project: Project = {
  id: projectId,
  path: "/repo",
  name: "repo",
  sessionCount: 2,
  sessionDir: "/sessions",
  activeOwnedCount: 0,
  activeExternalCount: 0,
  lastActivity: null,
  provider: "claude",
};

function summary(id: string, updatedAt: string): SessionSummary {
  return {
    id,
    projectId,
    title: id,
    fullTitle: id,
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt,
    messageCount: 1,
    ownership: { owner: "none" },
    provider: "codex",
  };
}

function reader(summaries: SessionSummary[]): ISessionReader {
  return {
    listSessions: async () => summaries,
    getSessionSummary: async (sessionId) =>
      summaries.find((item) => item.id === sessionId) ?? null,
    getSession: async () => null,
    getSessionSummaryIfChanged: async () => null,
    getAgentMappings: async () => [],
    getAgentSession: async () => null,
  };
}

describe("provider fork lineage resolution", () => {
  it("merges manual Codex lineage before collapsing a fork family", async () => {
    const source = summary("source", "2026-08-08T00:00:00.000Z");
    const child = summary("child", "2026-08-08T01:00:00.000Z");
    const sessionReader = reader([source, child]);
    const deps = {
      readerFactory: () => sessionReader,
      sessionMetadataService: {
        getForkParentSessionId: (sessionId: string) =>
          sessionId === "child" ? "source" : undefined,
      },
    };

    await expect(listSessionsAcrossProviders(project, deps)).resolves.toEqual([
      expect.objectContaining({
        id: "child",
        forkParentSessionId: "source",
      }),
    ]);

    await expect(
      findSessionSummaryAcrossProviders(
        project,
        "child",
        projectId,
        deps,
        "claude",
      ),
    ).resolves.toMatchObject({
      summary: { id: "child", forkParentSessionId: "source" },
    });
  });

  it("keeps provider-native lineage ahead of the sidecar fallback", async () => {
    const child = {
      ...summary("child", "2026-08-08T01:00:00.000Z"),
      forkParentSessionId: "native-source",
    };
    const deps = {
      readerFactory: () => reader([child]),
      sessionMetadataService: {
        getForkParentSessionId: () => "stale-sidecar-source",
      },
    };

    await expect(
      findSessionSummaryAcrossProviders(
        project,
        "child",
        projectId,
        deps,
        "claude",
      ),
    ).resolves.toMatchObject({
      summary: { forkParentSessionId: "native-source" },
    });
  });
});
