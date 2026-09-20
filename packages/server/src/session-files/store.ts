import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { atomicWriteJson } from "../utils/atomic-json-file.js";
import {
  ChangeRecordSchema,
  type FileChangeRecord,
  type FileChangeScope,
  type FileSnapshot,
  ObjectIdSchema,
  SnapshotSchema,
} from "./types.js";

export function contentId(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Immutable objects; atomic publication makes concurrent writers and retries safe. */
export class SessionFileStore {
  readonly directory: string;

  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  async putBlob(bytes: Buffer): Promise<string> {
    const id = contentId(bytes);
    try {
      await this.readBlob(id);
      return id;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await atomicWriteJson(this.path("blobs", id), {
      base64: bytes.toString("base64"),
    });
    return id;
  }

  async readBlob(id: string): Promise<Buffer> {
    const value = JSON.parse(await readFile(this.path("blobs", id), "utf8"));
    if (typeof value.base64 !== "string") throw new Error("Invalid file blob");
    const bytes = Buffer.from(value.base64, "base64");
    if (contentId(bytes) !== id)
      throw new Error("File blob integrity check failed");
    return bytes;
  }

  async putSnapshot(snapshot: FileSnapshot): Promise<string> {
    const value = SnapshotSchema.parse(snapshot);
    return this.putObject("snapshots", value);
  }

  async readSnapshot(id: string): Promise<FileSnapshot> {
    return SnapshotSchema.parse(await this.readObject("snapshots", id));
  }

  async putRecord(record: FileChangeRecord): Promise<string> {
    const value = ChangeRecordSchema.parse(record);
    const bucket = this.recordBucket(value.scope);
    return this.putObject(bucket, value);
  }

  async readRecord(
    scope: Pick<FileChangeScope, "provider" | "sessionId">,
    id: string,
  ): Promise<FileChangeRecord> {
    return ChangeRecordSchema.parse(
      await this.readObject(this.recordBucket(scope), id),
    );
  }

  /** Session-local enumeration; caller selects active branch/turn ancestry. */
  async listRecords(
    scope: Pick<FileChangeScope, "provider" | "sessionId">,
  ): Promise<string[]> {
    try {
      return (await readdir(join(this.directory, this.recordBucket(scope))))
        .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
        .map((name) => name.slice(0, -5))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private recordBucket(
    scope: Pick<FileChangeScope, "provider" | "sessionId">,
  ): string {
    return `records/${contentId(JSON.stringify([scope.provider, scope.sessionId]))}`;
  }

  private path(bucket: string, id: string): string {
    return join(this.directory, bucket, `${ObjectIdSchema.parse(id)}.json`);
  }

  private async putObject(bucket: string, value: unknown): Promise<string> {
    const id = contentId(JSON.stringify(value));
    await atomicWriteJson(this.path(bucket, id), value);
    return id;
  }

  private async readObject(bucket: string, id: string): Promise<unknown> {
    const value: unknown = JSON.parse(
      await readFile(this.path(bucket, id), "utf8"),
    );
    if (contentId(JSON.stringify(value)) !== id)
      throw new Error("File record integrity check failed");
    return value;
  }
}
