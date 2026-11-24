/** CLI installations on the machine running the Yep server. */
export type HarnessId = "codex" | "pi" | "cursor" | "mcode" | "agy" | "dsh";

export type HarnessUpdateManager = "npm" | "brew" | "self";

export type HarnessUpdateBlockReason =
  | "not_installed"
  | "unsupported_install"
  | "unsupported_platform"
  | "package_manager_missing"
  | "busy";

export interface HarnessUpdateJob {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  fromVersion?: string;
  toVersion?: string;
  log: string;
  error?: string;
}

export interface HarnessUpdateInfo {
  id: HarnessId;
  displayName: string;
  path?: string;
  /** Underlying executable updated when `path` is a recognized wrapper script. */
  resolvedPath?: string;
  currentVersion?: string;
  latestVersion?: string;
  checkedAt?: string;
  updateAvailable: boolean;
  /** Whether a read-only remote version check is supported before updating. */
  supportsCheck?: boolean;
  manager?: HarnessUpdateManager;
  canUpdate: boolean;
  blockedReason?: HarnessUpdateBlockReason;
  error?: string;
  job?: HarnessUpdateJob;
  /** DSH Web must be explicitly stopped before changing its installation. */
  webRunning?: boolean;
}
