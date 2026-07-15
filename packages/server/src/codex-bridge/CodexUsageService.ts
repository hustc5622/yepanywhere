import { type ChildProcess, spawn } from "node:child_process";
import { asRecord } from "../bridge-common/util.js";
import { findCodexCliPath } from "../sdk/cli-detection.js";
import type {
  CodexUsageBucket,
  CodexUsageResetCredits,
  CodexUsageSnapshot,
  CodexUsageWindow,
} from "./types.js";

const APP_SERVER_INIT_REQUEST_ID = 1;
const APP_SERVER_RATE_LIMITS_REQUEST_ID = 2;
const APP_SERVER_TIMEOUT_MS = 15_000;

interface JsonRpcResponse {
  id?: number | string;
  result?: unknown;
  error?: { message?: string };
}

export async function readCodexUsage(
  codexPathOverride?: string,
): Promise<CodexUsageSnapshot> {
  const codexPath = codexPathOverride ?? (await findCodexCliPath());
  if (!codexPath) {
    throw new Error("Codex CLI not found");
  }

  return new Promise((resolve, reject) => {
    const child = spawn(codexPath, ["app-server", "--listen", "stdio://"], {
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      shell: process.platform === "win32",
    });
    let settled = false;
    let stdoutBuffer = "";
    const stderrChunks: string[] = [];

    const finish = (handler: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      terminateChild(child);
      handler();
    };

    const send = (message: unknown) => {
      child.stdin?.write(`${JSON.stringify(message)}\n`);
    };

    const handleMessage = (message: JsonRpcResponse) => {
      if (message.id === APP_SERVER_INIT_REQUEST_ID) {
        if (message.error) {
          finish(() =>
            reject(
              new Error(
                message.error?.message ?? "Codex app-server initialize failed",
              ),
            ),
          );
          return;
        }
        send({ jsonrpc: "2.0", method: "initialized" });
        send({
          jsonrpc: "2.0",
          id: APP_SERVER_RATE_LIMITS_REQUEST_ID,
          method: "account/rateLimits/read",
          params: null,
        });
        return;
      }

      if (message.id !== APP_SERVER_RATE_LIMITS_REQUEST_ID) return;
      if (message.error) {
        finish(() =>
          reject(
            new Error(
              message.error?.message ??
                "Codex app-server account/rateLimits/read failed",
            ),
          ),
        );
        return;
      }

      const usage = normalizeUsageSnapshot(message.result);
      if (!usage) {
        finish(() =>
          reject(
            new Error("Codex app-server returned invalid rate-limit data"),
          ),
        );
        return;
      }
      finish(() => resolve(usage));
    };

    const timeoutHandle = setTimeout(() => {
      const stderr = stderrChunks.join("").trim();
      finish(() =>
        reject(
          new Error(
            stderr
              ? `Timed out querying Codex account usage: ${stderr}`
              : "Timed out querying Codex account usage",
          ),
        ),
      );
    }, APP_SERVER_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf-8");
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        try {
          handleMessage(JSON.parse(line) as JsonRpcResponse);
        } catch {}
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk.toString("utf-8"));
    });

    child.on("error", (error) => finish(() => reject(error)));
    child.on("exit", (code, signal) => {
      if (settled) return;
      const stderr = stderrChunks.join("").trim();
      const details = stderr ? ` stderr: ${stderr}` : "";
      finish(() =>
        reject(
          new Error(
            `Codex app-server exited before account/rateLimits/read response (code=${code ?? "null"}, signal=${signal ?? "null"}).${details}`,
          ),
        ),
      );
    });

    send({
      jsonrpc: "2.0",
      id: APP_SERVER_INIT_REQUEST_ID,
      method: "initialize",
      params: {
        clientInfo: { name: "yep-anywhere", version: "dev" },
        capabilities: null,
      },
    });
  });
}

function normalizeUsageSnapshot(value: unknown): CodexUsageSnapshot | null {
  const result = asRecord(value);
  if (!result) return null;
  const rateLimits =
    asRecord(result.rateLimits) ?? asRecord(result.rate_limits);
  const byLimitId =
    asRecord(result.rateLimitsByLimitId) ??
    asRecord(result.rate_limits_by_limit_id);
  const primaryBucket =
    normalizeBucket(byLimitId?.codex, "codex") ??
    normalizeBucket(rateLimits, "codex");
  if (!primaryBucket) return null;

  const additionalBuckets = byLimitId
    ? Object.entries(byLimitId)
        .map(([limitId, bucket]) => normalizeBucket(bucket, limitId))
        .filter((bucket): bucket is CodexUsageBucket =>
          Boolean(bucket && bucket.id !== primaryBucket.id),
        )
    : [];

  return {
    primary: primaryBucket.primary,
    secondary: primaryBucket.secondary,
    planType: primaryBucket.planType,
    resetCredits: normalizeResetCredits(
      result.rateLimitResetCredits ?? result.rate_limit_reset_credits,
    ),
    additionalBuckets,
    updatedAt: new Date().toISOString(),
  };
}

function normalizeBucket(
  value: unknown,
  fallbackId: string,
): CodexUsageBucket | null {
  const bucket = asRecord(value);
  if (!bucket) return null;
  const primary = normalizeWindow(bucket.primary);
  const secondary = normalizeWindow(bucket.secondary);
  if (!primary && !secondary) return null;

  return {
    id: getString(bucket.limitId) ?? getString(bucket.limit_id) ?? fallbackId,
    name: getString(bucket.limitName) ?? getString(bucket.limit_name),
    primary,
    secondary,
    planType: getString(bucket.planType) ?? getString(bucket.plan_type),
  };
}

function normalizeWindow(value: unknown): CodexUsageWindow | null {
  const window = asRecord(value);
  if (!window) return null;
  const usedPercent =
    getNumber(window.usedPercent) ?? getNumber(window.used_percent);
  if (usedPercent === null) return null;

  return {
    usedPercent,
    windowDurationMins:
      getNumber(window.windowDurationMins) ??
      getNumber(window.window_duration_mins),
    resetsAt: getNumber(window.resetsAt) ?? getNumber(window.resets_at),
  };
}

function normalizeResetCredits(value: unknown): CodexUsageResetCredits | null {
  const credits = asRecord(value);
  if (!credits) return null;
  const availableCount =
    getNumber(credits.availableCount) ?? getNumber(credits.available_count);
  if (availableCount === null) return null;
  return { availableCount };
}

function getString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function getNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function terminateChild(child: ChildProcess): void {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const forceKill = setTimeout(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  }, 1_500);
  forceKill.unref();
}
