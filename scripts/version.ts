#!/usr/bin/env tsx

/**
 * Version governance for the fork release line.
 *
 * See docs/project/versioning.md for the model. In short: this repository is an
 * independent release line from upstream (kzahel/yepanywhere). The product
 * version lives in the root package.json, changes are staged in CHANGELOG.md
 * under [Unreleased], and releases are tagged `ya-v*` — the bare `v*` namespace
 * belongs to upstream.
 *
 *   version:status  read-only report of version / changelog / tag / runtime
 *   version:bump    patch|minor|major -> package.json + CHANGELOG (no commit, no tag)
 *   version:check   assertions; non-zero exit means "not fit to release/deploy"
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT_DIR = path.resolve(import.meta.dirname, "..");
const PACKAGE_JSON = path.join(ROOT_DIR, "package.json");
const CHANGELOG = path.join(ROOT_DIR, "CHANGELOG.md");
const VERIFY_DEPLOY = path.join(ROOT_DIR, "scripts/verify-deploy.mjs");

/** Product tags for this fork. `v*` is reserved for upstream. */
const TAG_PREFIX = "ya-v";
const DEFAULT_BASE_URL =
  process.env.YEP_DEPLOY_BASE_URL || "http://127.0.0.1:8022/yep";

// ---------------------------------------------------------------- formatting

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string, value: string) =>
  useColor ? `\u001b[${code}m${value}\u001b[0m` : value;
const bold = (value: string) => paint("1", value);
const dim = (value: string) => paint("2", value);
const red = (value: string) => paint("31", value);
const green = (value: string) => paint("32", value);
const yellow = (value: string) => paint("33", value);

// -------------------------------------------------------------------- semver

interface Semver {
  major: number;
  minor: number;
  patch: number;
}

function parseSemver(value: string): Semver | null {
  const match = value.trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
  };
}

function formatSemver(version: Semver): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

function compareSemver(a: Semver, b: Semver): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

function bumpSemver(version: Semver, kind: BumpKind): Semver {
  switch (kind) {
    case "major":
      return { major: version.major + 1, minor: 0, patch: 0 };
    case "minor":
      return { major: version.major, minor: version.minor + 1, patch: 0 };
    case "patch":
      return {
        major: version.major,
        minor: version.minor,
        patch: version.patch + 1,
      };
  }
}

type BumpKind = "major" | "minor" | "patch";

// ------------------------------------------------------------------ manifest

function readRootVersion(): string {
  const raw = JSON.parse(fs.readFileSync(PACKAGE_JSON, "utf-8"));
  if (typeof raw.version !== "string") {
    throw new Error(`Root package.json has no string "version" field`);
  }
  return raw.version;
}

/**
 * Rewrite only the version field. A JSON.parse/stringify round-trip would
 * reformat the whole manifest and bury the one-line change in noise.
 */
function writeRootVersion(next: string): void {
  const source = fs.readFileSync(PACKAGE_JSON, "utf-8");
  const pattern = /^(\s*)"version":\s*"[^"]*"/m;
  if (!pattern.test(source)) {
    throw new Error(`Could not locate the "version" field in ${PACKAGE_JSON}`);
  }
  fs.writeFileSync(
    PACKAGE_JSON,
    source.replace(pattern, `$1"version": "${next}"`),
  );
}

// ----------------------------------------------------------------- changelog

interface ChangelogSection {
  /** `Unreleased` or a version string, exactly as written. */
  id: string;
  date: string | null;
  /** Raw body between this heading and the next `## ` heading. */
  body: string;
  headingLine: string;
  index: number;
}

const HEADING = /^## \[([^\]]+)\](?:\s*[-–]\s*(\d{4}-\d{2}-\d{2}))?[^\n]*$/gm;

function readChangelogSections(source: string): ChangelogSection[] {
  const sections: ChangelogSection[] = [];
  const matches = [...source.matchAll(HEADING)];

  matches.forEach((match, position) => {
    const start = match.index ?? 0;
    const nextStart = matches[position + 1]?.index ?? source.length;
    sections.push({
      id: (match[1] ?? "").trim(),
      date: match[2] ?? null,
      body: source.slice(start + match[0].length, nextStart),
      headingLine: match[0],
      index: start,
    });
  });

  return sections;
}

function findUnreleased(sections: ChangelogSection[]) {
  return sections.find((s) => s.id.toLowerCase() === "unreleased") ?? null;
}

/** The newest section whose id is a real version, in file order. */
function findLatestReleased(sections: ChangelogSection[]) {
  return sections.find((s) => parseSemver(s.id) !== null) ?? null;
}

/**
 * A section counts as having entries only if it holds actual list items. A
 * lingering `### Added` with nothing under it is not a changelog entry.
 */
function countEntries(body: string): number {
  return body.split("\n").filter((line) => /^\s*[-*]\s+\S/.test(line)).length;
}

function localToday(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// ------------------------------------------------------------------- git/net

function git(args: string[]): string | null {
  const result = spawnSync("git", args, {
    cwd: ROOT_DIR,
    encoding: "utf-8",
  });
  if (result.status !== 0) return null;
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

interface ForkTag {
  tag: string;
  version: Semver;
}

function listForkTags(): ForkTag[] {
  const raw = git(["tag", "--list", `${TAG_PREFIX}*`]);
  if (!raw) return [];
  return raw
    .split("\n")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .flatMap((tag) => {
      const version = parseSemver(tag.slice(TAG_PREFIX.length));
      return version ? [{ tag, version }] : [];
    })
    .sort((a, b) => compareSemver(a.version, b.version));
}

function latestForkTag(): ForkTag | null {
  const tags = listForkTags();
  return tags.length > 0 ? (tags[tags.length - 1] ?? null) : null;
}

function commitsSince(ref: string): number | null {
  const raw = git(["rev-list", "--count", `${ref}..HEAD`]);
  return raw ? Number.parseInt(raw, 10) : null;
}

function isDirty(): boolean {
  return (git(["status", "--porcelain"]) ?? "").length > 0;
}

interface RuntimeVersion {
  current?: string;
  resumeProtocolVersion?: number;
  build?: { buildId?: string; version?: string; source?: string };
}

async function fetchRuntimeVersion(
  baseUrl: string,
): Promise<RuntimeVersion | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/version`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timer);
    if (!response.ok) return null;
    return (await response.json()) as RuntimeVersion;
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------- status

async function commandStatus(argv: string[]): Promise<number> {
  const baseUrl = readOption(argv, "--base-url") ?? DEFAULT_BASE_URL;

  const rootVersion = readRootVersion();
  const rootSemver = parseSemver(rootVersion);
  const source = fs.readFileSync(CHANGELOG, "utf-8");
  const sections = readChangelogSections(source);
  const unreleased = findUnreleased(sections);
  const released = findLatestReleased(sections);
  const unreleasedEntries = unreleased ? countEntries(unreleased.body) : 0;
  const forkTag = latestForkTag();
  const dirty = isDirty();
  const head = git(["rev-parse", "--short", "HEAD"]) ?? "unknown";
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]) ?? "unknown";

  console.log(bold("\nProduct version"));
  console.log(`  package.json      ${rootVersion}`);
  console.log(
    `  CHANGELOG latest  ${released ? `${released.id}${released.date ? ` (${released.date})` : ""}` : dim("none")}`,
  );
  console.log(
    `  [Unreleased]      ${
      unreleased === null
        ? red("section missing")
        : unreleasedEntries === 0
          ? dim("empty")
          : `${unreleasedEntries} entr${unreleasedEntries === 1 ? "y" : "ies"}`
    }`,
  );

  console.log(bold("\nRelease line"));
  if (forkTag) {
    const since = commitsSince(forkTag.tag);
    console.log(
      `  latest ${TAG_PREFIX}* tag   ${forkTag.tag}${
        since === null ? "" : dim(`  (+${since} commits)`)
      }`,
    );
  } else {
    const describe = git(["describe", "--tags", "--always", "--match", "v*"]);
    console.log(`  latest ${TAG_PREFIX}* tag   ${yellow("none")}`);
    console.log(
      dim(
        `                    fork line not started yet; git describe -> ${describe ?? "n/a"} (upstream line)`,
      ),
    );
  }
  console.log(
    `  HEAD              ${head} on ${branch}${dirty ? yellow("  (dirty)") : ""}`,
  );

  const runtime = await fetchRuntimeVersion(baseUrl);
  console.log(bold("\nRunning server"));
  if (!runtime) {
    console.log(`  ${dim(`no response from ${baseUrl}/api/version`)}`);
  } else {
    console.log(`  current           ${runtime.current ?? "?"}`);
    console.log(
      `  build.buildId     ${runtime.build?.buildId ?? "?"} ${dim(`(${runtime.build?.source ?? "?"})`)}`,
    );
    console.log(`  resumeProtocol    ${runtime.resumeProtocolVersion ?? "?"}`);
  }

  // Verdict. Drift is reported ahead of everything else because it invalidates
  // any conclusion drawn from the version number itself.
  console.log(bold("\nVerdict"));
  const drifted =
    released !== null && rootSemver !== null && released.id !== rootVersion;

  if (rootSemver === null) {
    console.log(
      `  ${red("✗")} root version ${rootVersion} is not valid SemVer`,
    );
  } else if (drifted) {
    console.log(
      `  ${yellow("!")} 版本与 CHANGELOG 漂移: package.json=${rootVersion} but CHANGELOG latest=${released?.id}`,
    );
    console.log(
      dim(
        `      ${rootVersion} was never formally released. Stage the changes under [Unreleased], then run version:bump.`,
      ),
    );
  } else if (unreleasedEntries > 0) {
    console.log(
      `  ${yellow("!")} 需要提升版本: ${unreleasedEntries} unreleased entr${unreleasedEntries === 1 ? "y" : "ies"} pending`,
    );
  } else {
    console.log(`  ${green("✓")} 可直接重启: no unreleased changes recorded`);
  }

  if (runtime?.current && rootSemver) {
    const running = parseSemver(runtime.current.split("-")[0] ?? "");
    if (running && compareSemver(rootSemver, running) <= 0) {
      console.log(
        dim(
          `      running server reports ${runtime.current}; a formal deploy needs a version above it`,
        ),
      );
    }
  }

  console.log();
  return 0;
}

// ---------------------------------------------------------------------- bump

function commandBump(argv: string[]): number {
  const dryRun = argv.includes("--dry-run");
  const kind = argv.find((arg): arg is BumpKind =>
    ["major", "minor", "patch"].includes(arg),
  );

  if (!kind) {
    console.error("Usage: version:bump <patch|minor|major> [--dry-run]");
    return 2;
  }

  const rootVersion = readRootVersion();
  const rootSemver = parseSemver(rootVersion);
  if (!rootSemver) {
    console.error(red(`Root version ${rootVersion} is not valid SemVer.`));
    return 1;
  }

  const source = fs.readFileSync(CHANGELOG, "utf-8");
  const sections = readChangelogSections(source);
  const unreleased = findUnreleased(sections);

  if (!unreleased) {
    console.error(red("CHANGELOG.md has no `## [Unreleased]` section."));
    return 1;
  }

  // Refusing here is the whole point: a version bump with no recorded changes
  // produces a release nobody can describe.
  if (countEntries(unreleased.body) === 0) {
    console.error(red("[Unreleased] is empty — nothing to release."));
    console.error(
      "Record what changed under `## [Unreleased]` in CHANGELOG.md first.",
    );
    return 1;
  }

  const next = formatSemver(bumpSemver(rootSemver, kind));
  const today = localToday();

  const existing = listForkTags().find((t) => formatSemver(t.version) === next);
  if (existing) {
    console.error(red(`Tag ${existing.tag} already exists for ${next}.`));
    return 1;
  }

  const rewritten = source.replace(
    unreleased.headingLine,
    `## [Unreleased]\n\n## [${next}] - ${today}`,
  );

  console.log(`${bold("bump")}  ${rootVersion} -> ${green(next)}  (${kind})`);
  console.log(
    `      CHANGELOG: [Unreleased] -> [${next}] - ${today}, fresh [Unreleased] inserted above`,
  );

  if (dryRun) {
    console.log(yellow("\n--dry-run: no files written."));
    return 0;
  }

  writeRootVersion(next);
  fs.writeFileSync(CHANGELOG, rewritten);

  console.log(green("\nWrote package.json and CHANGELOG.md."));
  console.log("Nothing was committed or tagged. Next:");
  console.log("  1. review          git diff package.json CHANGELOG.md");
  console.log("  2. verify          pnpm version:check");
  console.log(`  3. commit          git commit -am "Release ${next}"`);
  console.log("  4. deploy          pnpm deploy");
  console.log(
    `  5. tag             git tag ${TAG_PREFIX}${next} && git push origin ${TAG_PREFIX}${next}`,
  );
  return 0;
}

// --------------------------------------------------------------------- check

interface CheckResult {
  ok: boolean;
  label: string;
  detail?: string;
}

function commandCheck(argv: string[]): number {
  const profile = readOption(argv, "--profile") ?? "release";
  if (profile !== "release" && profile !== "local") {
    console.error(`Unknown --profile ${profile} (expected: release | local)`);
    return 2;
  }
  const tag = readOption(argv, "--tag");
  const buildInfo = readOption(argv, "--build-info");
  const baseUrl = readOption(argv, "--base-url");

  const results: CheckResult[] = [];
  const rootVersion = readRootVersion();
  const rootSemver = parseSemver(rootVersion);

  // 1. root version is valid SemVer
  results.push({
    ok: rootSemver !== null,
    label: "root package.json version is valid SemVer",
    detail: rootVersion,
  });

  if (!rootSemver) return report(results);

  const source = fs.readFileSync(CHANGELOG, "utf-8");
  const sections = readChangelogSections(source);
  const unreleased = findUnreleased(sections);
  const released = findLatestReleased(sections);

  // 2. newest released CHANGELOG section matches the root version
  results.push({
    ok: released?.id === rootVersion,
    label: "CHANGELOG newest released section matches root version",
    detail: `package.json=${rootVersion} changelog=${released?.id ?? "none"}`,
  });

  // 3. no leftover [Unreleased] entries (release profile only)
  if (profile === "release") {
    const entries = unreleased ? countEntries(unreleased.body) : 0;
    results.push({
      ok: entries === 0,
      label: "[Unreleased] has no pending entries",
      detail: entries === 0 ? "empty" : `${entries} pending`,
    });
  }

  // 4. root version is ahead of the last fork tag
  const forkTag = latestForkTag();
  results.push({
    ok: forkTag === null || compareSemver(rootSemver, forkTag.version) > 0,
    label: `root version is ahead of the last ${TAG_PREFIX}* tag`,
    detail: forkTag
      ? `${rootVersion} vs ${forkTag.tag}`
      : `no ${TAG_PREFIX}* tag yet`,
  });

  // 5. explicit tag matches the root version
  if (tag) {
    const tagged = tag.startsWith(TAG_PREFIX)
      ? parseSemver(tag.slice(TAG_PREFIX.length))
      : null;
    results.push({
      ok: tagged !== null && formatSemver(tagged) === rootVersion,
      label: "--tag matches root version",
      detail: `${tag} vs ${rootVersion}${tag.startsWith(TAG_PREFIX) ? "" : ` (expected ${TAG_PREFIX} prefix)`}`,
    });
  }

  // 6. this version has not already been tagged (release profile only)
  if (profile === "release") {
    const clash = listForkTags().find(
      (t) => formatSemver(t.version) === rootVersion,
    );
    results.push({
      ok: clash === undefined,
      label: "version has not already been tagged",
      detail: clash ? `${clash.tag} exists` : "no clash",
    });
  }

  // 7. built bundle reports the same version
  if (buildInfo) {
    const resolved = path.resolve(ROOT_DIR, buildInfo);
    let built: string | null = null;
    try {
      built = JSON.parse(fs.readFileSync(resolved, "utf-8")).version ?? null;
    } catch {
      built = null;
    }
    results.push({
      ok: built === rootVersion,
      label: "build-info.json version matches root version",
      detail: `${built ?? "unreadable"} vs ${rootVersion}`,
    });
  }

  const exitCode = report(results);

  // 8. deployed build matches the artifact. verify-deploy.mjs already does this
  //    comparison; shelling out keeps one implementation of the buildId rules.
  if (baseUrl) {
    console.log(
      dim(`\n> node scripts/verify-deploy.mjs --base-url ${baseUrl}`),
    );
    const args = [VERIFY_DEPLOY, "--base-url", baseUrl];
    if (buildInfo) args.push("--build-info", buildInfo);
    const result = spawnSync(process.execPath, args, {
      cwd: ROOT_DIR,
      stdio: "inherit",
    });
    if (result.status !== 0) return result.status ?? 1;
  }

  return exitCode;
}

function report(results: CheckResult[]): number {
  let failed = 0;
  for (const result of results) {
    if (!result.ok) failed += 1;
    const mark = result.ok ? green("✓") : red("✗");
    const detail = result.detail ? dim(`  ${result.detail}`) : "";
    console.log(`  ${mark} ${result.label}${detail}`);
  }
  if (failed > 0) {
    console.log(red(`\n${failed} check(s) failed.`));
  }
  return failed > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------- main

function readOption(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function usage(): void {
  console.log(`Usage: tsx scripts/version.ts <command> [options]

Commands:
  status                     Report version, changelog, tag and runtime state
    --base-url <url>         Server to probe (default: ${DEFAULT_BASE_URL})

  bump <patch|minor|major>   Advance the product version and close [Unreleased]
    --dry-run                Print the plan without writing files

  check                      Assert release/deploy readiness (non-zero on failure)
    --profile <release|local>  Check set (default: release)
    --tag <${TAG_PREFIX}X.Y.Z>          Assert the tag matches the root version
    --build-info <path>      Assert a built bundle matches the root version
    --base-url <url>         Also run scripts/verify-deploy.mjs

Docs: docs/project/versioning.md
`);
}

async function main(): Promise<number> {
  const [command, ...argv] = process.argv.slice(2);

  if (!command || command === "-h" || command === "--help") {
    usage();
    return command ? 0 : 2;
  }

  switch (command) {
    case "status":
      return await commandStatus(argv);
    case "bump":
      return commandBump(argv);
    case "check":
      return commandCheck(argv);
    default:
      console.error(`Unknown command: ${command}\n`);
      usage();
      return 2;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(red(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
