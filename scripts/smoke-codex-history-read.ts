#!/usr/bin/env npx tsx

import { createHash } from "node:crypto";

import { CodexHistoryClient } from "../packages/server/src/codex-history/CodexHistoryClient.js";
import { CodexSessionCatalog } from "../packages/server/src/codex-history/CodexSessionCatalog.js";
import { getDefaultCodexSessionsDir } from "../packages/server/src/projects/codex-scanner.js";
import { findCodexCliPath } from "../packages/server/src/sdk/cli-detection.js";
import type { Thread } from "../packages/server/src/sdk/providers/codex-protocol/generated/v2/Thread.js";

const PAGE_LIMIT = 25;
const MAX_LIST_PAGES = 20;

function parseSessionId(): string | undefined {
  const argument = process.argv.find((value) => value.startsWith("--session="));
  return argument?.slice("--session=".length) || undefined;
}

function idHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

async function findPaginatedThread(
  client: CodexHistoryClient,
  requestedSessionId: string | undefined,
): Promise<{ thread: Thread; listedThreads: number }> {
  let cursor: string | null | undefined;
  let listedThreads = 0;
  for (let pageIndex = 0; pageIndex < MAX_LIST_PAGES; pageIndex += 1) {
    const page = await client.listThreads({
      cursor,
      limit: PAGE_LIMIT,
      sortKey: "updated_at",
      sortDirection: "desc",
      modelProviders: [],
      sourceKinds: ["cli", "vscode", "exec", "appServer"],
      archived: false,
      sectionId: undefined,
      cwd: undefined,
      useStateDbOnly: true,
      searchTerm: undefined,
      parentThreadId: undefined,
      ancestorThreadId: undefined,
    });
    listedThreads += page.data.length;
    const match = page.data.find((thread) =>
      requestedSessionId
        ? thread.id === requestedSessionId
        : thread.historyMode === "paginated",
    );
    if (match) {
      if (match.historyMode !== "paginated") {
        throw new Error("Requested thread is not paginated");
      }
      return { thread: match, listedThreads };
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  throw new Error(
    requestedSessionId
      ? "Requested paginated thread was not present in the state DB listing"
      : "No paginated thread was present in the bounded state DB listing",
  );
}

async function main(): Promise<void> {
  if (!process.argv.includes("--read-only")) {
    throw new Error("This smoke requires the explicit --read-only flag");
  }
  const command = process.env.CODEX_PATH ?? (await findCodexCliPath());
  if (!command) {
    throw new Error(
      "Codex CLI not found; set CODEX_PATH to run the smoke test",
    );
  }

  const client = new CodexHistoryClient({ command, cwd: process.cwd() });
  const startedAt = performance.now();
  try {
    const listStartedAt = performance.now();
    const { thread, listedThreads } = await findPaginatedThread(
      client,
      parseSessionId(),
    );
    const listMs = performance.now() - listStartedAt;

    const readStartedAt = performance.now();
    const read = await client.readThread({
      threadId: thread.id,
      includeTurns: false,
    });
    const readMs = performance.now() - readStartedAt;

    const turnsStartedAt = performance.now();
    const turns = await client.listTurns({
      threadId: thread.id,
      cursor: null,
      limit: PAGE_LIMIT,
      sortDirection: "desc",
      itemsView: "notLoaded",
    });
    const turnsMs = performance.now() - turnsStartedAt;

    const itemsStartedAt = performance.now();
    const items = await client.listItems({
      threadId: thread.id,
      turnId: null,
      cursor: null,
      limit: PAGE_LIMIT,
      sortDirection: "desc",
    });
    const itemsMs = performance.now() - itemsStartedAt;

    let cursorRoundTrip:
      | {
          exercised: boolean;
          olderCount: number;
          newerCount: number;
          boundaryIncludedOnce: boolean;
          forwardMatchesInitial: boolean;
          roundTripMatchesOlder: boolean;
        }
      | undefined;
    if (items.nextCursor) {
      const older = await client.listItems({
        threadId: thread.id,
        turnId: null,
        cursor: items.nextCursor,
        limit: 2,
        sortDirection: "desc",
      });
      if (older.data.length > 0 && older.backwardsCursor) {
        const newer = await client.listItems({
          threadId: thread.id,
          turnId: null,
          cursor: older.backwardsCursor,
          limit: PAGE_LIMIT,
          sortDirection: "asc",
        });
        const roundTrip = newer.backwardsCursor
          ? await client.listItems({
              threadId: thread.id,
              turnId: null,
              cursor: newer.backwardsCursor,
              limit: older.data.length,
              sortDirection: "desc",
            })
          : null;
        const olderIds = older.data.map((entry) => entry.item.id);
        const newerIds = newer.data.map((entry) => entry.item.id);
        const initialChronologicalIds = items.data
          .map((entry) => entry.item.id)
          .reverse();
        cursorRoundTrip = {
          exercised: true,
          olderCount: olderIds.length,
          newerCount: newerIds.length,
          boundaryIncludedOnce: newerIds[0] === olderIds[0],
          forwardMatchesInitial: newerIds
            .slice(1)
            .every((id, index) => id === initialChronologicalIds[index]),
          roundTripMatchesOlder:
            roundTrip !== null &&
            roundTrip.data.length === olderIds.length &&
            roundTrip.data.every(
              (entry, index) => entry.item.id === olderIds[index],
            ),
        };
      }
    }

    const catalog = new CodexSessionCatalog({
      client,
      ttlMs: 60_000,
      sessionsDir: getDefaultCodexSessionsDir(),
    });
    const catalogFirstStartedAt = performance.now();
    const catalogFirst = await catalog.getSnapshot();
    const catalogFirstMs = performance.now() - catalogFirstStartedAt;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    const catalogSecondStartedAt = performance.now();
    const catalogSecond = await catalog.getSnapshot();
    const catalogSecondMs = performance.now() - catalogSecondStartedAt;
    const catalogSnapshot = catalogSecond ?? catalogFirst;
    const catalogSourceCounts = {
      cli: 0,
      vscode: 0,
      exec: 0,
      appServer: 0,
      other: 0,
    };
    for (const session of catalogSnapshot?.sessions ?? []) {
      const source = session.source;
      if (source === "cli" || source === "vscode" || source === "exec") {
        catalogSourceCounts[source] += 1;
      } else if (source === "mcp" || source === "appServer") {
        catalogSourceCounts.appServer += 1;
      } else {
        catalogSourceCounts.other += 1;
      }
    }

    const result = {
      readOnly: true,
      cliVersion: client.getCapability()?.protocolVersion ?? "unknown",
      threadHash: idHash(thread.id),
      historyMode: read.thread.historyMode,
      listedThreads,
      turns: turns.data.length,
      items: items.data.length,
      hasOlderTurns: turns.nextCursor !== null,
      hasOlderItems: items.nextCursor !== null,
      cursorRoundTrip: cursorRoundTrip ?? { exercised: false },
      catalogSessions:
        catalogSecond?.sessions.length ?? catalogFirst?.sessions.length ?? 0,
      catalogProjects:
        catalogSecond?.byProjectPath.size ??
        catalogFirst?.byProjectPath.size ??
        0,
      catalogSourceCounts,
      timingsMs: {
        initializeAndList: Math.round(listMs),
        metadataRead: Math.round(readMs),
        turnsPage: Math.round(turnsMs),
        itemsPage: Math.round(itemsMs),
        catalogFirst: Math.round(catalogFirstMs),
        catalogSecond: Math.round(catalogSecondMs),
        total: Math.round(performance.now() - startedAt),
      },
    };
    console.log(
      JSON.stringify(result, null, process.argv.includes("--summary") ? 0 : 2),
    );
  } finally {
    client.shutdown();
  }
}

void main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Codex history smoke failed",
  );
  process.exitCode = 1;
});
