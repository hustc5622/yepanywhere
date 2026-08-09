import { createHash } from "node:crypto";
import { containsSensitiveText } from "../../codex-events/redaction.js";

export const MAX_FEISHU_GENERATED_IMAGE_BYTES = 10 * 1024 * 1024;

export type FeishuGeneratedImageBlockReason =
  | "sensitive_prompt"
  | "invalid_payload"
  | "unsupported_format"
  | "size_limit";

export interface FeishuGeneratedImageArtifact {
  sourceId: string;
  fileName: string;
  mimeType: "image/png";
  bytes: Uint8Array;
  sizeBytes: number;
  sha256: string;
  source: "codex_image_generation";
  retention: "feishu_managed";
}

export type FeishuGeneratedImageInspection =
  | { status: "not_applicable" }
  | {
      status: "blocked";
      sourceId: string;
      reason: FeishuGeneratedImageBlockReason;
    }
  | { status: "ready"; artifact: FeishuGeneratedImageArtifact };

const PNG_SIGNATURE = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const SENSITIVE_PROMPT_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /(?:api[_ -]?key|access[_ -]?token|password|passwd|credential|client[_ -]?secret|private[_ -]?key|authorization|cookie|\.env)/i,
  /(?:密钥|口令|密码|令牌|凭据)/,
];

/**
 * Validate the only generated artifact currently safe for automatic Feishu
 * upload: a completed Codex image-generation PNG carried inline as base64.
 * `savedPath` is deliberately ignored so a provider event can never make the
 * Feishu process read an arbitrary local path.
 */
export function inspectCodexGeneratedImage(
  message: unknown,
  options: { maxBytes?: number } = {},
): FeishuGeneratedImageInspection {
  const envelope = objectValue(message);
  const item = objectValue(envelope?.codexThreadItem);
  if (
    !item ||
    item.type !== "imageGeneration" ||
    envelope?.codexThreadItemLifecycle !== "completed" ||
    item.status !== "completed"
  ) {
    return { status: "not_applicable" };
  }

  const sourceId = stringValue(item.id) ?? "unknown";
  const prompt = stringValue(item.revisedPrompt);
  if (
    prompt &&
    (SENSITIVE_PROMPT_PATTERNS.some((pattern) => pattern.test(prompt)) ||
      containsSensitiveText(prompt))
  ) {
    return { status: "blocked", sourceId, reason: "sensitive_prompt" };
  }

  const encoded = stringValue(item.result)?.trim();
  if (!encoded) {
    return { status: "blocked", sourceId, reason: "invalid_payload" };
  }
  const maxBytes = Math.max(
    1,
    Math.min(
      MAX_FEISHU_GENERATED_IMAGE_BYTES,
      Math.trunc(options.maxBytes ?? MAX_FEISHU_GENERATED_IMAGE_BYTES),
    ),
  );
  const maxEncodedLength = 4 * Math.ceil(maxBytes / 3) + 4;
  if (encoded.length > maxEncodedLength) {
    return { status: "blocked", sourceId, reason: "size_limit" };
  }
  if (
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded,
    )
  ) {
    return { status: "blocked", sourceId, reason: "invalid_payload" };
  }

  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0) {
    return { status: "blocked", sourceId, reason: "invalid_payload" };
  }
  if (bytes.length > maxBytes) {
    return { status: "blocked", sourceId, reason: "size_limit" };
  }
  if (!hasPrefix(bytes, PNG_SIGNATURE)) {
    return { status: "blocked", sourceId, reason: "unsupported_format" };
  }

  const publicId = createHash("sha256")
    .update(sourceId)
    .digest("hex")
    .slice(0, 12);
  return {
    status: "ready",
    artifact: {
      sourceId,
      fileName: `codex-generated-${publicId}.png`,
      mimeType: "image/png",
      bytes,
      sizeBytes: bytes.length,
      sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      source: "codex_image_generation",
      retention: "feishu_managed",
    },
  };
}

function hasPrefix(value: Uint8Array, prefix: Uint8Array): boolean {
  return (
    value.length >= prefix.length &&
    prefix.every((byte, index) => value[index] === byte)
  );
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
