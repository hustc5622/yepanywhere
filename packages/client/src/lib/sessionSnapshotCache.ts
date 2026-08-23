import type { PaginationInfo } from "../api/client";
import type { Message, Session } from "../types";

export const SESSION_SNAPSHOT_MAX_ENTRIES = 5;
export const SESSION_SNAPSHOT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
export const SESSION_SNAPSHOT_MAX_ENTRY_BYTES = 12 * 1024 * 1024;

export interface SessionSnapshotIdentity {
  projectId: string;
  sessionId: string;
  branchId?: string;
  historySource: string;
}

export interface SessionSnapshotLookup {
  projectId: string;
  sessionId: string;
  branchId?: string;
  historySource?: string;
}

export interface SessionSnapshotValue extends SessionSnapshotIdentity {
  session: Session;
  messages: Message[];
  pagination?: PaginationInfo;
  revision: string;
  writtenAt: number;
  estimatedBytes: number;
}

export interface SessionSnapshotInput extends SessionSnapshotIdentity {
  session: Session;
  messages: Message[];
  pagination?: PaginationInfo;
  revision: string;
  writtenAt?: number;
}

interface SessionSnapshotCacheOptions {
  maxEntries?: number;
  maxTotalBytes?: number;
  maxEntryBytes?: number;
}

function normalizedBranchId(branchId: string | undefined): string {
  return branchId || "active";
}

function snapshotKey(identity: SessionSnapshotIdentity): string {
  return JSON.stringify([
    identity.projectId,
    identity.sessionId,
    normalizedBranchId(identity.branchId),
    identity.historySource,
  ]);
}

function matchesLookup(
  snapshot: SessionSnapshotValue,
  lookup: SessionSnapshotLookup,
): boolean {
  return (
    snapshot.projectId === lookup.projectId &&
    snapshot.sessionId === lookup.sessionId &&
    normalizedBranchId(snapshot.branchId) ===
      normalizedBranchId(lookup.branchId) &&
    (lookup.historySource === undefined ||
      snapshot.historySource === lookup.historySource)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isReasoningBlock(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    value.type === "thinking" ||
    value.type === "reasoning" ||
    value.type === "reasoning_content"
  );
}

function stripInlineMedia(
  value: unknown,
  insideMedia = false,
): { value: unknown; changed: boolean } {
  if (typeof value === "string") {
    if (insideMedia && value.startsWith("data:")) {
      return { value: undefined, changed: true };
    }
    return { value, changed: false };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const sanitized = stripInlineMedia(item, insideMedia);
      changed ||= sanitized.changed;
      return sanitized.value;
    });
    return { value: changed ? next : value, changed };
  }
  if (!isRecord(value)) return { value, changed: false };

  const mediaRecord =
    insideMedia ||
    value.type === "image" ||
    value.type === "image_url" ||
    value.type === "document" ||
    value.type === "base64";
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      mediaRecord &&
      (key === "data" || key === "base64") &&
      typeof item === "string"
    ) {
      changed = true;
      continue;
    }
    const sanitized = stripInlineMedia(item, mediaRecord);
    changed ||= sanitized.changed;
    if (sanitized.value !== undefined) next[key] = sanitized.value;
  }
  return { value: changed ? next : value, changed };
}

function sanitizeContent(content: unknown): {
  value: unknown;
  changed: boolean;
} {
  if (!Array.isArray(content)) return stripInlineMedia(content);
  let changed = false;
  const retained: unknown[] = [];
  for (const block of content) {
    if (isReasoningBlock(block)) {
      changed = true;
      continue;
    }
    const sanitized = stripInlineMedia(block);
    changed ||= sanitized.changed;
    retained.push(sanitized.value);
  }
  return { value: changed ? retained : content, changed };
}

function sanitizeMessage(message: Message): Message {
  const topLevel = sanitizeContent(message.content);
  const nested = sanitizeContent(message.message?.content);
  if (!topLevel.changed && !nested.changed) return message;

  return {
    ...message,
    ...(topLevel.changed
      ? { content: topLevel.value as Message["content"] }
      : {}),
    ...(nested.changed
      ? {
          message: {
            ...(message.message ?? {}),
            content: nested.value as NonNullable<Message["message"]>["content"],
          },
        }
      : {}),
  };
}

function estimateStructuralBytes(
  values: readonly unknown[],
  limit: number,
): number {
  const stack = [...values];
  const seen = new WeakSet<object>();
  let bytes = 0;
  while (stack.length > 0) {
    const value = stack.pop();
    if (value === null || value === undefined) {
      bytes += 4;
    } else if (typeof value === "string") {
      // Cache pressure is about retained JS memory, not wire-format bytes.
      // UTF-16 code units give a bounded, allocation-free upper estimate for
      // the overwhelmingly ASCII transcript payloads.
      bytes += 16 + value.length * 2;
    } else if (typeof value === "number" || typeof value === "bigint") {
      bytes += 8;
    } else if (typeof value === "boolean") {
      bytes += 4;
    } else if (typeof value === "object") {
      if (seen.has(value)) continue;
      seen.add(value);
      if (Array.isArray(value)) {
        bytes += 24 + value.length * 8;
        for (const item of value) stack.push(item);
      } else {
        const entries = Object.entries(value);
        bytes += 32 + entries.length * 16;
        for (const [key, item] of entries) {
          bytes += key.length * 2;
          stack.push(item);
        }
      }
    } else {
      bytes += 8;
    }
    if (bytes > limit) return bytes;
  }
  return bytes;
}

function sanitizeMessages(messages: Message[]): Message[] {
  let changed: Message[] | null = null;
  for (let index = 0; index < messages.length; index += 1) {
    const current = messages[index];
    if (!current) continue;
    const sanitized = sanitizeMessage(current);
    if (sanitized === current) {
      if (changed) changed.push(current);
      continue;
    }
    if (!changed) changed = messages.slice(0, index);
    changed.push(sanitized);
  }
  return changed ?? messages;
}

export class SessionSnapshotCache {
  private readonly entries = new Map<string, SessionSnapshotValue>();
  private totalBytes = 0;
  private lastWrittenAt = 0;
  private readonly maxEntries: number;
  private readonly maxTotalBytes: number;
  private readonly maxEntryBytes: number;

  constructor(options: SessionSnapshotCacheOptions = {}) {
    this.maxEntries = Math.max(
      1,
      options.maxEntries ?? SESSION_SNAPSHOT_MAX_ENTRIES,
    );
    this.maxTotalBytes = Math.max(
      1,
      options.maxTotalBytes ?? SESSION_SNAPSHOT_MAX_TOTAL_BYTES,
    );
    this.maxEntryBytes = Math.max(
      1,
      options.maxEntryBytes ?? SESSION_SNAPSHOT_MAX_ENTRY_BYTES,
    );
  }

  get(lookup: SessionSnapshotLookup): SessionSnapshotValue | null {
    let foundKey: string | undefined;
    let found: SessionSnapshotValue | undefined;
    for (const [key, snapshot] of this.entries) {
      if (
        matchesLookup(snapshot, lookup) &&
        (!found || snapshot.writtenAt > found.writtenAt)
      ) {
        foundKey = key;
        found = snapshot;
      }
    }
    if (!found || !foundKey) return null;
    this.entries.delete(foundKey);
    this.entries.set(foundKey, found);
    return found;
  }

  put(input: SessionSnapshotInput): boolean {
    const key = snapshotKey(input);
    // Empty/unmaterialized snapshots do not improve a later first paint and
    // can hide the transition to the provider's durable session ID.
    if (input.messages.length === 0) {
      this.removeKey(key);
      return false;
    }

    const messages = sanitizeMessages(input.messages);
    const estimatedBytes = estimateStructuralBytes(
      [input.session, messages, input.pagination, input.revision],
      this.maxEntryBytes,
    );
    if (
      !Number.isFinite(estimatedBytes) ||
      estimatedBytes > this.maxEntryBytes
    ) {
      this.removeKey(key);
      return false;
    }

    const writtenAt =
      input.writtenAt ?? Math.max(Date.now(), this.lastWrittenAt + 1);
    this.lastWrittenAt = Math.max(this.lastWrittenAt, writtenAt);
    const value: SessionSnapshotValue = {
      ...input,
      messages,
      writtenAt,
      estimatedBytes,
    };
    const existing = this.entries.get(key);
    if (existing) {
      this.totalBytes -= existing.estimatedBytes;
      this.entries.delete(key);
    }
    this.entries.set(key, value);
    this.totalBytes += estimatedBytes;
    this.evictToBudget();
    return this.entries.get(key) === value;
  }

  invalidate(lookup: SessionSnapshotLookup & { revision?: string }): number {
    let removed = 0;
    for (const [key, snapshot] of this.entries) {
      if (
        matchesLookup(snapshot, lookup) &&
        (lookup.revision === undefined || snapshot.revision === lookup.revision)
      ) {
        this.entries.delete(key);
        this.totalBytes -= snapshot.estimatedBytes;
        removed += 1;
      }
    }
    return removed;
  }

  reset(): void {
    this.entries.clear();
    this.totalBytes = 0;
    this.lastWrittenAt = 0;
  }

  getDebugStats(): { entries: number; totalBytes: number; keys: string[] } {
    return {
      entries: this.entries.size,
      totalBytes: this.totalBytes,
      keys: Array.from(this.entries.keys()),
    };
  }

  private evictToBudget(): void {
    while (
      this.entries.size > this.maxEntries ||
      this.totalBytes > this.maxTotalBytes
    ) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) return;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      if (oldest) this.totalBytes -= oldest.estimatedBytes;
    }
  }

  private removeKey(key: string): void {
    const existing = this.entries.get(key);
    if (!existing) return;
    this.entries.delete(key);
    this.totalBytes -= existing.estimatedBytes;
  }
}

const sessionSnapshotCache = new SessionSnapshotCache();

export function getSessionSnapshot(
  lookup: SessionSnapshotLookup,
): SessionSnapshotValue | null {
  return sessionSnapshotCache.get(lookup);
}

export function putSessionSnapshot(input: SessionSnapshotInput): boolean {
  return sessionSnapshotCache.put(input);
}

export function invalidateSessionSnapshots(
  lookup: SessionSnapshotLookup & { revision?: string },
): number {
  return sessionSnapshotCache.invalidate(lookup);
}

export function resetSessionSnapshotCacheForTests(): void {
  sessionSnapshotCache.reset();
}
