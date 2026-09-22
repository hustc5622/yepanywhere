import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getDataDir } from "../config.js";
import { getLogger } from "../logging/logger.js";
import { atomicWriteJson } from "../utils/atomic-json-file.js";
import { captureWorkspace } from "./capture.js";
import { recordSnapshotChanges } from "./changes.js";
import { SessionFileStore } from "./store.js";
import type { FileChangeRecord, FileChangeScope } from "./types.js";

type Status = Exclude<
  NonNullable<FileChangeRecord["execution"]>["status"],
  "active"
>;
interface Execution {
  id: string;
  scope: FileChangeScope;
  workspace: string;
  owner: string;
  requestId: string;
  nativeTurnId?: string;
  before?: string;
  after?: string;
  recordId?: string;
  lastSnapshot?: string;
  coverage: "full" | "partial";
  status: "active" | Status;
  captureError?: string;
}

/**
 * Execution-boundary snapshots. Never claims process-level attribution. Durable
 * active manifests survive crashes; a reconnect must not reuse them as a new
 * baseline. All errors are observable but must not break an agent protocol.
 */
export class SessionFileLifecycle {
  private active = new Map<string, Execution>();
  private chain: Promise<void> = Promise.resolve();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    readonly store = new SessionFileStore(
      join(getDataDir(), "session-file-snapshots"),
    ),
    private readonly options: { checkpointIntervalMs?: number } = {},
  ) {}

  begin(
    scope: FileChangeScope,
    workspace: string,
    owner: string,
    requestId: string,
    partial = false,
  ): Promise<void> {
    return this.run(async () => {
      // Steering or a duplicate turn/start must not replace an active baseline.
      if (this.active.has(scope.sessionId)) return;
      const execution: Execution = {
        id: randomUUID(),
        scope: { ...scope },
        workspace,
        owner,
        requestId,
        coverage: partial ? "partial" : "full",
        status: "active",
      };
      this.active.set(scope.sessionId, execution);
      try {
        const baseline = await captureWorkspace(this.store, workspace);
        execution.before = baseline.id;
      } catch (error) {
        this.failed(execution, error);
      }
      await this.save(execution);
    });
  }

  bind(sessionId: string, turnId: string): Promise<void> {
    return this.run(async () => {
      const execution = this.active.get(sessionId);
      if (
        !execution ||
        (execution.nativeTurnId && execution.nativeTurnId !== turnId)
      )
        return;
      execution.nativeTurnId = turnId;
      execution.scope.turnId = turnId;
      await this.save(execution);
      this.scheduleCheckpoint(execution);
    });
  }

  /** Publish cumulative observations while a long turn is still executing. */
  checkpoint(sessionId: string, executionId?: string): Promise<void> {
    return this.run(async () => {
      const execution = this.active.get(sessionId);
      if (
        !execution?.before ||
        !execution.nativeTurnId ||
        (executionId && execution.id !== executionId)
      )
        return;
      try {
        const previousId = execution.lastSnapshot ?? execution.before;
        const after = await captureWorkspace(
          this.store,
          execution.workspace,
          {},
          { reuseSnapshotId: previousId },
        );
        const previous = await this.store.readSnapshot(previousId);
        if (
          JSON.stringify(previous.files) !==
          JSON.stringify(after.snapshot.files)
        ) {
          const delta = await recordSnapshotChanges(
            this.store,
            execution.scope,
            execution.before,
            after.id,
            {
              status: "active",
              coverage: execution.coverage,
              captureId: execution.id,
            },
          );
          execution.recordId = delta.id;
          execution.lastSnapshot = after.id;
          await this.save(execution);
        }
      } catch (error) {
        this.failed(execution, error);
        await this.save(execution);
      }
    });
  }

  private scheduleCheckpoint(execution: Execution): void {
    const interval = this.options.checkpointIntervalMs ?? 15_000;
    if (interval <= 0 || !execution.before || this.timers.has(execution.id))
      return;
    const timer = setTimeout(() => {
      void this.checkpoint(execution.scope.sessionId, execution.id).finally(
        () => {
          this.timers.delete(execution.id);
          if (this.active.get(execution.scope.sessionId) === execution)
            this.scheduleCheckpoint(execution);
        },
      );
    }, interval);
    timer.unref?.();
    this.timers.set(execution.id, timer);
  }

  finish(
    sessionId: string,
    turnId: string | undefined,
    status: Status,
  ): Promise<void> {
    return this.run(async () => {
      const execution = this.active.get(sessionId);
      if (
        !execution ||
        (turnId && execution.nativeTurnId && execution.nativeTurnId !== turnId)
      )
        return;
      if (turnId) execution.scope.turnId = turnId;
      await this.settle(execution, status);
    });
  }

  reject(sessionId: string, requestId: string): Promise<void> {
    return this.run(async () => {
      const execution = this.active.get(sessionId);
      if (execution?.requestId === requestId && !execution.nativeTurnId)
        await this.settle(execution, "rejected");
    });
  }

  close(owner: string): Promise<void> {
    return this.run(async () => {
      for (const execution of [...this.active.values()]) {
        if (execution.owner === owner)
          await this.settle(execution, "disconnected");
      }
    });
  }

  private async settle(execution: Execution, status: Status): Promise<void> {
    this.active.delete(execution.scope.sessionId);
    clearTimeout(this.timers.get(execution.id));
    this.timers.delete(execution.id);
    execution.status = status;
    if (status === "disconnected" || status === "rejected")
      execution.coverage = "partial";
    try {
      const after = await captureWorkspace(this.store, execution.workspace);
      execution.after = after.id;
      if (execution.before) {
        const delta = await recordSnapshotChanges(
          this.store,
          execution.scope,
          execution.before,
          after.id,
          {
            status,
            coverage: execution.coverage,
            captureId: execution.id,
          },
        );
        execution.recordId = delta.id;
      }
    } catch (error) {
      this.failed(execution, error);
    }
    await this.save(execution);
  }

  private failed(execution: Execution, error: unknown): void {
    execution.coverage = "partial";
    execution.captureError =
      error instanceof Error ? error.message : String(error);
    getLogger().warn(
      { sessionId: execution.scope.sessionId, error },
      "Session file capture failed",
    );
  }

  private save(execution: Execution): Promise<void> {
    return atomicWriteJson(
      join(this.store.directory, "executions", `${execution.id}.json`),
      execution,
    );
  }

  private run(operation: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(operation).catch((error: unknown) => {
      getLogger().warn({ error }, "Session file lifecycle persistence failed");
    });
    return this.chain;
  }
}
