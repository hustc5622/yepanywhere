/** Isolated benchmark: no model calls, no live services, no reads of real workspaces. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { recordCodexFileNotification } from "../packages/server/src/session-files/codex-operations.js";
import { projectFileOperations } from "../packages/server/src/session-files/operation-projection.js";
import { SessionFileOperationStore } from "../packages/server/src/session-files/operation-store.js";

const raw =
  process.argv.find((arg) => arg.startsWith("--sizes="))?.slice(8) ?? "10,1000";
const sizes = raw.split(",").map(Number);
if (sizes.some((n) => !Number.isInteger(n) || n < 0 || n > 100_000))
  throw new Error("sizes must be integers between 0 and 100000");
const root = await mkdtemp(join(tmpdir(), "yep-operation-benchmark-"));
const rows = [];
try {
  const workspace = join(root, "project");
  await mkdir(workspace);
  let created = 0;
  for (const files of sizes.sort((a, b) => a - b)) {
    // Fixture creation is excluded from the operation/index latency measurements.
    while (created < files) {
      const end = Math.min(files, created + 200);
      await Promise.all(
        Array.from({ length: end - created }, (_, i) =>
          writeFile(
            join(workspace, `unrelated-${created + i}.txt`),
            "unchanged\n",
          ),
        ),
      );
      created = end;
    }
    for (const sessions of [1, 4, 8]) {
      const samples: number[] = [];
      for (let iteration = 0; iteration < 5; iteration++) {
        const store = new SessionFileOperationStore(
          join(root, `store-${files}-${sessions}-${iteration}`),
        );
        const started = performance.now();
        await Promise.all(
          Array.from({ length: sessions }, async (_, index) => {
            const sessionId = `s-${index}`;
            await recordCodexFileNotification(
              store,
              { sessionId, workspace },
              {
                method: "item/completed",
                params: {
                  threadId: sessionId,
                  turnId: "t",
                  item: {
                    id: "patch",
                    type: "fileChange",
                    status: "completed",
                    changes: [
                      {
                        path: `own-${index}.md`,
                        kind: { type: "add" },
                        diff: "# Own file\n",
                      },
                    ],
                  },
                },
              },
            );
            const snapshot = await store.snapshot({
              provider: "codex",
              sourceId: "local",
              sessionId,
            });
            const projected = await projectFileOperations(
              store,
              snapshot.operations,
              workspace,
              new Map([["t", "u"]]),
            );
            if (
              projected.files.length !== 1 ||
              projected.files[0]?.path !== `own-${index}.md` ||
              projected.files[0]?.additions !== 1
            )
              throw new Error("Cross-session isolation failed");
            if (
              (
                await store.snapshot({
                  provider: "codex",
                  sourceId: "local",
                  sessionId,
                })
              ).revision !== snapshot.revision
            )
              throw new Error("Warm revision changed");
          }),
        );
        samples.push(performance.now() - started);
      }
      samples.sort((a, b) => a - b);
      rows.push({
        unrelatedFiles: files,
        concurrentSessions: sessions,
        repetitions: 5,
        medianMs: Number(samples[2]?.toFixed(2)),
        maxMs: Number(samples[4]?.toFixed(2)),
      });
    }
  }
  console.log(
    JSON.stringify(
      {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        rows,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
