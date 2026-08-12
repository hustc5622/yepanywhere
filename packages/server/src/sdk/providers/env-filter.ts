/**
 * Filter environment variables for child processes.
 *
 * When spawning Claude as a subprocess, we don't want to leak:
 * - npm_* variables (from pnpm/npm lifecycle)
 * - Yep Anywhere internal variables
 * - Other irrelevant development/build-time variables
 *
 * We keep essential system variables that Claude might need.
 */

/** Prefixes to exclude from child process environment */
const EXCLUDED_PREFIXES = [
  "npm_", // npm/pnpm lifecycle variables
  "YEP_ANYWHERE_", // Our internal variables
  "VITE_", // Vite dev server variables
  "VITEST", // Vitest test runner
  "LOG_", // Our logging configuration
];

/** Exact variable names to exclude */
const EXCLUDED_VARS = new Set([
  // npm/pnpm specific
  "npm_execpath",
  "npm_node_execpath",
  // Development tools
  "INIT_CWD",
  "COLOR",
  "FORCE_COLOR",
  // Auth/maintenance ports (internal to yep-anywhere)
  "MAINTENANCE_PORT",
  // Proxy debug (internal)
  "PROXY_DEBUG",
  // Prevent nested session detection when server runs inside Claude Code
  "CLAUDECODE",
  // NODE_ENV is set to "production" by yepanywhere's CLI but should not
  // leak into Claude Code child processes where it breaks project tooling
  // (e.g. React 19 + Vitest). See GitHub issue #41.
  "NODE_ENV",
]);

/** Essential variables to always keep (even if they match excluded patterns) */
const ALWAYS_KEEP = new Set([
  // Core system
  "HOME",
  "USER",
  "SHELL",
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  // Common development tools
  "EDITOR",
  "VISUAL",
  "PAGER",
  // Node/runtime
  "NODE_OPTIONS",
  "NODE_PATH",
  "NVM_DIR",
  "NVM_BIN",
  // Git
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_SSH_COMMAND",
  // SSH
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  // API keys Claude might need
  "ANTHROPIC_API_KEY",
  // XDG directories
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
  // Misc
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
]);

/**
 * Filter environment variables for spawning child Claude processes.
 *
 * @param env - Environment object to filter (defaults to process.env)
 * @returns Filtered environment object suitable for child processes
 */
export function filterEnvForChildProcess(
  env: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const filtered: Record<string, string | undefined> = {};

  for (const [key, value] of Object.entries(env)) {
    // Always keep essential variables
    if (ALWAYS_KEEP.has(key)) {
      filtered[key] = value;
      continue;
    }

    // Exclude exact matches
    if (EXCLUDED_VARS.has(key)) {
      continue;
    }

    // Exclude by prefix
    if (EXCLUDED_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      continue;
    }

    // Keep everything else
    filtered[key] = value;
  }

  return filtered;
}
