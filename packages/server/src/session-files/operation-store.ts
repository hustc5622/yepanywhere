import {
  mkdir,
  readFile,
  readdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type SessionFileContentRef,
  type SessionFileOperation,
  type SessionFileOperationIdentity,
  SessionFileOperationIdentitySchema,
  SessionFileOperationSchema,
  type SessionFileOperationScope,
  SessionFileOperationScopeSchema,
} from "@yep-anywhere/shared";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { atomicWriteJson } from "../utils/atomic-json-file.js";
import { withFileLock } from "../utils/fileLock.js";
import { decodeSavedText } from "./reader.js";
import { SessionFileStore, contentId } from "./store.js";

const objectId = z.string().regex(/^[a-f0-9]{64}$/);
const IndexSchema = z
  .object({
    version: z.literal(1),
    storedBytes: z.number().int().nonnegative().default(0),
    limited: z.boolean().default(false),
    entries: z.record(
      objectId,
      z.object({ recordId: objectId, conflict: z.boolean() }).strict(),
    ),
  })
  .strict();
type Index = z.infer<typeof IndexSchema>;
export interface StoredFileOperation {
  id: string;
  record: SessionFileOperation;
  conflict: boolean;
}
export interface FileOperationSnapshot {
  revision: string;
  operations: readonly StoredFileOperation[];
  truncated: boolean;
}
const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const MAX_OPERATIONS = 20_000;
const MAX_SESSION_RECORD_BYTES = 64 * 1024 * 1024;

export function fileOperationId(
  identity: SessionFileOperationIdentity,
): string {
  return contentId(
    JSON.stringify(SessionFileOperationIdentitySchema.parse(identity)),
  );
}

function signature(record: SessionFileOperation): string {
  // Transport timestamps and result IDs may differ across native replay and bridge delivery.
  const {
    timestamp: _timestamp,
    order: _order,
    messageId: _message,
    resultId: _result,
    source: _source,
    ...facts
  } = record;
  // Native notifications sort paths; rollout maps can enumerate them in any
  // order. Compare the same per-file facts without rewriting stored evidence.
  return JSON.stringify({
    ...facts,
    changes: [...facts.changes].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    ),
  });
}
function terminal(record: SessionFileOperation): boolean {
  return !["pending", "unknown"].includes(record.outcome);
}

/** Session-scoped immutable facts. No methods enumerate or read the workspace. */
export class SessionFileOperationStore {
  readonly directory: string;
  private readonly blobs: SessionFileStore;
  private readonly cache = new Map<
    string,
    { stamp: string; value: FileOperationSnapshot; bytes: number }
  >();

  constructor(
    directory: string,
    private readonly maxContentBytes = 8 * 1024 * 1024,
    private readonly maxStoredContentBytes = 256 * 1024 * 1024,
  ) {
    this.directory = resolve(directory);
    this.blobs = new SessionFileStore(join(this.directory, "content"));
  }

  async putContent(bytes: Buffer): Promise<SessionFileContentRef> {
    if (bytes.length > this.maxContentBytes)
      throw new Error("File operation content limit exceeded");
    const hash = contentId(bytes);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const sentinel = join(this.directory, "content-writer");
    await writeFile(sentinel, "", { flag: "a", mode: 0o600 });
    const release = await lockfile.lock(sentinel, {
      stale: 30_000,
      retries: { retries: 40, minTimeout: 5, maxTimeout: 50 },
    });
    try {
      const quotaPath = join(this.directory, "content-quota.json");
      let quota: { bytes: number; objects: Record<string, number> } = {
        bytes: 0,
        objects: {},
      };
      try {
        quota = z
          .object({
            bytes: z.number().int().nonnegative(),
            objects: z.record(objectId, z.number().int().nonnegative()),
          })
          .strict()
          .parse(JSON.parse(await readFile(quotaPath, "utf8")));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (quota.objects[hash] === undefined) {
        if (
          quota.bytes + bytes.length > this.maxStoredContentBytes ||
          Object.keys(quota.objects).length >= 50_000
        )
          throw new Error("File operation total content quota exceeded");
        // Reserve before publication: a crash may consume quota, never exceed it.
        quota.objects[hash] = bytes.length;
        quota.bytes += bytes.length;
        await atomicWriteJson(quotaPath, quota);
      }
      await this.blobs.putBlob(bytes);
    } finally {
      await release();
    }
    return {
      hash,
      bytes: bytes.length,
      binary: decodeSavedText(bytes) === undefined,
    };
  }

  async readContent(ref: SessionFileContentRef): Promise<Buffer> {
    const bytes = await this.blobs.readBlob(ref.hash);
    if (bytes.length !== ref.bytes)
      throw new Error("File operation content size mismatch");
    return bytes;
  }

  async append(
    input: SessionFileOperation,
  ): Promise<{ inserted: boolean; conflict: boolean }> {
    const record = SessionFileOperationSchema.parse(input);
    const serialized = JSON.stringify(record);
    if (Buffer.byteLength(serialized) > MAX_RECORD_BYTES)
      throw new Error("File operation record limit exceeded");
    const directory = this.scopeDirectory(record.identity);
    await mkdir(join(directory, "records"), { recursive: true, mode: 0o700 });
    const sentinel = join(directory, "writer");
    await writeFile(sentinel, "", { flag: "a", mode: 0o600 });
    return withFileLock(sentinel, async () => {
      let index = await this.readIndex(directory);
      if (await this.dirty(directory))
        index = await this.rebuild(directory, record.identity);
      const id = fileOperationId(record.identity);
      const previous = index.entries[id];
      if (previous) {
        const old = await this.readRecord(directory, previous.recordId);
        if (signature(old) === signature(record))
          return { inserted: false, conflict: previous.conflict };
        if (terminal(old) && !terminal(record))
          return { inserted: false, conflict: previous.conflict };
      } else if (Object.keys(index.entries).length >= MAX_OPERATIONS) {
        index.limited = true;
        await atomicWriteJson(join(directory, "index.json"), index);
        throw new Error("File operation session limit exceeded");
      }
      if (
        index.storedBytes + Buffer.byteLength(serialized) >
        MAX_SESSION_RECORD_BYTES
      ) {
        index.limited = true;
        await atomicWriteJson(join(directory, "index.json"), index);
        throw new Error("File operation session record quota exceeded");
      }
      // Write intent makes a crash between fact publication and index publication recoverable.
      await writeFile(join(directory, "dirty"), "1", { mode: 0o600 });
      const recordId = contentId(serialized);
      await atomicWriteJson(
        join(directory, "records", `${recordId}.json`),
        record,
      );
      const conflict = previous
        ? previous.conflict ||
          (terminal(record) &&
            terminal(await this.readRecord(directory, previous.recordId)))
        : false;
      index.entries[id] = { recordId, conflict };
      index.storedBytes += Buffer.byteLength(serialized);
      await atomicWriteJson(join(directory, "index.json"), index);
      await unlink(join(directory, "dirty"));
      this.cache.delete(directory);
      return { inserted: true, conflict };
    });
  }

  async snapshot(
    scope: SessionFileOperationScope,
  ): Promise<FileOperationSnapshot> {
    const directory = this.scopeDirectory(scope);
    if (await this.dirty(directory)) {
      await withFileLock(join(directory, "writer"), async () => {
        if (await this.dirty(directory)) await this.rebuild(directory, scope);
      });
    }
    const stamp = await this.indexStamp(directory);
    const cached = this.cache.get(directory);
    if (cached?.stamp === stamp) return cached.value;
    const index = await this.readIndex(directory);
    const operations: StoredFileOperation[] = [];
    let bytes = 0;
    let truncated = index.limited;
    for (const [id, entry] of Object.entries(index.entries)) {
      const record = await this.readRecord(directory, entry.recordId);
      this.assertScope(record, scope);
      if (id !== fileOperationId(record.identity))
        throw new Error("File operation identity mismatch");
      bytes += Buffer.byteLength(JSON.stringify(record));
      if (bytes > 32 * 1024 * 1024 || operations.length >= 5_000) {
        truncated = true;
        break;
      }
      operations.push({ id, record, conflict: entry.conflict });
    }
    operations.sort(
      (a, b) => a.record.order - b.record.order || a.id.localeCompare(b.id),
    );
    const value = {
      revision: contentId(JSON.stringify(index)),
      operations: Object.freeze(operations),
      truncated,
    };
    this.cache.set(directory, { stamp, value, bytes });
    while (
      this.cache.size > 16 ||
      [...this.cache.values()].reduce((sum, entry) => sum + entry.bytes, 0) >
        32 * 1024 * 1024
    ) {
      this.cache.delete(this.cache.keys().next().value ?? "");
    }
    return value;
  }

  private scopeDirectory(scope: SessionFileOperationScope): string {
    const parsed = SessionFileOperationScopeSchema.parse({
      provider: scope.provider,
      sourceId: scope.sourceId,
      sessionId: scope.sessionId,
    });
    return join(this.directory, "sessions", contentId(JSON.stringify(parsed)));
  }
  private async dirty(directory: string): Promise<boolean> {
    try {
      await stat(join(directory, "dirty"));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  private async indexStamp(directory: string): Promise<string> {
    try {
      const info = await stat(join(directory, "index.json"));
      return `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw error;
    }
  }
  private async readIndex(directory: string): Promise<Index> {
    try {
      return IndexSchema.parse(
        JSON.parse(await readFile(join(directory, "index.json"), "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { version: 1, entries: {}, storedBytes: 0, limited: false };
      throw error;
    }
  }
  private async readRecord(
    directory: string,
    id: string,
  ): Promise<SessionFileOperation> {
    const value = JSON.parse(
      await readFile(
        join(directory, "records", `${objectId.parse(id)}.json`),
        "utf8",
      ),
    );
    if (contentId(JSON.stringify(value)) !== id)
      throw new Error("File operation integrity check failed");
    return SessionFileOperationSchema.parse(value);
  }
  private assertScope(
    record: SessionFileOperation,
    scope: SessionFileOperationScope,
  ): void {
    if (
      record.identity.provider !== scope.provider ||
      record.identity.sourceId !== scope.sourceId ||
      record.identity.sessionId !== scope.sessionId
    ) {
      throw new Error("File operation scope mismatch");
    }
  }
  private async rebuild(
    directory: string,
    scope: SessionFileOperationScope,
  ): Promise<Index> {
    const names = (await readdir(join(directory, "records"))).filter((name) =>
      /^[a-f0-9]{64}\.json$/.test(name),
    );
    if (names.length > MAX_OPERATIONS * 4)
      throw new Error("File operation recovery limit exceeded");
    const index: Index = {
      version: 1,
      entries: {},
      storedBytes: 0,
      limited: false,
    };
    for (const name of names.sort()) {
      const recordId = name.slice(0, -5);
      const record = await this.readRecord(directory, recordId);
      index.storedBytes += Buffer.byteLength(JSON.stringify(record));
      this.assertScope(record, scope);
      const id = fileOperationId(record.identity);
      const previous = index.entries[id];
      if (!previous) {
        index.entries[id] = { recordId, conflict: false };
        continue;
      }
      const old = await this.readRecord(directory, previous.recordId);
      if (
        signature(old) === signature(record) ||
        (terminal(old) && !terminal(record))
      )
        continue;
      index.entries[id] = {
        recordId,
        conflict: previous.conflict || (terminal(old) && terminal(record)),
      };
    }
    await atomicWriteJson(join(directory, "index.json"), index);
    await unlink(join(directory, "dirty"));
    this.cache.delete(directory);
    return index;
  }
}
