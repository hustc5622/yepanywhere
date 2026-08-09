#!/usr/bin/env node
/**
 * Regenerate the checked-in Codex app-server protocol baseline.
 *
 * The installed Codex binary is the source of truth. We generate both the
 * stable (default) and experimental schemas so the manifest can distinguish
 * capability stability, while checking in the complete experimental
 * TypeScript superset for consumers that need an exact protocol type.
 *
 * Usage:
 *   pnpm codex:protocol:update
 *   pnpm codex:protocol:check
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const ROOT_PACKAGE_FILE = join(REPO_ROOT, "package.json");
const PROTOCOL_ROOT = join(
  REPO_ROOT,
  "packages/server/src/sdk/providers/codex-protocol",
);
const GENERATED_TYPES_ROOT = join(PROTOCOL_ROOT, "generated");
const SCHEMA_ROOT = join(PROTOCOL_ROOT, "schema");
const MANIFEST_FILE = join(PROTOCOL_ROOT, "manifest.json");
const INDEX_FILE = join(PROTOCOL_ROOT, "index.ts");
const COVERAGE_FILE = join(PROTOCOL_ROOT, "coverage-registry.json");

const SCHEMA_BUNDLE_FILES = [
  "codex_app_server_protocol.schemas.json",
  "codex_app_server_protocol.v2.schemas.json",
];

const COMPATIBILITY_EXPORTS = [
  { name: "AskForApproval", file: "v2/AskForApproval.ts" },
  { name: "SandboxMode", file: "v2/SandboxMode.ts" },
  { name: "ThreadStartParams", file: "v2/ThreadStartParams.ts" },
  { name: "ThreadResumeParams", file: "v2/ThreadResumeParams.ts" },
  { name: "ThreadForkParams", file: "v2/ThreadForkParams.ts" },
  { name: "TurnStartParams", file: "v2/TurnStartParams.ts" },
  { name: "ThreadStartResponse", file: "v2/ThreadStartResponse.ts" },
  { name: "ThreadResumeResponse", file: "v2/ThreadResumeResponse.ts" },
  { name: "ThreadForkResponse", file: "v2/ThreadForkResponse.ts" },
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

const FULL_PROTOCOL_EXPORTS = [
  { name: "ClientRequest", file: "ClientRequest.ts" },
  { name: "ServerRequest", file: "ServerRequest.ts" },
  { name: "ServerNotification", file: "ServerNotification.ts" },
  { name: "InitializeCapabilities", file: "InitializeCapabilities.ts" },
  { name: "UserInput", file: "v2/UserInput.ts" },
];

const COVERAGE_SECTIONS = [
  { registry: "serverRequests", manifest: "serverRequests" },
  { registry: "serverNotifications", manifest: "serverNotifications" },
  { registry: "threadItems", manifest: "threadItems" },
  { registry: "userInputs", manifest: "userInputs" },
];

const CAPABILITY_KEYS = [
  "clientRequests",
  "serverRequests",
  "serverNotifications",
  "threadItems",
  "userInputs",
];

const METHOD_REGISTRY_SECTIONS = [
  {
    key: "clientRequests",
    generatedTypeFile: "ClientRequest.ts",
    jsonSchemaFile: "ClientRequest.json",
  },
  {
    key: "serverRequests",
    generatedTypeFile: "ServerRequest.ts",
    jsonSchemaFile: "ServerRequest.json",
  },
  {
    key: "serverNotifications",
    generatedTypeFile: "ServerNotification.ts",
    jsonSchemaFile: "ServerNotification.json",
  },
];

function toPosixPath(filePath) {
  return filePath.split(sep).join("/");
}

function parseMode(argv) {
  const supported = new Set(["--check"]);
  const unknown = argv.filter((arg) => !supported.has(arg));
  if (unknown.length > 0) {
    throw new Error(`Unknown argument(s): ${unknown.join(", ")}`);
  }
  return argv.includes("--check") ? "check" : "update";
}

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    const output = [result.stdout?.trim(), result.stderr?.trim()]
      .filter(Boolean)
      .join("\n");
    throw new Error(
      `Command failed: ${command} ${args.join(" ")}${output ? `\n${output}` : ""}`,
    );
  }

  const stderr = result.stderr?.trim();
  if (stderr) console.warn(stderr);
  return result.stdout?.trim() ?? "";
}

function getCodexVersion() {
  const output = runCommand("codex", ["--version"]);
  const match = /^codex-cli\s+(\S+)$/m.exec(output);
  if (!match?.[1]) {
    throw new Error(
      `Unable to parse Codex version from: ${JSON.stringify(output)}`,
    );
  }
  return { output, version: match[1] };
}

function runCodexGenerator(kind, outDir, experimental) {
  mkdirSync(outDir, { recursive: true });
  const args = ["app-server", kind];
  if (experimental) args.push("--experimental");
  args.push("--out", outDir);
  runCommand("codex", args);
}

function listFilesRecursively(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile()) files.push(relative(root, fullPath));
    }
  };
  if (existsSync(root)) walk(root);
  return files.sort();
}

function snapshotDir(root) {
  const snapshot = new Map();
  for (const relPath of listFilesRecursively(root)) {
    snapshot.set(relPath, readFileSync(join(root, relPath)));
  }
  return snapshot;
}

function diffSnapshots(current, generated) {
  const added = [];
  const removed = [];
  const changed = [];

  for (const [path, content] of generated) {
    if (!current.has(path)) added.push(path);
    else if (!current.get(path).equals(content)) changed.push(path);
  }
  for (const path of current.keys()) {
    if (!generated.has(path)) removed.push(path);
  }

  return {
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort(),
  };
}

function hasDiff(diff) {
  return (
    diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0
  );
}

function printDiff(label, diff) {
  if (!hasDiff(diff)) return;
  console.log(`${label}:`);
  for (const file of diff.added) console.log(`  + ${file}`);
  for (const file of diff.removed) console.log(`  - ${file}`);
  for (const file of diff.changed) console.log(`  ~ ${file}`);
}

function rewriteRelativeSpecifiers(content, sourcePath) {
  return content.replace(/from\s+"(\.[^"]+)"/g, (_match, specifier) => {
    if (specifier.endsWith(".js")) return `from "${specifier}"`;
    if (specifier.endsWith(".ts")) {
      return `from "${specifier.replace(/\.ts$/, ".js")}"`;
    }
    if (/\.[a-z]+$/i.test(specifier)) return `from "${specifier}"`;
    const sourceTarget = resolve(dirname(sourcePath), specifier);
    if (existsSync(sourceTarget) && statSync(sourceTarget).isDirectory()) {
      return `from "${specifier}/index.js"`;
    }
    return `from "${specifier}.js"`;
  });
}

function writeFullTypes(sourceDir, destinationDir) {
  rmSync(destinationDir, { recursive: true, force: true });
  mkdirSync(destinationDir, { recursive: true });
  for (const relPath of listFilesRecursively(sourceDir)) {
    const sourcePath = join(sourceDir, relPath);
    const destinationPath = join(destinationDir, relPath);
    mkdirSync(dirname(destinationPath), { recursive: true });
    const content = readFileSync(sourcePath, "utf-8");
    writeFileSync(
      destinationPath,
      rewriteRelativeSpecifiers(content, sourcePath),
      "utf-8",
    );
  }
}

function writeSchemaBundles(sourceDir, destinationDir) {
  rmSync(destinationDir, { recursive: true, force: true });
  mkdirSync(destinationDir, { recursive: true });
  for (const fileName of SCHEMA_BUNDLE_FILES) {
    const sourcePath = join(sourceDir, fileName);
    if (!existsSync(sourcePath)) {
      throw new Error(`Missing generated schema bundle: ${sourcePath}`);
    }
    copyFileSync(sourcePath, join(destinationDir, fileName));
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableJson(value[key])]),
    );
  }
  return value;
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function hashSchemaBundles(schemaDir) {
  const bundles = Object.fromEntries(
    SCHEMA_BUNDLE_FILES.map((fileName) => [
      fileName,
      JSON.parse(readFileSync(join(schemaDir, fileName), "utf-8")),
    ]),
  );
  return sha256(JSON.stringify(stableJson(bundles)));
}

function hashDirectory(root) {
  const hash = createHash("sha256");
  for (const relPath of listFilesRecursively(root)) {
    hash.update(toPosixPath(relPath));
    hash.update("\0");
    hash.update(readFileSync(join(root, relPath)));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

function extractDiscriminants(variants, propertyName, sourceLabel) {
  const values = variants.map((variant, index) => {
    const value = variant?.properties?.[propertyName]?.enum?.[0];
    if (typeof value !== "string") {
      throw new Error(
        `Missing ${propertyName} discriminant in ${sourceLabel} variant ${index}`,
      );
    }
    return value;
  });
  return [...new Set(values)].sort();
}

function extractTypeScriptDiscriminants(typeFile, propertyName, sourceLabel) {
  const content = readFileSync(typeFile, "utf-8");
  const pattern = new RegExp(`"${propertyName}"\\s*:\\s*"([^"]+)"`, "g");
  const values = [...content.matchAll(pattern)].map((match) => match[1]);
  if (values.length === 0) {
    throw new Error(
      `Missing ${propertyName} discriminants in generated TypeScript ${sourceLabel}`,
    );
  }
  return [...new Set(values)].sort();
}

function union(...collections) {
  return [...new Set(collections.flat())].sort();
}

function extractMethodRegistry(jsonSchemaDir, generatedTypesDir) {
  const capabilities = {};
  const generatedTypeScriptOnly = {};
  const jsonSchemaOnly = {};

  for (const section of METHOD_REGISTRY_SECTIONS) {
    const jsonSchemaMethods = extractDiscriminants(
      readJson(join(jsonSchemaDir, section.jsonSchemaFile)).oneOf ?? [],
      "method",
      `${section.jsonSchemaFile} JSON Schema`,
    );
    const generatedTypeScriptMethods = extractTypeScriptDiscriminants(
      join(generatedTypesDir, section.generatedTypeFile),
      "method",
      section.generatedTypeFile,
    );

    capabilities[section.key] = union(
      generatedTypeScriptMethods,
      jsonSchemaMethods,
    );
    generatedTypeScriptOnly[section.key] = difference(
      generatedTypeScriptMethods,
      jsonSchemaMethods,
    );
    jsonSchemaOnly[section.key] = difference(
      jsonSchemaMethods,
      generatedTypeScriptMethods,
    );
  }

  return {
    capabilities,
    metadata: {
      mergeStrategy: "union",
      sources: ["generatedTypeScriptDiscriminatedUnion", "jsonSchema"],
      generatedTypeScriptOnly,
      jsonSchemaOnly,
    },
  };
}

function extractProfile(jsonSchemaDir, generatedTypesDir) {
  const methodRegistry = extractMethodRegistry(
    jsonSchemaDir,
    generatedTypesDir,
  );
  const v2Bundle = readJson(
    join(jsonSchemaDir, "codex_app_server_protocol.v2.schemas.json"),
  );
  const threadItems = extractDiscriminants(
    v2Bundle.definitions?.ThreadItem?.oneOf ?? [],
    "type",
    "ThreadItem",
  );
  const userInputs = extractDiscriminants(
    v2Bundle.definitions?.UserInput?.oneOf ?? [],
    "type",
    "UserInput",
  );

  return {
    ...methodRegistry.capabilities,
    threadItems,
    userInputs,
    methodRegistry: methodRegistry.metadata,
  };
}

function difference(all, baseline) {
  const baselineSet = new Set(baseline);
  return all.filter((value) => !baselineSet.has(value));
}

function assertSuperset(stableProfile, experimentalProfile) {
  for (const key of CAPABILITY_KEYS) {
    const experimental = new Set(experimentalProfile[key]);
    const missing = stableProfile[key].filter(
      (value) => !experimental.has(value),
    );
    if (missing.length > 0) {
      throw new Error(
        `Experimental ${key} is missing stable entries: ${missing.join(", ")}`,
      );
    }
  }
}

function buildIndexContent() {
  const lines = [
    "// AUTO-GENERATED by scripts/update-codex-protocol.mjs. Do not edit.",
    "// Complete generated types live under ./generated; exports below preserve",
    "// the existing provider API and expose the protocol-level unions.",
    "",
  ];

  for (const item of [...COMPATIBILITY_EXPORTS, ...FULL_PROTOCOL_EXPORTS]) {
    const modulePath = `./generated/${toPosixPath(item.file).replace(/\.ts$/, ".js")}`;
    lines.push(`export type { ${item.name} } from "${modulePath}";`);
  }
  lines.push("");
  return lines.join("\n");
}

function buildManifest({
  codexVersion,
  stableTypesDir,
  stableJsonDir,
  experimentalTypesDir,
  experimentalJsonDir,
  generatedTypesDir,
}) {
  const stable = extractProfile(stableJsonDir, stableTypesDir);
  const experimental = extractProfile(
    experimentalJsonDir,
    experimentalTypesDir,
  );
  assertSuperset(stable, experimental);

  const experimentalOnly = Object.fromEntries(
    CAPABILITY_KEYS.map((key) => [
      key,
      difference(experimental[key], stable[key]),
    ]),
  );

  return {
    manifestVersion: 1,
    codex: {
      version: codexVersion.version,
      versionOutput: codexVersion.output,
    },
    generatedBy: "scripts/update-codex-protocol.mjs",
    generatedTypes: {
      profile: "experimental",
      fileCount: listFilesRecursively(generatedTypesDir).length,
      hash: hashDirectory(generatedTypesDir),
    },
    capabilityProfiles: {
      stable: {
        generatorArgs: [],
        initializeCapabilities: { experimentalApi: false },
        schemaHash: hashSchemaBundles(stableJsonDir),
        ...stable,
      },
      experimental: {
        generatorArgs: ["--experimental"],
        initializeCapabilities: { experimentalApi: true },
        schemaHash: hashSchemaBundles(experimentalJsonDir),
        ...experimental,
      },
      experimentalOnly,
    },
  };
}

function validateCoverage(manifest) {
  if (!existsSync(COVERAGE_FILE)) {
    throw new Error(`Missing explicit coverage registry: ${COVERAGE_FILE}`);
  }
  const registry = readJson(COVERAGE_FILE);
  const errors = [];

  if (registry.registryVersion !== 1) {
    errors.push("coverage registryVersion must be 1");
  }

  for (const section of COVERAGE_SECTIONS) {
    const entries = registry[section.registry];
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
      errors.push(`${section.registry} must be an object`);
      continue;
    }

    const expected = manifest.capabilityProfiles.experimental[section.manifest];
    const stable = new Set(
      manifest.capabilityProfiles.stable[section.manifest],
    );
    const actual = Object.keys(entries).sort();
    const actualSet = new Set(actual);
    const expectedSet = new Set(expected);
    const missing = expected.filter((name) => !actualSet.has(name));
    const extra = actual.filter((name) => !expectedSet.has(name));
    if (missing.length > 0) {
      errors.push(`${section.registry} missing: ${missing.join(", ")}`);
    }
    if (extra.length > 0) {
      errors.push(`${section.registry} extra: ${extra.join(", ")}`);
    }

    for (const name of expected) {
      const entry = entries[name];
      if (!entry || typeof entry !== "object") continue;
      const expectedStability = stable.has(name) ? "stable" : "experimental";
      if (entry.stability !== expectedStability) {
        errors.push(
          `${section.registry}.${name}.stability must be ${expectedStability}`,
        );
      }
      if (
        typeof entry.classification !== "string" ||
        entry.classification.trim().length === 0
      ) {
        errors.push(`${section.registry}.${name} needs a classification`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Codex protocol coverage registry is incomplete:\n- ${errors.join("\n- ")}`,
    );
  }

  const counts = Object.fromEntries(
    COVERAGE_SECTIONS.map(({ registry: key }) => [
      key,
      Object.keys(registry[key]).length,
    ]),
  );
  return counts;
}

function copyDirectory(sourceDir, destinationDir) {
  rmSync(destinationDir, { recursive: true, force: true });
  mkdirSync(destinationDir, { recursive: true });
  for (const relPath of listFilesRecursively(sourceDir)) {
    const destinationPath = join(destinationDir, relPath);
    mkdirSync(dirname(destinationPath), { recursive: true });
    copyFileSync(join(sourceDir, relPath), destinationPath);
  }
}

function compareFile(currentFile, expectedFile) {
  const current = existsSync(currentFile) ? readFileSync(currentFile) : null;
  const expected = readFileSync(expectedFile);
  return current?.equals(expected) ?? false;
}

function main() {
  const mode = parseMode(process.argv.slice(2));
  const rootPackage = readJson(ROOT_PACKAGE_FILE);
  const expectedVersion = rootPackage.yepAnywhere?.codexCli?.expectedVersion;
  const codexVersion = getCodexVersion();
  if (codexVersion.version !== expectedVersion) {
    throw new Error(
      `Codex version mismatch: installed ${codexVersion.version}, expected ${expectedVersion ?? "<unset>"} in package.json`,
    );
  }

  const tempRoot = mkdtempSync(join(tmpdir(), "codex-protocol-"));
  const stableTypesDir = join(tempRoot, "source/stable/types");
  const stableJsonDir = join(tempRoot, "source/stable/schema");
  const experimentalTypesDir = join(tempRoot, "source/experimental/types");
  const experimentalJsonDir = join(tempRoot, "source/experimental/schema");
  const expectedRoot = join(tempRoot, "expected");
  const expectedTypesDir = join(expectedRoot, "generated");
  const expectedSchemaRoot = join(expectedRoot, "schema");
  const expectedManifestFile = join(expectedRoot, "manifest.json");
  const expectedIndexFile = join(expectedRoot, "index.ts");

  try {
    runCodexGenerator("generate-ts", stableTypesDir, false);
    runCodexGenerator("generate-json-schema", stableJsonDir, false);
    runCodexGenerator("generate-ts", experimentalTypesDir, true);
    runCodexGenerator("generate-json-schema", experimentalJsonDir, true);

    writeFullTypes(experimentalTypesDir, expectedTypesDir);
    writeSchemaBundles(stableJsonDir, join(expectedSchemaRoot, "stable"));
    writeSchemaBundles(
      experimentalJsonDir,
      join(expectedSchemaRoot, "experimental"),
    );

    const manifest = buildManifest({
      codexVersion,
      stableTypesDir,
      stableJsonDir,
      experimentalTypesDir,
      experimentalJsonDir,
      generatedTypesDir: expectedTypesDir,
    });
    mkdirSync(expectedRoot, { recursive: true });
    writeFileSync(
      expectedManifestFile,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf-8",
    );
    runCommand("corepack", [
      "pnpm",
      "exec",
      "biome",
      "format",
      "--write",
      expectedManifestFile,
    ]);
    writeFileSync(expectedIndexFile, buildIndexContent(), "utf-8");

    const coverageCounts = validateCoverage(manifest);

    if (mode === "check") {
      const generatedDiff = diffSnapshots(
        snapshotDir(GENERATED_TYPES_ROOT),
        snapshotDir(expectedTypesDir),
      );
      const schemaDiff = diffSnapshots(
        snapshotDir(SCHEMA_ROOT),
        snapshotDir(expectedSchemaRoot),
      );
      const manifestMatches = compareFile(MANIFEST_FILE, expectedManifestFile);
      const indexMatches = compareFile(INDEX_FILE, expectedIndexFile);
      const drift =
        hasDiff(generatedDiff) ||
        hasDiff(schemaDiff) ||
        !manifestMatches ||
        !indexMatches;

      if (drift) {
        console.error("Codex protocol artifacts are out of date.");
        printDiff("generated types", generatedDiff);
        printDiff("schema", schemaDiff);
        if (!manifestMatches) console.log("  ~ manifest.json");
        if (!indexMatches) console.log("  ~ index.ts");
        console.error("Run `pnpm codex:protocol:update` to refresh.");
        process.exitCode = 1;
        return;
      }

      console.log(
        `Codex ${codexVersion.version} protocol artifacts and coverage are up to date.`,
      );
      console.log(
        `Coverage: ${Object.entries(coverageCounts)
          .map(([key, count]) => `${key}=${count}`)
          .join(", ")}`,
      );
      return;
    }

    copyDirectory(expectedTypesDir, GENERATED_TYPES_ROOT);
    copyDirectory(expectedSchemaRoot, SCHEMA_ROOT);
    copyFileSync(expectedManifestFile, MANIFEST_FILE);
    copyFileSync(expectedIndexFile, INDEX_FILE);

    console.log(
      `Updated Codex ${codexVersion.version} protocol baseline (${manifest.generatedTypes.fileCount} TypeScript files).`,
    );
    console.log(
      `Coverage: ${Object.entries(coverageCounts)
        .map(([key, count]) => `${key}=${count}`)
        .join(", ")}`,
    );
    console.log(`Output: ${relative(REPO_ROOT, PROTOCOL_ROOT)}`);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main();
