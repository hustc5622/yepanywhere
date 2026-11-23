/**
 * Antigravity CLI quota, read through agy's own print-mode answer:
 *
 *   agy -p /usage --output-format json
 *   agy -p /credits --output-format json
 *
 * agy answers these read-only slash commands without starting an agent
 * turn (`num_turns: 0`, empty `conversation_id`), so they spend no quota and
 * leave no conversation behind. The argv must stay exactly this: adding
 * `--disable-slash-commands` (as session launches do) would turn `/usage`
 * into a real, billed prompt. The parser therefore refuses any answer that
 * ran a turn or names another command.
 *
 * Only a successful answer is cached; concurrent reads share one process.
 */

import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import type {
  AgyCredits,
  AgyUsageBucket,
  AgyUsageGroup,
  AgyUsageResponse,
} from "@yep-anywhere/shared";
import { getLogger } from "../../logging/logger.js";
import { agySpawnEnv, findAgyPath } from "./agy.js";

const execFileAsync = promisify(execFile);
const log = getLogger();

const CACHE_TTL_MS = 5 * 60_000;
const COMMAND_TIMEOUT_MS = 60_000;
const SIGNED_OUT = /please sign in|not logged in|not signed in/i;
const MODELS_PREFIX = /^models within this group:\s*/i;

const TRANSIENT_NETWORK_ERRORS = [
  /bad gateway/i,
  /\b502\b/,
  /upstream proxy (closed|timed out|failed)/i,
  /connection reset/i,
  /socket hang up/i,
  /econnreset/i,
  /etimedout/i,
  /unexpected eof/i,
];

export function isTransientAgyNetworkError(error: unknown): boolean {
  const failed = asRecord(error);
  const text = `${error instanceof Error ? error.message : ""} ${
    typeof failed?.stdout === "string" ? failed.stdout : ""
  } ${typeof failed?.stderr === "string" ? failed.stderr : ""}`;
  return TRANSIENT_NETWORK_ERRORS.some((pattern) => pattern.test(text));
}

export function humanizeAgyErrorMessage(raw: string): string {
  if (/bad gateway|\b502\b/i.test(raw)) {
    return "Google proxy returned Bad Gateway (502). Please check network proxy.";
  }
  if (/eligibility check failed/i.test(raw)) {
    return "Google eligibility check failed. Please check network proxy or sign in again.";
  }
  if (/upstream proxy (closed|timed out|failed)/i.test(raw)) {
    return "Google upstream proxy connection failed. Please check proxy settings.";
  }
  if (/timed out|did not answer/i.test(raw)) {
    return "Command timed out while waiting for Google response.";
  }
  const cleaned = raw
    .replace(/^Command failed:.*?\/agy\s+[^\n:]*(:\s*error:\s*|:\s*)/i, "")
    .replace(/^error:\s*/i, "")
    .trim();
  return cleaned.slice(0, 300) || raw.slice(0, 300);
}

export interface AgyCommandOutput {
  stdout: string;
  stderr: string;
}

/** Runs `agy -p <command> --output-format json`; rejects like execFile. */
export type AgyCommandRunner = (
  agyPath: string,
  command: "/usage" | "/credits",
) => Promise<AgyCommandOutput>;

const defaultRunner: AgyCommandRunner = async (agyPath, command) => {
  const { stdout, stderr } = await execFileAsync(
    agyPath,
    ["-p", command, "--output-format", "json"],
    {
      // No workspace: the answer must not depend on (or touch) a project.
      cwd: tmpdir(),
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf-8",
      env: {
        ...process.env,
        AGY_CLI_DISABLE_AUTO_UPDATE: "true",
        ...(await agySpawnEnv(agyPath)),
      },
    },
  );
  return { stdout, stderr };
};

type ParsedCommand =
  | { ok: true; data: Record<string, unknown> }
  | {
      ok: false;
      state: "signed-out" | "unavailable" | "error";
      message: string;
    };

/**
 * Validates one print-mode answer for a read-only command. Exported because
 * it is the whole contract with the closed-source binary.
 */
export function parseAgyCommandOutput(
  output: AgyCommandOutput,
  expected: readonly string[],
): ParsedCommand {
  if (SIGNED_OUT.test(`${output.stdout}\n${output.stderr}`)) {
    return { ok: false, state: "signed-out", message: "Not signed in" };
  }
  const json = asRecord(parseJsonObject(output.stdout));
  if (!json) {
    return {
      ok: false,
      state: "error",
      message: "agy did not answer with JSON",
    };
  }
  if (json.status === "ERROR") {
    return {
      ok: false,
      state: "unavailable",
      message:
        asText(json.error) ??
        asText(asRecord(json.error)?.message) ??
        asText(json.response) ??
        "agy reported an error",
    };
  }
  if (json.status !== "SUCCESS") {
    return {
      ok: false,
      state: "error",
      message: `agy answered with status ${JSON.stringify(json.status)}`,
    };
  }
  // Guard against a slash command that became a real (billed) agent turn.
  if (json.num_turns !== 0) {
    return {
      ok: false,
      state: "error",
      message: `agy ran ${JSON.stringify(json.num_turns)} turns for a read-only command`,
    };
  }
  const command = asRecord(json.command);
  const name = asText(command?.name)?.toLowerCase();
  if (!name || !expected.includes(name)) {
    return {
      ok: false,
      state: "error",
      message: `agy answered with command ${JSON.stringify(command?.name)}`,
    };
  }
  const data = asRecord(command?.data);
  if (!data) {
    return { ok: false, state: "error", message: "agy answered without data" };
  }
  return { ok: true, data };
}

/** Groups from `/usage` `command.data.groups`; null when the shape is unknown. */
export function parseAgyUsageGroups(
  data: Record<string, unknown>,
): AgyUsageGroup[] | null {
  if (!Array.isArray(data.groups)) return null;
  const groups: AgyUsageGroup[] = [];
  for (const value of data.groups) {
    const record = asRecord(value);
    if (!record) continue;
    const buckets = (Array.isArray(record.buckets) ? record.buckets : [])
      .map(parseBucket)
      .filter((bucket): bucket is AgyUsageBucket => bucket !== null);
    const description = asText(record.description);
    const models =
      description && MODELS_PREFIX.test(description)
        ? description
            .replace(MODELS_PREFIX, "")
            .replace(/\.$/, "")
            .split(",")
            .map((model) => model.trim())
            .filter(Boolean)
        : [];
    groups.push({ name: asText(record.name) ?? "", models, buckets });
  }
  return groups;
}

export function parseAgyCredits(
  data: Record<string, unknown>,
): AgyCredits | null {
  const remaining = data.remaining_credits;
  if (typeof remaining !== "number" || !Number.isFinite(remaining)) {
    return null;
  }
  const upgrade = asText(data.upgrade_uri);
  return {
    remaining,
    upgradeUrl: upgrade && /^https:\/\//i.test(upgrade) ? upgrade : null,
  };
}

function parseBucket(value: unknown): AgyUsageBucket | null {
  const record = asRecord(value);
  if (!record) return null;
  const fraction = record.remaining_fraction;
  // A bucket without a finite share is dropped rather than shown as 0%.
  if (typeof fraction !== "number" || !Number.isFinite(fraction)) return null;
  const name = asText(record.name);
  const id = asText(record.id) ?? name;
  if (!id) return null;
  return {
    id,
    name: name ?? id,
    window: asText(record.window) ?? "",
    remainingFraction: Math.min(1, Math.max(0, fraction)),
    resetTime: asText(record.reset_time),
  };
}

export class AgyUsageService {
  private cache: { at: number; value: AgyUsageResponse } | null = null;
  private inFlight: Promise<AgyUsageResponse> | null = null;

  constructor(
    private readonly resolveAgyPath: () => Promise<string | null> = () =>
      findAgyPath(),
    private readonly run: AgyCommandRunner = defaultRunner,
    private readonly now: () => number = Date.now,
  ) {}

  async getUsage(options: { fresh?: boolean } = {}): Promise<AgyUsageResponse> {
    const cached = this.cache;
    if (!options.fresh && cached && this.now() - cached.at < CACHE_TTL_MS) {
      return cached.value;
    }
    if (this.inFlight) return this.inFlight;
    const read = this.read()
      .then((value) => {
        if (value.state === "ok") {
          this.cache = { at: this.now(), value };
          return value;
        }
        // When a fresh refresh fails with network/proxy issues, fall back to
        // previously cached quota rather than presenting an empty/broken card.
        if (
          (value.state === "error" || value.state === "unavailable") &&
          this.cache?.value &&
          this.cache.value.state === "ok"
        ) {
          log.warn(
            { event: "agy_usage_stale_fallback", error: value.message },
            "Returning cached Antigravity quota after fresh read failure",
          );
          return {
            ...this.cache.value,
            stale: true,
            message: value.message,
          };
        }
        return value;
      })
      .finally(() => {
        if (this.inFlight === read) this.inFlight = null;
      });
    this.inFlight = read;
    return read;
  }

  private async read(): Promise<AgyUsageResponse> {
    const agyPath = await this.resolveAgyPath();
    if (!agyPath) return failure("not-installed", null);

    const [usage, credits] = await Promise.all([
      this.command(agyPath, "/usage", ["usage", "quota"]),
      this.command(agyPath, "/credits", ["credits"]),
    ]);
    if (!usage.ok) {
      log.debug(
        {
          event: "agy_usage_failed",
          state: usage.state,
          message: usage.message,
        },
        "Antigravity usage read failed",
      );
      return failure(usage.state, usage.message);
    }
    const groups = parseAgyUsageGroups(usage.data);
    if (!groups) {
      return failure("error", "agy answered /usage without any groups");
    }
    let creditsData = credits.ok ? parseAgyCredits(credits.data) : null;
    if (!creditsData && this.cache?.value?.credits) {
      creditsData = this.cache.value.credits;
    }
    return {
      state: "ok",
      groups,
      credits: creditsData,
      message: null,
      fetchedAt: new Date(this.now()).toISOString(),
    };
  }

  private async runWithRetry(
    agyPath: string,
    command: "/usage" | "/credits",
  ): Promise<AgyCommandOutput> {
    try {
      return await this.run(agyPath, command);
    } catch (firstError) {
      if (!isTransientAgyNetworkError(firstError)) {
        throw firstError;
      }
      log.debug(
        { event: "agy_usage_transient_retry", command },
        "Retrying transient failure in Antigravity command",
      );
      await new Promise((resolve) => setTimeout(resolve, 800));
      return await this.run(agyPath, command);
    }
  }

  private async command(
    agyPath: string,
    command: "/usage" | "/credits",
    expected: readonly string[],
  ): Promise<ParsedCommand> {
    try {
      return parseAgyCommandOutput(
        await this.runWithRetry(agyPath, command),
        expected,
      );
    } catch (error) {
      // A failed process still carries what it printed; a signed-out agy
      // may report the reason on the way out.
      const failed = asRecord(error);
      const printed = {
        stdout: typeof failed?.stdout === "string" ? failed.stdout : "",
        stderr: typeof failed?.stderr === "string" ? failed.stderr : "",
      };
      if (SIGNED_OUT.test(`${printed.stdout}\n${printed.stderr}`)) {
        return { ok: false, state: "signed-out", message: "Not signed in" };
      }
      const rawMessage =
        failed?.killed === true
          ? `agy did not answer ${command} within ${COMMAND_TIMEOUT_MS / 1000}s`
          : error instanceof Error
            ? error.message
            : String(error);
      return {
        ok: false,
        state: "error",
        message: humanizeAgyErrorMessage(rawMessage),
      };
    }
  }
}

function failure(
  state: Exclude<AgyUsageResponse["state"], "ok">,
  message: string | null,
): AgyUsageResponse {
  return { state, groups: [], credits: null, message, fetchedAt: null };
}

/** The whole stdout, or its first JSON-object line behind any banner. */
function parseJsonObject(stdout: string): unknown {
  const text = stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Fall through to line scanning.
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      return JSON.parse(trimmed);
    } catch {}
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

let shared: AgyUsageService | null = null;

export function getAgyUsageService(): AgyUsageService {
  shared ??= new AgyUsageService();
  return shared;
}
