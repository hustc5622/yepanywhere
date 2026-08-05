#!/usr/bin/env node
/**
 * Regenerate checked-in Codex app-server protocol subset used by the provider.
 *
 * Also keeps package.json `yepAnywhere.codexCli.expectedVersion` in sync with
 * the locally installed `codex` CLI, so the startup version check stays
 * accurate after a codex upgrade.
 *
 * Usage:
 *   pnpm codex:protocol:update   # refresh subset + sync version pin
 *   pnpm codex:protocol:check    # verify subset + pin are up to date (CI)
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  dirname,
  join,
  posix as pathPosix,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

const SUBSET_ROOT = join(
  REPO_ROOT,
  "packages/server/src/sdk/providers/codex-protocol/generated",
);
const SUBSET_INDEX_FILE = join(
  REPO_ROOT,
  "packages/server/src/sdk/providers/codex-protocol/index.ts",
);

const SUBSET_EXPORTS = [
  { name: "AskForApproval", file: "v2/AskForApproval.ts" },
  { name: "SandboxMode", file: "v2/SandboxMode.ts" },
  { name: "ThreadStartParams", file: "v2/ThreadStartParams.ts" },
  { name: "ThreadResumeParams", file: "v2/ThreadResumeParams.ts" },
  { name: "TurnStartParams", file: "v2/TurnStartParams.ts" },
  { name: "ThreadStartResponse", file: "v2/ThreadStartResponse.ts" },
  { name: "ThreadResumeResponse", file: "v2/ThreadResumeResponse.ts" },
  { name: "TurnStartResponse", file: "v2/TurnStartResponse.ts" },
  {
    name: "CommandExecutionRequestApprovalParams",
    file: "v2/CommandExecutionRequestApprovalParams.ts",
  },
  {
    name: "FileChangeRequestApprovalParams",
    file: "v2/FileChangeRequestApprovalParams.ts",
  },
  {
    name: "CommandExecutionApprovalDecision",
    file: "v2/CommandExecutionApprovalDecision.ts",
  },
  {
    name: "FileChangeApprovalDecision",
    file: "v2/FileChangeApprovalDecision.ts",
  },
  {
    name: "ToolRequestUserInputParams",
    file: "v2/ToolRequestUserInputParams.ts",
  },
  {
    name: "ToolRequestUserInputResponse",
    file: "v2/ToolRequestUserInputResponse.ts",
  },
  { name: "ItemStartedNotification", file: "v2/ItemStartedNotification.ts" },
  {
    name: "ItemCompletedNotification",
    file: "v2/ItemCompletedNotification.ts",
  },
  {
    name: "ThreadTokenUsageUpdatedNotification",
    file: "v2/ThreadTokenUsageUpdatedNotification.ts",
  },
  {
    name: "TurnCompletedNotification",
    file: "v2/TurnCompletedNotification.ts",
  },
  { name: "ErrorNotification", file: "v2/ErrorNotification.ts" },
  { name: "ThreadItem", file: "v2/ThreadItem.ts" },
];

function toPosixPath(filePath) {
  return filePath.split(sep).join("/");
}

function parseMode(argv) {
  if (argv.includes("--check")) return "check";
  return "update";
}

function runCodex(args) {
  const result = spawnSync("codex", args, {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() ?? "";
    const stdout = result.stdout?.trim() ?? "";
    const output = [stdout, stderr].filter(Boolean).join("\n");
    throw new Error(
      `Command failed: codex ${args.join(" ")}${output ? `\n${output}` : ""}`,
    );
  }

  // codex can emit non-fatal warnings on stderr; surface them but do not fail.
  const stderr = result.stderr?.trim();
  if (stderr) {
    console.warn(stderr);
  }
}

// --- Codex CLI version pin (package.json yepAnywhere.codexCli.expectedVersion) ---
// The vendored protocol subset is generated from the locally installed `codex`,
// so the pin should track that same version. `update` refreshes it; `check`
// fails when it has drifted (e.g. codex auto-updated but nobody re-ran update).

const PACKAGE_JSON_PATH = join(REPO_ROOT, "package.json");
const EXPECTED_VERSION_RE = /("expectedVersion"\s*:\s*")([^"]+)(")/;

function detectCodexVersion() {
  const result = spawnSync("codex", ["--version"], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return null;
  const out = (result.stdout ?? "").trim();
  const match = out.match(/(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?/);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

function readExpectedCodexVersion() {
  if (!existsSync(PACKAGE_JSON_PATH)) return null;
  const match = readFileSync(PACKAGE_JSON_PATH, "utf-8").match(
    EXPECTED_VERSION_RE,
  );
  return match ? match[2] : null;
}

function writeExpectedCodexVersion(version) {
  const raw = readFileSync(PACKAGE_JSON_PATH, "utf-8");
  const updated = raw.replace(EXPECTED_VERSION_RE, `$1${version}$3`);
  writeFileSync(PACKAGE_JSON_PATH, updated, "utf-8");
}

function listFilesRecursively(root) {
  const files = [];

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        files.push(relative(root, fullPath));
      }
    }
  };

  if (existsSync(root)) {
    walk(root);
  }

  return files.sort();
}

function snapshotDir(root) {
  const snapshot = new Map();
  for (const relPath of listFilesRecursively(root)) {
    const fullPath = join(root, relPath);
    snapshot.set(relPath, readFileSync(fullPath, "utf-8"));
  }
  return snapshot;
}

function diffSnapshots(current, generated) {
  const added = [];
  const removed = [];
  const changed = [];

  for (const [path, content] of generated) {
    if (!current.has(path)) {
      added.push(path);
      continue;
    }
    if (current.get(path) !== content) {
      changed.push(path);
    }
  }

  for (const path of current.keys()) {
    if (!generated.has(path)) {
      removed.push(path);
    }
  }

  return {
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort(),
  };
}

function printDiff(label, diff) {
  const hasDiff =
    diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0;

  if (!hasDiff) {
    return;
  }

  console.log(`${label}:`);
  for (const file of diff.added) {
    console.log(`  + ${file}`);
  }
  for (const file of diff.removed) {
    console.log(`  - ${file}`);
  }
  for (const file of diff.changed) {
    console.log(`  ~ ${file}`);
  }
}

function resolveLocalImport(file, specifier) {
  const importerDir = pathPosix.dirname(file);
  const withExt = specifier.endsWith(".ts") ? specifier : `${specifier}.ts`;
  return pathPosix.normalize(pathPosix.join(importerDir, withExt));
}

function collectSubsetFiles(sourceTypesDir) {
  const queue = SUBSET_EXPORTS.map((item) => toPosixPath(item.file));
  const seen = new Set();

  while (queue.length > 0) {
    const current = queue.pop();
    if (!current || seen.has(current)) continue;

    const absPath = join(sourceTypesDir, current);
    if (!existsSync(absPath)) {
      throw new Error(`Missing generated type file: ${current}`);
    }

    seen.add(current);
    const content = readFileSync(absPath, "utf-8");
    const importRegex = /from\s+"([^"]+)"/g;
    for (const match of content.matchAll(importRegex)) {
      const specifier = match[1];
      if (!specifier?.startsWith(".")) continue;
      const resolved = resolveLocalImport(current, specifier);
      queue.push(resolved);
    }
  }

  return [...seen].sort();
}

function buildSubsetIndexContent() {
  const lines = [
    "// AUTO-GENERATED by scripts/update-codex-protocol.mjs. Do not edit.",
    "",
  ];

  for (const item of SUBSET_EXPORTS) {
    const modulePath = `./generated/${toPosixPath(item.file).replace(/\.ts$/, ".js")}`;
    lines.push(`export type { ${item.name} } from "${modulePath}";`);
  }

  lines.push("");
  return lines.join("\n");
}

function rewriteRelativeSpecifiers(content) {
  return content.replace(/from\s+"(\.[^"]+)"/g, (_match, specifier) => {
    if (specifier.endsWith(".js")) {
      return `from "${specifier}"`;
    }
    if (specifier.endsWith(".ts")) {
      return `from "${specifier.replace(/\.ts$/, ".js")}"`;
    }
    if (/\.[a-z]+$/i.test(specifier)) {
      return `from "${specifier}"`;
    }
    return `from "${specifier}.js"`;
  });
}

function writeSubsetArtifacts(sourceTypesDir, subsetDir, subsetIndexFile) {
  const subsetFiles = collectSubsetFiles(sourceTypesDir);

  rmSync(subsetDir, { recursive: true, force: true });
  mkdirSync(subsetDir, { recursive: true });

  for (const relPath of subsetFiles) {
    const sourcePath = join(sourceTypesDir, relPath);
    const destinationPath = join(subsetDir, relPath);
    mkdirSync(dirname(destinationPath), { recursive: true });
    const sourceContent = readFileSync(sourcePath, "utf-8");
    const rewritten = rewriteRelativeSpecifiers(sourceContent);
    writeFileSync(destinationPath, rewritten, "utf-8");
  }

  mkdirSync(dirname(subsetIndexFile), { recursive: true });
  writeFileSync(subsetIndexFile, buildSubsetIndexContent(), "utf-8");
}

function main() {
  const mode = parseMode(process.argv.slice(2));
  const tempRoot = mkdtempSync(join(tmpdir(), "codex-protocol-"));
  const generatedTypesDir = join(tempRoot, "types");
  const generatedSubsetDir = join(tempRoot, "subset");
  const generatedSubsetIndex = join(tempRoot, "subset-index.ts");

  try {
    mkdirSync(generatedTypesDir, { recursive: true });

    runCodex(["app-server", "generate-ts", "--out", generatedTypesDir]);
    writeSubsetArtifacts(
      generatedTypesDir,
      generatedSubsetDir,
      generatedSubsetIndex,
    );

    if (mode === "check") {
      const subsetDiff = diffSnapshots(
        snapshotDir(SUBSET_ROOT),
        snapshotDir(generatedSubsetDir),
      );
      const currentSubsetIndex = existsSync(SUBSET_INDEX_FILE)
        ? readFileSync(SUBSET_INDEX_FILE, "utf-8")
        : "";
      const generatedSubsetIndexContent = readFileSync(
        generatedSubsetIndex,
        "utf-8",
      );
      const subsetIndexChanged =
        currentSubsetIndex !== generatedSubsetIndexContent;

      const expectedVersion = readExpectedCodexVersion();
      const detectedVersion = detectCodexVersion();
      const pinMismatch =
        expectedVersion != null &&
        detectedVersion != null &&
        expectedVersion !== detectedVersion;

      const hasDiff =
        subsetDiff.added.length > 0 ||
        subsetDiff.removed.length > 0 ||
        subsetDiff.changed.length > 0 ||
        subsetIndexChanged ||
        pinMismatch;

      if (hasDiff) {
        console.error("Codex protocol subset artifacts are out of date.");
        printDiff("subset", subsetDiff);
        if (subsetIndexChanged) {
          console.log("subset index:");
          console.log("  ~ index.ts");
        }
        if (pinMismatch) {
          console.error(
            `Codex CLI version pin mismatch: package.json expects ${expectedVersion}, detected ${detectedVersion}.`,
          );
        }
        console.error("Run `pnpm codex:protocol:update` to refresh.");
        process.exit(1);
      }

      console.log("Codex protocol subset artifacts are up to date.");
      return;
    }

    writeSubsetArtifacts(generatedTypesDir, SUBSET_ROOT, SUBSET_INDEX_FILE);
    const subsetCount = listFilesRecursively(SUBSET_ROOT).length;

    const detectedVersion = detectCodexVersion();
    if (detectedVersion) {
      const currentVersion = readExpectedCodexVersion();
      if (currentVersion !== detectedVersion) {
        writeExpectedCodexVersion(detectedVersion);
        console.log(`Updated Codex CLI version pin to ${detectedVersion}.`);
      }
    }

    console.log(
      `Updated Codex protocol subset artifacts (${subsetCount} files).`,
    );
    console.log(`Output: ${relative(REPO_ROOT, SUBSET_ROOT)}`);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main();
