#!/usr/bin/env node
// Cross-platform replacement for the old bash-only postinstall:
//   chmod +x node_modules/.pnpm/node-pty@*/node_modules/node-pty/prebuilds/*/spawn-helper 2>/dev/null; exit 0
//
// node-pty's spawn-helper needs the executable bit on POSIX systems. On Windows
// node-pty ships a prebuilt .exe and the chmod is unnecessary (and `chmod` does
// not exist). We keep the exact POSIX behavior and always exit 0.

import { execSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

if (process.platform !== "win32") {
  try {
    const target =
      "node_modules/.pnpm/node-pty@*/node_modules/node-pty/prebuilds/*/spawn-helper";
    execSync(`chmod +x ${JSON.stringify(target)} 2>/dev/null || true`, {
      cwd: repoRoot,
      stdio: "ignore",
      shell: true,
    });
  } catch {
    // Best-effort only; never fail install.
  }
}

process.exit(0);
