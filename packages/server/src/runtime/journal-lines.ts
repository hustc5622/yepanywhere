import { open } from "node:fs/promises";

const NEWLINE = 0x0a;
/** Bounded read size so one large journal segment is never held whole. */
const READ_CHUNK_BYTES = 1024 * 1024;

export interface JournalLineRange {
  /** File offset of the first byte to read. */
  start?: number;
  /** Stop before this offset (defaults to the size at open time). */
  end?: number;
  /** Also visit bytes after the last newline once the range is exhausted. */
  includeTrailing?: boolean;
  onBytesRead?: (bytes: number) => void;
}

/**
 * Visit complete lines of a journal file chunk by chunk.
 *
 * Returns the offset just after the last complete line, so incremental
 * readers can resume there. Errors from `open` (including ENOENT) propagate.
 */
export async function forEachJournalLine(
  filePath: string,
  onLine: (line: Buffer) => void,
  range: JournalLineRange = {},
): Promise<number> {
  const handle = await open(filePath, "r");
  try {
    const end = range.end ?? (await handle.stat()).size;
    let consumed = range.start ?? 0;
    let position = consumed;
    let pending: Buffer = Buffer.alloc(0);
    while (position < end) {
      const length = Math.min(READ_CHUNK_BYTES, end - position);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      range.onBytesRead?.(bytesRead);
      const fresh = buffer.subarray(0, bytesRead);
      const chunk =
        pending.length > 0 ? Buffer.concat([pending, fresh]) : fresh;
      let start = 0;
      for (
        let newline = chunk.indexOf(NEWLINE, start);
        newline !== -1;
        newline = chunk.indexOf(NEWLINE, start)
      ) {
        if (newline > start) onLine(chunk.subarray(start, newline));
        start = newline + 1;
      }
      consumed = position - (chunk.length - start);
      pending = Buffer.from(chunk.subarray(start));
    }
    if (range.includeTrailing && pending.length > 0) onLine(pending);
    return consumed;
  } finally {
    await handle.close();
  }
}
