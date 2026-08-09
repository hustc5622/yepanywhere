import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "../../../../..");
const PROTOCOL_ROOT = resolve(
  TEST_DIR,
  "../../../src/sdk/providers/codex-protocol",
);
const GENERATED_ROOT = join(PROTOCOL_ROOT, "generated");
const SCHEMA_ROOT = join(PROTOCOL_ROOT, "schema");

const manifest = JSON.parse(
  readFileSync(join(PROTOCOL_ROOT, "manifest.json"), "utf-8"),
);
const coverage = JSON.parse(
  readFileSync(join(PROTOCOL_ROOT, "coverage-registry.json"), "utf-8"),
);
const rootPackage = JSON.parse(
  readFileSync(join(REPO_ROOT, "package.json"), "utf-8"),
);

const capabilityKeys = [
  "clientRequests",
  "serverRequests",
  "serverNotifications",
  "threadItems",
  "userInputs",
] as const;

const coveragePairs = [
  ["serverRequests", "serverRequests"],
  ["serverNotifications", "serverNotifications"],
  ["threadItems", "threadItems"],
  ["userInputs", "userInputs"],
] as const;

function listFilesRecursively(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile()) files.push(relative(root, fullPath));
    }
  };
  walk(root);
  return files.sort();
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, stableJson(child)]),
    );
  }
  return value;
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function hashSchemaProfile(profile: "stable" | "experimental"): string {
  const root = join(SCHEMA_ROOT, profile);
  const names = [
    "codex_app_server_protocol.schemas.json",
    "codex_app_server_protocol.v2.schemas.json",
  ];
  const bundles = Object.fromEntries(
    names.map((name) => [
      name,
      JSON.parse(readFileSync(join(root, name), "utf-8")),
    ]),
  );
  return sha256(JSON.stringify(stableJson(bundles)));
}

function hashDirectory(root: string): string {
  const hash = createHash("sha256");
  for (const relPath of listFilesRecursively(root)) {
    hash.update(relPath.split(sep).join("/"));
    hash.update("\0");
    hash.update(readFileSync(join(root, relPath)));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

describe("Codex app-server protocol baseline", () => {
  it("pins the configured Codex version and deterministic artifact hashes", () => {
    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.codex).toEqual({
      version: "0.147.0",
      versionOutput: "codex-cli 0.147.0",
    });
    expect(manifest.codex.version).toBe(
      rootPackage.yepAnywhere.codexCli.expectedVersion,
    );
    expect(manifest.generatedTypes.profile).toBe("experimental");
    expect(manifest.generatedTypes.fileCount).toBe(
      listFilesRecursively(GENERATED_ROOT).length,
    );
    expect(manifest.generatedTypes.hash).toBe(hashDirectory(GENERATED_ROOT));
    expect(manifest.capabilityProfiles.stable.schemaHash).toBe(
      hashSchemaProfile("stable"),
    );
    expect(manifest.capabilityProfiles.experimental.schemaHash).toBe(
      hashSchemaProfile("experimental"),
    );
  });

  it("records stable and experimental capability profiles without overlap errors", () => {
    const { stable, experimental, experimentalOnly } =
      manifest.capabilityProfiles;
    expect(stable.initializeCapabilities).toEqual({ experimentalApi: false });
    expect(experimental.initializeCapabilities).toEqual({
      experimentalApi: true,
    });

    for (const key of capabilityKeys) {
      const stableValues = new Set<string>(stable[key]);
      const experimentalValues = new Set<string>(experimental[key]);
      expect(
        [...stableValues].filter((value) => !experimentalValues.has(value)),
      ).toEqual([]);
      expect(experimentalOnly[key]).toEqual(
        [...experimentalValues]
          .filter((value) => !stableValues.has(value))
          .sort(),
      );
    }

    expect(stable.clientRequests).toHaveLength(98);
    expect(experimental.clientRequests).toHaveLength(136);
    expect(stable.serverRequests).toHaveLength(10);
    expect(experimental.serverRequests).toHaveLength(11);
    expect(experimentalOnly.serverRequests).toEqual(["currentTime/read"]);
    expect(stable.serverNotifications).toHaveLength(72);
    expect(experimental.serverNotifications).toHaveLength(72);
    expect(experimental.threadItems).toHaveLength(18);
    expect(experimental.userInputs).toEqual([
      "audio",
      "image",
      "localAudio",
      "localImage",
      "mention",
      "skill",
      "text",
    ]);
  });

  it("merges generated TypeScript and JSON Schema method registries", () => {
    const expectedSourceDifferences = {
      mergeStrategy: "union",
      sources: ["generatedTypeScriptDiscriminatedUnion", "jsonSchema"],
      generatedTypeScriptOnly: {
        clientRequests: [
          "getAuthStatus",
          "getConversationSummary",
          "gitDiffToRemote",
        ],
        serverRequests: [],
        serverNotifications: [
          "rawResponse/completed",
          "rawResponseItem/completed",
        ],
      },
      jsonSchemaOnly: {
        clientRequests: [],
        serverRequests: [],
        serverNotifications: [],
      },
    };

    expect(manifest.capabilityProfiles.stable.methodRegistry).toEqual(
      expectedSourceDifferences,
    );
    expect(manifest.capabilityProfiles.experimental.methodRegistry).toEqual(
      expectedSourceDifferences,
    );

    for (const profile of ["stable", "experimental"] as const) {
      const capabilities = manifest.capabilityProfiles[profile];
      expect(capabilities.clientRequests).toEqual(
        expect.arrayContaining([
          "getAuthStatus",
          "getConversationSummary",
          "gitDiffToRemote",
        ]),
      );
      expect(capabilities.serverNotifications).toEqual(
        expect.arrayContaining([
          "rawResponse/completed",
          "rawResponseItem/completed",
        ]),
      );
    }

    expect(coverage.serverNotifications["rawResponse/completed"]).toEqual({
      stability: "stable",
      classification: "raw_response",
    });
    expect(coverage.serverNotifications["rawResponseItem/completed"]).toEqual({
      stability: "stable",
      classification: "raw_response_item",
    });
  });

  it("requires explicit coverage for all four server-facing protocol unions", () => {
    expect(coverage.registryVersion).toBe(1);

    for (const [registryKey, manifestKey] of coveragePairs) {
      const entries = coverage[registryKey];
      const expected = manifest.capabilityProfiles.experimental[manifestKey];
      const stable = new Set<string>(
        manifest.capabilityProfiles.stable[manifestKey],
      );
      expect(Object.keys(entries).sort()).toEqual(expected);

      for (const name of expected) {
        expect(entries[name].classification).toEqual(expect.any(String));
        expect(entries[name].classification.length).toBeGreaterThan(0);
        expect(entries[name].stability).toBe(
          stable.has(name) ? "stable" : "experimental",
        );
      }
    }
  });

  it("checks in the complete generated TypeScript superset with NodeNext imports", () => {
    const requiredFiles = [
      "ClientRequest.ts",
      "ServerRequest.ts",
      "ServerNotification.ts",
      "v2/ThreadItem.ts",
      "v2/UserInput.ts",
    ];
    for (const file of requiredFiles) {
      expect(existsSync(join(GENERATED_ROOT, file)), file).toBe(true);
    }

    expect(listFilesRecursively(GENERATED_ROOT)).toHaveLength(723);
    const extensionlessImports: string[] = [];
    for (const relPath of listFilesRecursively(GENERATED_ROOT)) {
      if (!relPath.endsWith(".ts")) continue;
      const content = readFileSync(join(GENERATED_ROOT, relPath), "utf-8");
      for (const match of content.matchAll(/from\s+"(\.[^"]+)"/g)) {
        if (!match[1]?.endsWith(".js")) {
          extensionlessImports.push(`${relPath}: ${match[1]}`);
        }
      }
    }
    expect(extensionlessImports).toEqual([]);
  });
});
