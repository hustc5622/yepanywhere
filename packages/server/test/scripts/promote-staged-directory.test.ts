import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  promoteStagedDirectory,
  resolveBundleOutputDirectory,
} from "../../../../scripts/promote-staged-directory.js";

describe("resolveBundleOutputDirectory", () => {
  let testDir: string;
  let repoRoot: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "yep-bundle-output-"));
    repoRoot = join(testDir, "repo");
    mkdirSync(join(repoRoot, "dist"), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("allows dedicated output directories under the repository dist directory", () => {
    expect(resolveBundleOutputDirectory(repoRoot)).toBe(
      join(repoRoot, "dist/npm-package"),
    );
    expect(resolveBundleOutputDirectory(repoRoot, "dist/review-bundle")).toBe(
      join(repoRoot, "dist/review-bundle"),
    );
  });

  it("rejects repository source directories even when explicitly configured", () => {
    const clientDir = join(repoRoot, "packages/client");
    mkdirSync(clientDir, { recursive: true });

    expect(() =>
      resolveBundleOutputDirectory(repoRoot, "packages/client"),
    ).toThrow("Unsafe bundle output directory inside the repository");
  });

  it("allows a new external output but rejects an unrelated existing directory", () => {
    const externalOutput = join(testDir, "external-output");
    expect(resolveBundleOutputDirectory(repoRoot, externalOutput)).toBe(
      externalOutput,
    );

    mkdirSync(externalOutput);
    writeFileSync(join(externalOutput, "personal-file.txt"), "keep me");
    expect(() =>
      resolveBundleOutputDirectory(repoRoot, externalOutput),
    ).toThrow("Refusing to replace an unrecognized existing bundle output");
  });

  it("allows replacing an existing recognized external bundle", () => {
    const externalOutput = join(testDir, "external-bundle");
    mkdirSync(join(externalOutput, "dist"), { recursive: true });
    mkdirSync(join(externalOutput, "client-dist"), { recursive: true });
    writeFileSync(
      join(externalOutput, "package.json"),
      JSON.stringify({ name: "yepanywhere" }),
    );
    writeFileSync(join(externalOutput, "build-info.json"), "{}");
    writeFileSync(join(externalOutput, "dist/cli.js"), "export {};");
    writeFileSync(join(externalOutput, "client-dist/index.html"), "<html />");

    expect(resolveBundleOutputDirectory(repoRoot, externalOutput)).toBe(
      externalOutput,
    );
  });
});

describe("promoteStagedDirectory", () => {
  let testDir: string;
  let stagedDir: string;
  let publishedDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "yep-bundle-promotion-"));
    stagedDir = join(testDir, ".npm-package.build-test");
    publishedDir = join(testDir, "npm-package");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("publishes the completed staging directory and removes the old bundle", () => {
    mkdirSync(stagedDir);
    mkdirSync(publishedDir);
    writeFileSync(join(stagedDir, "marker.txt"), "new bundle");
    writeFileSync(join(publishedDir, "marker.txt"), "old bundle");

    promoteStagedDirectory({ stagedDir, publishedDir });

    expect(readFileSync(join(publishedDir, "marker.txt"), "utf8")).toBe(
      "new bundle",
    );
    expect(
      readdirSync(testDir).filter((name) => name.includes(".previous-")),
    ).toEqual([]);
  });

  it("restores the previous bundle when promotion fails", () => {
    mkdirSync(stagedDir);
    mkdirSync(publishedDir);
    writeFileSync(join(stagedDir, "marker.txt"), "new bundle");
    writeFileSync(join(publishedDir, "marker.txt"), "old bundle");

    let renameCount = 0;
    const failPromotion = (source: string, destination: string) => {
      renameCount += 1;
      if (renameCount === 2) {
        throw new Error("simulated promotion failure");
      }
      renameSync(source, destination);
    };

    expect(() =>
      promoteStagedDirectory({ stagedDir, publishedDir }, failPromotion),
    ).toThrow("previous bundle was restored");

    expect(readFileSync(join(publishedDir, "marker.txt"), "utf8")).toBe(
      "old bundle",
    );
    expect(readFileSync(join(stagedDir, "marker.txt"), "utf8")).toBe(
      "new bundle",
    );
  });

  it("does not touch the published bundle when staging is incomplete", () => {
    mkdirSync(publishedDir);
    writeFileSync(join(publishedDir, "marker.txt"), "old bundle");

    expect(() => promoteStagedDirectory({ stagedDir, publishedDir })).toThrow(
      "Staged bundle is unavailable",
    );

    expect(readFileSync(join(publishedDir, "marker.txt"), "utf8")).toBe(
      "old bundle",
    );
  });
});
