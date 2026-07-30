import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProjectGitStatusSummary } from "@yep-anywhere/shared";

const execFileAsync = promisify(execFile);

const GIT_STATUS_TIMEOUT_MS = 2_000;

/**
 * How long a git status summary stays fresh before it is recomputed.
 *
 * `GET /api/projects` asks for every project's summary on each request, and the
 * mobile client polls that endpoint frequently. Without a cache each request
 * spawned `2 x N` git subprocesses (status + stash list per project), which is
 * the single most expensive uncached path in the project list. A short TTL
 * mirrors the ProjectScanner snapshot window and collapses bursts of polls into
 * one git invocation per project.
 */
const GIT_STATUS_CACHE_TTL_MS = 3_000;

export const NOT_A_GIT_REPO_SUMMARY: ProjectGitStatusSummary = {
  isGitRepo: false,
  branch: null,
  head: null,
  upstream: null,
  ahead: 0,
  behind: 0,
  isClean: true,
  stagedCount: 0,
  unstagedCount: 0,
  deletedCount: 0,
  untrackedCount: 0,
  conflictedCount: 0,
  stashCount: 0,
};

export async function getProjectGitStatusSummary(
  projectPath: string,
): Promise<ProjectGitStatusSummary | null> {
  try {
    const [statusResult, stashResult] = await Promise.all([
      execFileAsync(
        "git",
        ["-C", projectPath, "status", "--porcelain=v2", "--branch"],
        {
          maxBuffer: 512 * 1024,
          timeout: GIT_STATUS_TIMEOUT_MS,
        },
      ),
      execFileAsync(
        "git",
        ["-C", projectPath, "stash", "list", "--format=%gd"],
        {
          maxBuffer: 128 * 1024,
          timeout: GIT_STATUS_TIMEOUT_MS,
        },
      ).catch(() => ({ stdout: "", stderr: "" })),
    ]);
    return parseGitStatusSummary(
      statusResult.stdout,
      countNonEmptyLines(stashResult.stdout),
    );
  } catch (err) {
    if (isNotGitRepoError(err)) {
      return NOT_A_GIT_REPO_SUMMARY;
    }
    return null;
  }
}

export function parseGitStatusSummary(
  output: string,
  stashCount = 0,
): ProjectGitStatusSummary {
  let branch: string | null = null;
  let head: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let stagedCount = 0;
  let unstagedCount = 0;
  let deletedCount = 0;
  let untrackedCount = 0;
  let conflictedCount = 0;

  for (const line of output.split("\n")) {
    if (!line) continue;

    if (line.startsWith("# branch.oid ")) {
      const value = line.slice("# branch.oid ".length);
      head = value === "(initial)" ? null : value.slice(0, 7);
    } else if (line.startsWith("# branch.head ")) {
      const value = line.slice("# branch.head ".length);
      branch = value === "(detached)" ? null : value;
    } else if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice("# branch.upstream ".length);
    } else if (line.startsWith("# branch.ab ")) {
      const match = line.match(/\+(\d+) -(\d+)/);
      if (match?.[1] && match[2]) {
        ahead = Number.parseInt(match[1], 10);
        behind = Number.parseInt(match[2], 10);
      }
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const xy = line.split(" ")[1];
      const stagedStatus = xy?.[0];
      const unstagedStatus = xy?.[1];
      if (stagedStatus === "D" || unstagedStatus === "D") {
        deletedCount++;
      }
      if (stagedStatus && stagedStatus !== "." && stagedStatus !== "D") {
        stagedCount++;
      }
      if (unstagedStatus && unstagedStatus !== "." && unstagedStatus !== "D") {
        unstagedCount++;
      }
    } else if (line.startsWith("? ")) {
      untrackedCount++;
    } else if (line.startsWith("u ")) {
      conflictedCount++;
    }
  }

  const isClean =
    stagedCount === 0 &&
    unstagedCount === 0 &&
    deletedCount === 0 &&
    untrackedCount === 0 &&
    conflictedCount === 0 &&
    stashCount === 0;

  return {
    isGitRepo: true,
    branch,
    head,
    upstream,
    ahead,
    behind,
    isClean,
    stagedCount,
    unstagedCount,
    deletedCount,
    untrackedCount,
    conflictedCount,
    stashCount,
  };
}

function countNonEmptyLines(output: string): number {
  return output.split("\n").filter((line) => line.trim() !== "").length;
}

function isNotGitRepoError(err: unknown): boolean {
  if (err && typeof err === "object") {
    const e = err as { code?: number | string; stderr?: string };
    if (e.code === 128) return true;
    if (
      typeof e.stderr === "string" &&
      e.stderr.includes("not a git repository")
    ) {
      return true;
    }
  }
  return false;
}

interface GitStatusCacheEntry {
  value: ProjectGitStatusSummary | null;
  timestamp: number;
}

export interface GitStatusSummaryCacheOptions {
  /** Freshness window in milliseconds. Defaults to {@link GIT_STATUS_CACHE_TTL_MS}. */
  ttlMs?: number;
  /** Override the underlying git invocation (primarily for tests). */
  compute?: (projectPath: string) => Promise<ProjectGitStatusSummary | null>;
}

/**
 * Per-project-path cache for git status summaries.
 *
 * Combines a short TTL with single-flight deduplication so concurrent callers
 * (e.g. the `getProjectGitStatusSummaries` worker pool during `GET
 * /api/projects`) share one in-flight git invocation per project instead of
 * spawning a fresh subprocess each time. Cache entries are keyed by absolute
 * project path and bounded by the active project set.
 */
export class GitStatusSummaryCache {
  private readonly ttlMs: number;
  private readonly compute: (
    projectPath: string,
  ) => Promise<ProjectGitStatusSummary | null>;
  private readonly cache = new Map<string, GitStatusCacheEntry>();
  private readonly inFlight = new Map<
    string,
    Promise<ProjectGitStatusSummary | null>
  >();

  constructor(options: GitStatusSummaryCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? GIT_STATUS_CACHE_TTL_MS;
    this.compute = options.compute ?? getProjectGitStatusSummary;
  }

  async get(projectPath: string): Promise<ProjectGitStatusSummary | null> {
    const now = Date.now();
    const cached = this.cache.get(projectPath);
    if (cached && now - cached.timestamp < this.ttlMs) {
      return cached.value;
    }

    const existing = this.inFlight.get(projectPath);
    if (existing) return existing;

    const promise = this.compute(projectPath)
      .then((value) => {
        this.cache.set(projectPath, { value, timestamp: Date.now() });
        return value;
      })
      .finally(() => {
        if (this.inFlight.get(projectPath) === promise) {
          this.inFlight.delete(projectPath);
        }
      });

    this.inFlight.set(projectPath, promise);
    return promise;
  }

  /** Drop the cached summary for a project so the next read recomputes it. */
  invalidate(projectPath: string): void {
    this.cache.delete(projectPath);
  }

  /** Drop all cached summaries. */
  clear(): void {
    this.cache.clear();
  }
}
