import { createHash } from "node:crypto";
import type { SafeJsonValue } from "./types.js";

export interface CodexPayloadOptions {
  /** Accepted for compatibility; plaintext paths are not projected against cwd. */
  workspaceRoot?: string;
  maxDepth?: number;
  maxArrayItems?: number;
  maxObjectEntries?: number;
  maxStringLength?: number;
}

export interface SerializedCodexPayload {
  data: SafeJsonValue;
  truncated: boolean;
}

/**
 * Bound provider data for persistence without masking text, paths, credentials,
 * error details or reasoning. These records are for the owner's private instance.
 * Large generated-image bodies remain summarized to keep the journal bounded;
 * the original image is materialized separately by the artifact pipeline.
 */
export function serializeCodexPayload(
  _method: string,
  value: unknown,
  options: CodexPayloadOptions = {},
): SerializedCodexPayload {
  const limits = {
    maxDepth: options.maxDepth ?? 32,
    maxArrayItems: options.maxArrayItems ?? 10_000,
    maxObjectEntries: options.maxObjectEntries ?? 10_000,
    maxStringLength: options.maxStringLength ?? 64 * 1024,
  };
  let truncated = false;
  const visit = (input: unknown, depth: number): SafeJsonValue => {
    if (input === null || input === undefined) return null;
    if (typeof input === "boolean") return input;
    if (typeof input === "number")
      return Number.isFinite(input) ? input : String(input);
    if (typeof input === "string") {
      if (input.length > limits.maxStringLength) {
        truncated = true;
        return `${input.slice(0, limits.maxStringLength)}[TRUNCATED:${input.length - limits.maxStringLength}]`;
      }
      return input;
    }
    if (typeof input !== "object") return String(input);
    if (depth >= limits.maxDepth) {
      truncated = true;
      return "[TRUNCATED:max-depth]";
    }
    if (Array.isArray(input)) {
      if (input.length > limits.maxArrayItems) truncated = true;
      return input
        .slice(0, limits.maxArrayItems)
        .map((entry) => visit(entry, depth + 1));
    }
    const source =
      input instanceof Error
        ? {
            ...input,
            name: input.name,
            message: input.message,
            stack: input.stack,
            cause: input.cause,
          }
        : (input as Record<string, unknown>);
    const imageGeneration = [
      "imageGeneration",
      "image_generation",
      "image_generation_call",
    ].includes(String(source.type));
    const entries = Object.entries(source);
    if (entries.length > limits.maxObjectEntries) truncated = true;
    const output: Record<string, SafeJsonValue> = {};
    for (const [key, entry] of entries.slice(0, limits.maxObjectEntries)) {
      if (entry === undefined) continue;
      if (imageGeneration && key === "result" && typeof entry === "string") {
        output.resultSummary = {
          encoding:
            /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
              entry,
            ) && entry.length >= 16
              ? "base64"
              : "opaque",
          encodedLength: entry.length,
          encodedSha256: `sha256:${createHash("sha256").update(entry).digest("hex")}`,
        };
        continue;
      }
      // Defining a property preserves even a literal __proto__ JSON key as data.
      Object.defineProperty(output, key, {
        value: visit(entry, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return output;
  };
  return { data: visit(value, 0), truncated };
}
