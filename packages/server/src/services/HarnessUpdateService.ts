import { randomUUID } from "node:crypto";
import type {
  HarnessId,
  HarnessUpdateInfo,
  HarnessUpdateJob,
} from "@yep-anywhere/shared";
import {
  type HarnessInstallation,
  type RunHarnessCommand,
  getLatestHarnessVersion,
  harnessInstallCommand,
  inspectHarnessInstallation,
  isNewerHarnessVersion,
  runHarnessCommand,
} from "./harness-installation.js";

const DISPLAY_NAMES: Record<HarnessId, string> = {
  codex: "Codex CLI",
  pi: "Pi Agent",
  cursor: "Cursor CLI",
  mcode: "MiniMax Code",
  agy: "Antigravity CLI",
  dsh: "dsh",
};
const LOG_LIMIT = 16_000;

export interface HarnessUpdateServiceOptions {
  inspect?: (id: HarnessId) => Promise<HarnessInstallation>;
  run?: RunHarnessCommand;
  isBusy?: (id: HarnessId) => Promise<boolean>;
  withUpdateLock?: (
    id: HarnessId,
    update: () => Promise<void>,
  ) => Promise<void>;
  prepareEnv?: (
    id: HarnessId,
    executablePath: string,
  ) => Promise<NodeJS.ProcessEnv | undefined>;
}

/** Jobs belong to the server, so navigating away or disconnecting is harmless. */
export class HarnessUpdateService {
  private readonly inspect: (id: HarnessId) => Promise<HarnessInstallation>;
  private readonly run: RunHarnessCommand;
  private readonly isBusy: (id: HarnessId) => Promise<boolean>;
  private readonly withUpdateLock: NonNullable<
    HarnessUpdateServiceOptions["withUpdateLock"]
  >;
  private readonly prepareEnv?: HarnessUpdateServiceOptions["prepareEnv"];
  private readonly installations = new Map<
    HarnessId,
    {
      expires: number;
      promise: Promise<HarnessInstallation>;
    }
  >();
  private readonly latest = new Map<
    HarnessId,
    {
      fingerprint: string;
      version?: string;
      checkedAt?: string;
      error?: string;
    }
  >();
  private readonly checks = new Map<HarnessId, Promise<void>>();
  private readonly jobs = new Map<HarnessId, HarnessUpdateJob>();
  private running = false;

  constructor(options: HarnessUpdateServiceOptions = {}) {
    this.inspect = options.inspect ?? inspectHarnessInstallation;
    this.run = options.run ?? runHarnessCommand;
    this.isBusy = options.isBusy ?? (async () => false);
    this.withUpdateLock =
      options.withUpdateLock ?? (async (_id, update) => update());
    this.prepareEnv = options.prepareEnv;
  }

  private installation(id: HarnessId): Promise<HarnessInstallation> {
    const cached = this.installations.get(id);
    if (cached && cached.expires > Date.now()) return cached.promise;
    const promise = this.inspect(id).catch((error) => ({
      blockedReason: "unsupported_install" as const,
      error: error instanceof Error ? error.message : String(error),
    }));
    this.installations.set(id, { expires: Date.now() + 30_000, promise });
    return promise;
  }

  private fingerprint(installation: HarnessInstallation): string {
    return JSON.stringify([
      installation.path,
      installation.resolvedPath,
      installation.currentVersion,
      installation.manager,
    ]);
  }

  private supportsCheck(installation: HarnessInstallation): boolean {
    if (installation.supportsCheck !== undefined) {
      return installation.supportsCheck;
    }
    return installation.manager !== "self";
  }

  async getInfo(id: HarnessId): Promise<HarnessUpdateInfo> {
    const [installation, busy] = await Promise.all([
      this.installation(id),
      this.isBusy(id),
    ]);
    const cached = this.latest.get(id);
    const latest =
      cached?.fingerprint === this.fingerprint(installation)
        ? cached
        : undefined;
    const job = this.jobs.get(id);
    const supportsCheck = this.supportsCheck(installation);
    return {
      id,
      displayName: DISPLAY_NAMES[id],
      path: installation.path,
      ...(installation.resolvedPath
        ? { resolvedPath: installation.resolvedPath }
        : {}),
      currentVersion: installation.currentVersion,
      manager: installation.manager,
      supportsCheck,
      latestVersion: latest?.version,
      checkedAt: latest?.checkedAt,
      updateAvailable: Boolean(
        supportsCheck &&
          latest?.version &&
          installation.currentVersion &&
          isNewerHarnessVersion(latest.version, installation.currentVersion),
      ),
      canUpdate: Boolean(
        installation.command &&
          installation.currentVersion &&
          !busy &&
          !this.running,
      ),
      blockedReason: installation.blockedReason ?? (busy ? "busy" : undefined),
      error: installation.error ?? latest?.error,
      job: job ? { ...job } : undefined,
      ...(id === "dsh" ? { webRunning: busy } : {}),
    };
  }

  async check(id: HarnessId): Promise<HarnessUpdateInfo> {
    if (this.running) return this.getInfo(id);
    let pending = this.checks.get(id);
    if (!pending) {
      pending = this.checkLatest(id).finally(() => this.checks.delete(id));
      this.checks.set(id, pending);
    }
    await pending;
    return this.getInfo(id);
  }

  async checkAll(ids: readonly HarnessId[]): Promise<HarnessUpdateInfo[]> {
    return Promise.all(ids.map((id) => this.check(id)));
  }

  private async checkLatest(id: HarnessId): Promise<void> {
    this.installations.delete(id);
    const installation = await this.installation(id);
    if (!installation.command) return;
    if (!this.supportsCheck(installation)) return;
    const fingerprint = this.fingerprint(installation);
    try {
      const version = await getLatestHarnessVersion(id, installation, this.run);
      this.latest.set(id, {
        fingerprint,
        version,
        checkedAt: new Date().toISOString(),
      });
    } catch (error) {
      this.latest.set(id, {
        fingerprint,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Claim the shared package-manager lock before any asynchronous work. */
  start(id: HarnessId): HarnessUpdateJob | null {
    if (this.running) return null;
    this.running = true;
    const job: HarnessUpdateJob = {
      id: randomUUID(),
      status: "running",
      startedAt: new Date().toISOString(),
      log: "",
    };
    this.jobs.set(id, job);
    void this.runQueue([{ id, job }]);
    return { ...job };
  }

  /**
   * Queue a serial update pass for every currently eligible harness.
   * Returns null if another update or batch is already running.
   */
  async startBatch(ids: readonly HarnessId[]): Promise<{
    started: HarnessId[];
    jobs: Record<string, HarnessUpdateJob>;
  } | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const snapshots = await Promise.all(
        ids.map(async (id) => {
          const [installation, busy] = await Promise.all([
            this.installation(id),
            this.isBusy(id),
          ]);
          return { id, installation, busy };
        }),
      );
      const eligible = snapshots.filter(({ installation, busy }) =>
        Boolean(installation.command && installation.currentVersion && !busy),
      );
      if (eligible.length === 0) {
        this.running = false;
        return { started: [], jobs: {} };
      }
      const now = new Date().toISOString();
      const queue: Array<{ id: HarnessId; job: HarnessUpdateJob }> = [];
      const jobs: Record<string, HarnessUpdateJob> = {};
      for (const [i, entry] of eligible.entries()) {
        const job: HarnessUpdateJob = {
          id: randomUUID(),
          status: i === 0 ? "running" : "queued",
          startedAt: now,
          log: "",
        };
        this.jobs.set(entry.id, job);
        queue.push({ id: entry.id, job });
        jobs[entry.id] = { ...job };
      }
      void this.runQueue(queue);
      return {
        started: eligible.map((entry) => entry.id),
        jobs,
      };
    } catch (error) {
      this.running = false;
      throw error;
    }
  }

  private async runQueue(
    queue: Array<{ id: HarnessId; job: HarnessUpdateJob }>,
  ): Promise<void> {
    try {
      for (const item of queue) {
        item.job.status = "running";
        item.job.startedAt = new Date().toISOString();
        await this.performUpdate(item.id, item.job);
      }
    } finally {
      this.running = false;
    }
  }

  private async performUpdate(
    id: HarnessId,
    job: HarnessUpdateJob,
  ): Promise<void> {
    try {
      // Finish any old lookup before changing its underlying installation.
      await this.checks.get(id);
      const installation = await this.inspect(id);
      if (!installation.command || !installation.currentVersion) {
        throw new Error(
          "This CLI installation cannot be updated by Yep. Check its installation details.",
        );
      }
      if (await this.isBusy(id))
        throw new Error(
          "This harness has active work. Wait for it to finish and retry.",
        );
      job.fromVersion = installation.currentVersion;

      if (installation.manager === "self") {
        await this.performSelfUpdate(id, installation, job);
        job.status = "completed";
        return;
      }

      const version = await getLatestHarnessVersion(id, installation, this.run);
      job.toVersion = version;
      if (isNewerHarnessVersion(version, installation.currentVersion)) {
        if (await this.isBusy(id))
          throw new Error(
            "This harness has active work. Wait for it to finish and retry.",
          );
        await this.withUpdateLock(id, async () => {
          if (await this.isBusy(id))
            throw new Error(
              "Stop this harness before updating its installation.",
            );
          // Another server may have updated this installation while this job
          // waited for the shared DSH lease. Re-inspect before any mutation.
          const current = await this.inspect(id);
          if (
            current.path !== installation.path ||
            current.resolvedPath !== installation.resolvedPath ||
            !current.command ||
            !current.currentVersion
          ) {
            throw new Error(
              "The CLI installation changed while preparing the update. Check again before updating.",
            );
          }
          job.fromVersion = current.currentVersion;
          if (!isNewerHarnessVersion(version, current.currentVersion)) {
            job.toVersion = current.currentVersion;
            return;
          }
          await this.run(harnessInstallCommand(id, current, version), {
            timeoutMs: (id === "dsh" ? 30 : 10) * 60_000,
            onOutput: (text) => {
              job.log = `${job.log}${text}`.slice(-LOG_LIMIT);
            },
          });
          const updated = await this.inspect(id);
          if (
            updated.path !== installation.path ||
            updated.resolvedPath !== installation.resolvedPath ||
            !updated.currentVersion ||
            (updated.currentVersion !== version &&
              !isNewerHarnessVersion(updated.currentVersion, version))
          ) {
            throw new Error(
              "The update finished, but the CLI at the original path did not report the expected version. Check the log and retry.",
            );
          }
          job.toVersion = updated.currentVersion;
        });
      } else {
        // Never downgrade a newer or custom installation to the stable tag.
        job.toVersion = installation.currentVersion;
      }
      this.latest.set(id, {
        fingerprint: this.fingerprint({
          ...installation,
          currentVersion: job.toVersion,
        }),
        version,
        checkedAt: new Date().toISOString(),
      });
      job.status = "completed";
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
    } finally {
      job.completedAt = new Date().toISOString();
      this.installations.delete(id);
    }
  }

  private async performSelfUpdate(
    id: HarnessId,
    installation: HarnessInstallation,
    job: HarnessUpdateJob,
  ): Promise<void> {
    await this.withUpdateLock(id, async () => {
      if (await this.isBusy(id)) {
        throw new Error(
          "This harness has active work. Wait for it to finish and retry.",
        );
      }
      const current = await this.inspect(id);
      if (
        current.path !== installation.path ||
        current.resolvedPath !== installation.resolvedPath ||
        !current.command ||
        !current.currentVersion
      ) {
        throw new Error(
          "The CLI installation changed while preparing the update. Check again before updating.",
        );
      }
      job.fromVersion = current.currentVersion;
      const baseCommand = harnessInstallCommand(id, current);
      const extraEnv = this.prepareEnv
        ? await this.prepareEnv(id, baseCommand.file)
        : undefined;
      const command = extraEnv
        ? {
            ...baseCommand,
            env: { ...process.env, ...extraEnv, ...baseCommand.env },
          }
        : baseCommand;
      await this.run(command, {
        timeoutMs: 10 * 60_000,
        onOutput: (text) => {
          job.log = `${job.log}${text}`.slice(-LOG_LIMIT);
        },
      });
      const updated = await this.inspect(id);
      if (updated.path !== installation.path || !updated.currentVersion) {
        throw new Error(
          "The update finished, but the CLI at the original path could not report its version. Check the log and retry.",
        );
      }
      job.toVersion = updated.currentVersion;
    });
  }
}
