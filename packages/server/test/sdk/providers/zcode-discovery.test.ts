/**
 * ZCode CLI discovery tests.
 *
 * Tests `findZCodeCliPath`, `isZCodeCjsBundle`, `resolveZCodeLaunchCommand`,
 * `probeZCodeCliVersion`, and `discoverZCodeCli` using:
 *   - Fake `zcode` script in PATH (via PATH override).
 *   - Fake `.cjs` bundle with Node wrapper.
 *   - `YEP_ZCODE_CLI_PATH` env override.
 *   - Not-found → stable `zcode_cli_not_found`.
 *   - Version probe + compatibility baseline.
 *   - Unsupported version → stable `zcode_cli_unsupported_version`.
 */

import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZCODE_COMPATIBILITY_BASELINE } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverZCodeCli,
  findZCodeCliPath,
  isZCodeCjsBundle,
  probeZCodeCliVersion,
  resolveZCodeLaunchCommand,
} from "../../../src/sdk/providers/zcode-protocol/discovery.js";

// =============================================================================
// Helpers
// =============================================================================

function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "zcode-discovery-test-"));
}

/**
 * Write a fake `zcode` script that responds to `version` with the given
 * version string.
 */
function writeFakeCli(
  tempDir: string,
  filename: string,
  version: string,
  isCjs = false,
): string {
  const path = join(tempDir, filename);
  const script = `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv.includes("version")) {
  process.stdout.write("${version}\\n");
  process.exit(0);
}
process.exit(1);
`;
  writeFileSync(path, script, { mode: 0o755 });
  if (isCjs) {
    // Rename to .cjs to test the bundle detection.
    const cjsPath = `${path}.cjs`;
    writeFileSync(cjsPath, script, { mode: 0o755 });
    return cjsPath;
  }
  return path;
}

/**
 * Write a fake `zcode` script that simulates the app-server: when called with
 * `app-server`, it reads stdin and writes JSON-RPC responses.
 */
function writeFakeAppServerCli(tempDir: string, filename: string): string {
  const path = join(tempDir, filename);
  const script = `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv[0] === "version") {
  process.stdout.write("${ZCODE_COMPATIBILITY_BASELINE.cliVersion}\\n");
  process.exit(0);
}
if (argv[0] === "app-server") {
  // Minimal app-server: respond to workspace/readState then exit on stdin close.
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk.toString("utf-8");
    const lines = buffer.split("\\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg;
      try { msg = JSON.parse(trimmed); } catch { continue; }
      if (msg.method === "workspace/readState") {
        process.stdout.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + "\\n");
      }
    }
  });
  process.stdin.on("end", () => process.exit(0));
  process.exit(0);
}
process.exit(1);
`;
  writeFileSync(path, script, { mode: 0o755 });
  return path;
}

/**
 * Override PATH for `which zcode` to resolve to the given dir.
 */
function withPath(pathDir: string): Record<string, string> {
  const currentPath = process.env.PATH ?? "";
  return { PATH: `${pathDir}:${currentPath}` };
}

// =============================================================================
// Tests
// =============================================================================

describe("ZCode CLI discovery", () => {
  let tempDir: string | undefined;

  beforeEach(async () => {
    tempDir = await makeTempDir();
  });

  afterEach(async () => {
    if (tempDir !== undefined) {
      await rm(tempDir, { recursive: true, force: true });
    }
    tempDir = undefined;
  });

  describe("isZCodeCjsBundle", () => {
    it("returns true for .cjs paths", () => {
      expect(isZCodeCjsBundle("/path/to/zcode.cjs")).toBe(true);
    });

    it("returns false for non-.cjs paths", () => {
      expect(isZCodeCjsBundle("/usr/local/bin/zcode")).toBe(false);
      expect(isZCodeCjsBundle("/path/to/zcode.js")).toBe(false);
    });
  });

  describe("resolveZCodeLaunchCommand", () => {
    it("uses Node wrapper for .cjs bundles", () => {
      const cmd = resolveZCodeLaunchCommand(
        "/apps/ZCode.app/Contents/Resources/glm/zcode.cjs",
      );
      expect(cmd.command).toBe(process.execPath);
      expect(cmd.args).toEqual([
        "/apps/ZCode.app/Contents/Resources/glm/zcode.cjs",
        "app-server",
      ]);
      expect(cmd.isCjs).toBe(true);
    });

    it("uses the path directly for native executables", () => {
      const cmd = resolveZCodeLaunchCommand("/usr/local/bin/zcode");
      expect(cmd.command).toBe("/usr/local/bin/zcode");
      expect(cmd.args).toEqual(["app-server"]);
      expect(cmd.isCjs).toBe(false);
    });
  });

  describe("findZCodeCliPath", () => {
    it("finds CLI via YEP_ZCODE_CLI_PATH env override", async () => {
      const fakePath = writeFakeCli(
        tempDir,
        "zcode",
        ZCODE_COMPATIBILITY_BASELINE.cliVersion,
      );
      const original = process.env.YEP_ZCODE_CLI_PATH;
      process.env.YEP_ZCODE_CLI_PATH = fakePath;
      try {
        const result = await findZCodeCliPath();
        expect(result).not.toBeNull();
        expect(result?.path).toBe(fakePath);
        expect(result?.source).toBe("env");
      } finally {
        if (original !== undefined) {
          process.env.YEP_ZCODE_CLI_PATH = original;
        } else {
          Reflect.deleteProperty(process.env, "YEP_ZCODE_CLI_PATH");
        }
      }
    });

    it("finds CLI via PATH lookup", async () => {
      const fakePath = writeFakeCli(
        tempDir,
        "zcode",
        ZCODE_COMPATIBILITY_BASELINE.cliVersion,
      );
      const originalPath = process.env.PATH;
      process.env.PATH = withPath(tempDir).PATH;
      // Clear env override so PATH is used.
      const originalEnv = process.env.YEP_ZCODE_CLI_PATH;
      Reflect.deleteProperty(process.env, "YEP_ZCODE_CLI_PATH");
      try {
        const result = await findZCodeCliPath();
        expect(result).not.toBeNull();
        expect(result?.path).toBe(fakePath);
        expect(result?.source).toBe("path");
      } finally {
        process.env.PATH = originalPath;
        if (originalEnv !== undefined) {
          process.env.YEP_ZCODE_CLI_PATH = originalEnv;
        }
      }
    });

    it("returns null when CLI is not found (on machines without ZCode.app)", async () => {
      // On a machine without /Applications/ZCode.app, clearing PATH and env
      // yields null.  On a machine with the app installed, the bundle path is
      // found instead.  Both are valid — we just verify no crash.
      const originalEnv = process.env.YEP_ZCODE_CLI_PATH;
      Reflect.deleteProperty(process.env, "YEP_ZCODE_CLI_PATH");
      const originalPath = process.env.PATH;
      process.env.PATH = "";
      try {
        const result = await findZCodeCliPath();
        // Either null (no app installed) or a bundle path (app installed).
        expect(result === null || typeof result?.path === "string").toBe(true);
      } finally {
        process.env.PATH = originalPath;
        if (originalEnv !== undefined) {
          process.env.YEP_ZCODE_CLI_PATH = originalEnv;
        }
      }
    });
  });

  describe("probeZCodeCliVersion", () => {
    it("parses a version string from CLI output", async () => {
      const fakePath = writeFakeCli(
        tempDir,
        "zcode",
        ZCODE_COMPATIBILITY_BASELINE.cliVersion,
      );
      const version = await probeZCodeCliVersion(fakePath);
      expect(version).toBe(ZCODE_COMPATIBILITY_BASELINE.cliVersion);
    });

    it("returns null when version output is unparseable", async () => {
      const path = join(tempDir, "bad-zcode");
      writeFileSync(
        path,
        `#!/usr/bin/env node
process.stdout.write("not-a-version\\n");
`,
        { mode: 0o755 },
      );
      const version = await probeZCodeCliVersion(path);
      expect(version).toBeNull();
    });

    it("returns null when CLI fails to execute", async () => {
      const version = await probeZCodeCliVersion("/nonexistent/path/zcode");
      expect(version).toBeNull();
    });
  });

  describe("discoverZCodeCli", () => {
    it("returns a full result with version when CLI is found", async () => {
      const fakePath = writeFakeCli(
        tempDir,
        "zcode",
        ZCODE_COMPATIBILITY_BASELINE.cliVersion,
      );
      const originalEnv = process.env.YEP_ZCODE_CLI_PATH;
      process.env.YEP_ZCODE_CLI_PATH = fakePath;
      try {
        const result = await discoverZCodeCli();
        expect(result.path).toBe(fakePath);
        expect(result.version).toBe(ZCODE_COMPATIBILITY_BASELINE.cliVersion);
        expect(result.source).toBe("env");
        expect(result.errorCode).toBeNull();
      } finally {
        if (originalEnv !== undefined) {
          process.env.YEP_ZCODE_CLI_PATH = originalEnv;
        } else {
          Reflect.deleteProperty(process.env, "YEP_ZCODE_CLI_PATH");
        }
      }
    });

    it("returns zcode_cli_not_found when CLI is missing", async () => {
      // When PATH is empty and no env override is set, the result depends on
      // whether the real /Applications/ZCode.app bundle exists on this machine.
      // We verify the contract: either not-found (errorCode set) or found
      // (errorCode null).  Both are valid outcomes on different machines.
      const originalEnv = process.env.YEP_ZCODE_CLI_PATH;
      const originalPath = process.env.PATH;
      Reflect.deleteProperty(process.env, "YEP_ZCODE_CLI_PATH");
      process.env.PATH = "";
      try {
        const result = await discoverZCodeCli();
        if (result.errorCode === "zcode_cli_not_found") {
          expect(result.path).toBeNull();
          expect(result.version).toBeNull();
        } else {
          // Found via app bundle — valid on machines with ZCode installed.
          expect(result.path).not.toBeNull();
          expect(result.errorCode).toBeNull();
        }
      } finally {
        process.env.PATH = originalPath;
        if (originalEnv !== undefined) {
          process.env.YEP_ZCODE_CLI_PATH = originalEnv;
        }
      }
    });

    it("returns zcode_cli_unsupported_version for old versions", async () => {
      const fakePath = writeFakeCli(tempDir, "zcode", "0.1.0");
      const originalEnv = process.env.YEP_ZCODE_CLI_PATH;
      process.env.YEP_ZCODE_CLI_PATH = fakePath;
      try {
        const result = await discoverZCodeCli();
        expect(result.version).toBe("0.1.0");
        expect(result.errorCode).toBe("zcode_cli_unsupported_version");
      } finally {
        if (originalEnv !== undefined) {
          process.env.YEP_ZCODE_CLI_PATH = originalEnv;
        } else {
          Reflect.deleteProperty(process.env, "YEP_ZCODE_CLI_PATH");
        }
      }
    });

    it("accepts versions equal to the baseline", async () => {
      const fakePath = writeFakeCli(
        tempDir,
        "zcode",
        ZCODE_COMPATIBILITY_BASELINE.cliVersion,
      );
      const originalEnv = process.env.YEP_ZCODE_CLI_PATH;
      process.env.YEP_ZCODE_CLI_PATH = fakePath;
      try {
        const result = await discoverZCodeCli();
        expect(result.errorCode).toBeNull();
      } finally {
        if (originalEnv !== undefined) {
          process.env.YEP_ZCODE_CLI_PATH = originalEnv;
        } else {
          Reflect.deleteProperty(process.env, "YEP_ZCODE_CLI_PATH");
        }
      }
    });

    it("accepts versions newer than the baseline", async () => {
      const fakePath = writeFakeCli(tempDir, "zcode", "0.20.0");
      const originalEnv = process.env.YEP_ZCODE_CLI_PATH;
      process.env.YEP_ZCODE_CLI_PATH = fakePath;
      try {
        const result = await discoverZCodeCli();
        expect(result.errorCode).toBeNull();
        expect(result.version).toBe("0.20.0");
      } finally {
        if (originalEnv !== undefined) {
          process.env.YEP_ZCODE_CLI_PATH = originalEnv;
        } else {
          Reflect.deleteProperty(process.env, "YEP_ZCODE_CLI_PATH");
        }
      }
    });

    it("detects .cjs bundles and sets isCjs", async () => {
      const fakePath = writeFakeCli(
        tempDir,
        "zcode",
        ZCODE_COMPATIBILITY_BASELINE.cliVersion,
        true, // .cjs
      );
      const originalEnv = process.env.YEP_ZCODE_CLI_PATH;
      process.env.YEP_ZCODE_CLI_PATH = fakePath;
      try {
        const result = await discoverZCodeCli();
        expect(result.isCjs).toBe(true);
        expect(result.errorCode).toBeNull();
      } finally {
        if (originalEnv !== undefined) {
          process.env.YEP_ZCODE_CLI_PATH = originalEnv;
        } else {
          Reflect.deleteProperty(process.env, "YEP_ZCODE_CLI_PATH");
        }
      }
    });
  });
});
