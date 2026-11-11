/**
 * Streamed content parts are stored densely up to their index, so an index
 * from a provider or a replayed event is trusted only below this bound. A
 * huge index would otherwise fill billions of slots synchronously.
 */
export const MAX_STREAM_BLOCK_INDEX = 10_000;

export function streamBlockIndex(value: unknown): number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value < MAX_STREAM_BLOCK_INDEX
    ? value
    : 0;
}
