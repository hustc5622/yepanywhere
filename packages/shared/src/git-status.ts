export interface GitFileChange {
  /** Relative file path within the repo */
  path: string;
  /** Git status code: M, A, D, ?, R, T, U */
  status: string;
  /** Whether the change is staged (in the index) */
  staged: boolean;
  /** Lines added (null for binary or untracked files) */
  linesAdded: number | null;
  /** Lines deleted (null for binary or untracked files) */
  linesDeleted: number | null;
  /** Original path (for renames) */
  origPath?: string;
}

export interface GitStatusInfo {
  /** Whether the project path is a git repository */
  isGitRepo: boolean;
  /** Current branch name (null if detached HEAD) */
  branch: string | null;
  /** Upstream branch (e.g. "origin/main") */
  upstream: string | null;
  /** Commits ahead of upstream */
  ahead: number;
  /** Commits behind upstream */
  behind: number;
  /** Whether the working tree is clean */
  isClean: boolean;
  /** Changed files with status and line counts */
  files: GitFileChange[];
}

export interface ProjectGitStatusSummary {
  /** Whether the project path is a git repository */
  isGitRepo: boolean;
  /** Current branch name (null if detached HEAD or not a repo) */
  branch: string | null;
  /** Short HEAD commit hash when detached */
  head: string | null;
  /** Upstream branch (e.g. "origin/main") */
  upstream: string | null;
  /** Commits ahead of upstream */
  ahead: number;
  /** Commits behind upstream */
  behind: number;
  /** Whether the working tree is clean */
  isClean: boolean;
  /** Number of files with staged changes */
  stagedCount: number;
  /** Number of files with unstaged changes */
  unstagedCount: number;
  /** Number of deleted files */
  deletedCount: number;
  /** Number of untracked files */
  untrackedCount: number;
  /** Number of files with merge conflicts */
  conflictedCount: number;
  /** Number of stashed changes */
  stashCount: number;
}
