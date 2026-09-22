import { readFile, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { getLogger } from "../logging/logger.js";
import type { SessionFileOperationStore } from "./operation-store.js";
import { contentId } from "./store.js";

const ArtifactSchema = z
  .object({
    version: z.literal(1),
    sessionId: z.string().min(1),
    turnId: z.string().min(1),
    toolCallId: z.string().min(1),
    toolName: z.enum(["edit", "write"]),
    workspace: z.string().min(1),
    path: z.string().min(1),
    timestamp: z.string().datetime(),
    written: z.boolean(),
    before: z
      .string()
      .max(12 * 1024 * 1024)
      .nullable()
      .optional(),
    after: z
      .string()
      .max(12 * 1024 * 1024)
      .optional(),
  })
  .strict();

const imported = new WeakMap<
  SessionFileOperationStore,
  Map<string, { stamp: string; failures: number }>
>();
const pendingImports = new WeakMap<
  SessionFileOperationStore,
  Map<string, Promise<number>>
>();

/** Coalesce the provider notification and API poll for the same artifact bucket. */
export function importPiFileOperations(
  store: SessionFileOperationStore,
  sessionId: string,
): Promise<number> {
  let pending = pendingImports.get(store);
  if (!pending) {
    pending = new Map();
    pendingImports.set(store, pending);
  }
  const existing = pending.get(sessionId);
  if (existing) return existing;
  const task = readPiFileOperations(store, sessionId).finally(() => {
    if (pending.get(sessionId) === task) pending.delete(sessionId);
  });
  pending.set(sessionId, task);
  return task;
}

/** Read only the execution extension's session bucket, never any workspace paths. */
async function readPiFileOperations(
  store: SessionFileOperationStore,
  sessionId: string,
): Promise<number> {
  const folder = join(store.directory, "pi-ingress", contentId(sessionId));
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  const stamp = `${info.mtimeMs}:${info.ctimeMs}`;
  let cache = imported.get(store);
  if (!cache) {
    cache = new Map();
    imported.set(store, cache);
  }
  const previous = cache.get(sessionId);
  if (previous?.stamp === stamp && !previous.failures) return 0;
  let failures = 0;
  const names = (await readdir(folder)).filter((name) =>
    /^[a-f0-9]{64}\.json$/.test(name),
  );
  if (names.length > 20_000)
    throw new Error("Pi file operation import limit exceeded");
  for (const name of names) {
    try {
      const path = join(folder, name);
      if ((await stat(path)).size > 24 * 1024 * 1024)
        throw new Error("Pi file operation artifact too large");
      const text = await readFile(path, "utf8");
      if (contentId(text) !== name.slice(0, -5))
        throw new Error("Pi file operation artifact integrity failure");
      const raw = ArtifactSchema.parse(JSON.parse(text));
      if (raw.sessionId !== sessionId)
        throw new Error("Pi file operation session mismatch");
      const save = async (value: string | null | undefined) => {
        if (value === null || value === undefined) return value;
        try {
          return await store.putContent(Buffer.from(value, "base64"));
        } catch {
          return undefined;
        }
      };
      const before = await save(raw.before);
      const after = await save(raw.after);
      await store.append({
        schemaVersion: 1,
        identity: {
          provider: "pi",
          sourceId: "local",
          sessionId,
          turnId: raw.turnId,
          toolCallId: raw.toolCallId,
        },
        branchId: sessionId,
        messageId: raw.toolCallId,
        workspace: raw.workspace,
        timestamp: raw.timestamp,
        order: Date.parse(raw.timestamp),
        toolName: raw.toolName,
        source: "instrumented-write",
        outcome: raw.written ? "applied" : "unknown",
        ...(raw.written ? { resultId: name.slice(0, -5) } : {}),
        changes: [
          {
            path: raw.path,
            kind: before === null ? "added" : "modified",
            outcome: raw.written ? "applied" : "unknown",
            before,
            after,
            ...(before === undefined || after === undefined
              ? {
                  unavailableReason:
                    raw.before === undefined || raw.after === undefined
                      ? ("content-not-recorded" as const)
                      : ("capture-failed" as const),
                }
              : {}),
          },
        ],
      });
      // The ledger and referenced blobs are durable before retiring the ingress copy.
      await unlink(path);
    } catch (error) {
      // Another process may have imported and retired the same immutable artifact.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      failures++;
      getLogger().warn(
        { sessionId, error },
        "Pi file operation artifact could not be imported",
      );
    }
  }
  cache.set(sessionId, { stamp, failures });
  if (cache.size > 32) cache.delete(cache.keys().next().value ?? "");
  return failures;
}
