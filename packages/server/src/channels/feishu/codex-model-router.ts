import { readCodexUsage } from "../../codex-bridge/CodexUsageService.js";
import type { CodexUsageSnapshot } from "../../codex-bridge/types.js";

const DEFAULT_RECHECK_DELAY_MS = 5 * 60 * 1_000;

export interface FeishuCodexModelRoute {
  model: string;
  reason: "preferred" | "usage_limit_fallback" | "usage_limit_recovered";
}

export interface FeishuCodexModelRouterOptions {
  readUsage?: () => Promise<CodexUsageSnapshot>;
  now?: () => number;
  recheckDelayMs?: number;
}

/**
 * Process-local circuit breaker for the one Codex subscription shared by all
 * Feishu accounts. Bindings persist the active model, so after a server restart
 * a DeepSeek-bound scope triggers one fresh usage read before switching back.
 */
export class FeishuCodexModelRouter {
  private readonly readUsage: () => Promise<CodexUsageSnapshot>;
  private readonly now: () => number;
  private readonly recheckDelayMs: number;
  private fallbackUntilMs?: number;
  private usageRead?: Promise<CodexUsageSnapshot | null>;

  constructor(options: FeishuCodexModelRouterOptions = {}) {
    this.readUsage = options.readUsage ?? (() => readCodexUsage());
    this.now = options.now ?? Date.now;
    this.recheckDelayMs = options.recheckDelayMs ?? DEFAULT_RECHECK_DELAY_MS;
  }

  async recordUsageLimit(): Promise<number> {
    const now = this.now();
    // Open the circuit immediately; the fresh usage read only refines the
    // reset time and must not delay the DeepSeek replacement turn.
    this.fallbackUntilMs = now + this.recheckDelayMs;
    const usage = await this.readUsageSafely();
    const exhausted = usage ? exhaustedUsageState(usage, now) : undefined;
    this.fallbackUntilMs = exhausted?.resetAtMs ?? this.fallbackUntilMs;
    return this.fallbackUntilMs;
  }

  async selectModel(input: {
    preferredModel: string;
    fallbackModel: string;
    activeModel?: string;
  }): Promise<FeishuCodexModelRoute> {
    const activeModel = input.activeModel ?? input.preferredModel;
    if (
      activeModel !== input.preferredModel &&
      activeModel !== input.fallbackModel
    ) {
      return { model: activeModel, reason: "preferred" };
    }

    const now = this.now();
    if (this.fallbackUntilMs !== undefined && now < this.fallbackUntilMs) {
      return {
        model: input.fallbackModel,
        reason: "usage_limit_fallback",
      };
    }

    // A persisted fallback binding with no process-local state means the
    // server restarted while OpenAI Codex was exhausted. Re-read account
    // limits before deciding whether it is safe to return.
    if (
      this.fallbackUntilMs !== undefined ||
      activeModel === input.fallbackModel
    ) {
      const usage = await this.readUsageSafely();
      const exhausted = usage ? exhaustedUsageState(usage, now) : undefined;
      if (!usage || exhausted?.exhausted) {
        this.fallbackUntilMs =
          exhausted?.resetAtMs ?? now + this.recheckDelayMs;
        return {
          model: input.fallbackModel,
          reason: "usage_limit_fallback",
        };
      }
      this.fallbackUntilMs = undefined;
      return {
        model: input.preferredModel,
        reason: "usage_limit_recovered",
      };
    }

    return { model: input.preferredModel, reason: "preferred" };
  }

  private readUsageSafely(): Promise<CodexUsageSnapshot | null> {
    if (this.usageRead) return this.usageRead;
    this.usageRead = this.readUsage()
      .catch(() => null)
      .finally(() => {
        this.usageRead = undefined;
      });
    return this.usageRead;
  }
}

function exhaustedUsageState(
  usage: CodexUsageSnapshot,
  now: number,
): { exhausted: boolean; resetAtMs?: number } {
  const exhaustedWindows = [usage.primary, usage.secondary].filter(
    (window) => window && window.usedPercent >= 100,
  );
  if (exhaustedWindows.length === 0) return { exhausted: false };

  const resetTimes = exhaustedWindows
    .map((window) => window?.resetsAt)
    .filter((resetsAt): resetsAt is number => Number.isFinite(resetsAt))
    .map((resetsAt) => resetsAt * 1_000)
    .filter((resetsAt) => resetsAt > now);
  return {
    exhausted: true,
    ...(resetTimes.length > 0 ? { resetAtMs: Math.max(...resetTimes) } : {}),
  };
}
