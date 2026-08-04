import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface PromoteStagedDirectoryOptions {
  /** Fully assembled directory that should become the published directory. */
  stagedDir: string;
  /** Stable path consumed by the running service and publish tooling. */
  publishedDir: string;
  /** Non-fatal cleanup warnings after a successful cutover. */
  onWarning?: (message: string) => void;
}

export type RenameDirectory = (source: string, destination: string) => void;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPathWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function resolvePhysicalPath(candidate: string): string {
  const missingSegments: string[] = [];
  let existingAncestor = candidate;

  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    missingSegments.unshift(path.basename(existingAncestor));
    existingAncestor = parent;
  }

  const physicalAncestor = fs.realpathSync(existingAncestor);
  return path.resolve(physicalAncestor, ...missingSegments);
}

function isRecognizedBundleDirectory(directory: string): boolean {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(directory, "package.json"), "utf8"),
    ) as { name?: unknown };
    return (
      packageJson.name === "yepanywhere" &&
      fs.statSync(path.join(directory, "build-info.json")).isFile() &&
      fs.statSync(path.join(directory, "dist/cli.js")).isFile() &&
      fs.statSync(path.join(directory, "client-dist/index.html")).isFile()
    );
  } catch {
    return false;
  }
}

function assertPathUsesBundleArea(
  repoRoot: string,
  distRoot: string,
  outputDir: string,
): void {
  if (!isPathWithin(repoRoot, outputDir)) return;
  if (outputDir !== distRoot && isPathWithin(distRoot, outputDir)) return;
  throw new Error(
    `Unsafe bundle output directory inside the repository: ${outputDir}`,
  );
}

/**
 * Resolve an optional bundle output without allowing a build to replace source
 * directories or an unrelated pre-existing external directory.
 */
export function resolveBundleOutputDirectory(
  repoRoot: string,
  configuredOutput?: string,
): string {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const resolvedDistRoot = path.join(resolvedRepoRoot, "dist");
  const configured = configuredOutput?.trim();
  const resolvedOutput = configured
    ? path.resolve(resolvedRepoRoot, configured)
    : path.join(resolvedDistRoot, "npm-package");

  if (resolvedOutput === path.parse(resolvedOutput).root) {
    throw new Error(`Unsafe bundle output directory: ${resolvedOutput}`);
  }

  assertPathUsesBundleArea(resolvedRepoRoot, resolvedDistRoot, resolvedOutput);

  // Resolve symlinked ancestors as well, so a path that looks like dist/foo
  // cannot actually point back into packages/foo and replace tracked source.
  const physicalRepoRoot = resolvePhysicalPath(resolvedRepoRoot);
  const physicalDistRoot = resolvePhysicalPath(resolvedDistRoot);
  const physicalOutput = resolvePhysicalPath(resolvedOutput);
  assertPathUsesBundleArea(physicalRepoRoot, physicalDistRoot, physicalOutput);

  if (!fs.existsSync(resolvedOutput)) return resolvedOutput;

  const outputStats = fs.lstatSync(resolvedOutput);
  if (outputStats.isSymbolicLink() || !outputStats.isDirectory()) {
    throw new Error(
      `Bundle output must be a regular directory: ${resolvedOutput}`,
    );
  }

  const isGeneratedDistChild =
    resolvedOutput !== resolvedDistRoot &&
    isPathWithin(resolvedDistRoot, resolvedOutput) &&
    physicalOutput !== physicalDistRoot &&
    isPathWithin(physicalDistRoot, physicalOutput);
  if (!isGeneratedDistChild && !isRecognizedBundleDirectory(resolvedOutput)) {
    throw new Error(
      `Refusing to replace an unrecognized existing bundle output directory: ${resolvedOutput}`,
    );
  }

  return resolvedOutput;
}

/**
 * Promote a fully built sibling directory while preserving the previous
 * published directory for rollback.
 *
 * Keeping both directories under the same parent is intentional: filesystem
 * rename is then metadata-only and cannot degrade into a long copy operation.
 * The optional rename implementation exists so rollback can be tested without
 * relying on filesystem races.
 */
export function promoteStagedDirectory(
  options: PromoteStagedDirectoryOptions,
  renameDirectory: RenameDirectory = fs.renameSync,
): void {
  const stagedDir = path.resolve(options.stagedDir);
  const publishedDir = path.resolve(options.publishedDir);
  const parentDir = path.dirname(publishedDir);

  if (stagedDir === publishedDir) {
    throw new Error("Staged and published bundle directories must differ");
  }
  if (path.dirname(stagedDir) !== parentDir) {
    throw new Error(
      "Staged and published bundle directories must be siblings for a safe cutover",
    );
  }

  let stagedStats: fs.Stats;
  try {
    stagedStats = fs.statSync(stagedDir);
  } catch (error) {
    throw new Error(
      `Staged bundle is unavailable at ${stagedDir}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  if (!stagedStats.isDirectory()) {
    throw new Error(`Staged bundle is not a directory: ${stagedDir}`);
  }

  fs.mkdirSync(parentDir, { recursive: true });

  const backupDir = path.join(
    parentDir,
    `.${path.basename(publishedDir)}.previous-${process.pid}-${randomUUID()}`,
  );
  let previousBundleMoved = false;

  if (fs.existsSync(publishedDir)) {
    renameDirectory(publishedDir, backupDir);
    previousBundleMoved = true;
  }

  try {
    renameDirectory(stagedDir, publishedDir);
  } catch (promotionError) {
    let rollbackError: unknown;

    if (previousBundleMoved) {
      if (fs.existsSync(publishedDir)) {
        rollbackError = new Error(
          `Unexpected directory appeared at ${publishedDir}; backup retained at ${backupDir}`,
        );
      } else {
        try {
          renameDirectory(backupDir, publishedDir);
        } catch (error) {
          rollbackError = error;
        }
      }
    }

    if (rollbackError) {
      throw new Error(
        `Failed to publish staged bundle (${errorMessage(promotionError)}) and failed to restore the previous bundle (${errorMessage(rollbackError)})`,
        { cause: promotionError },
      );
    }

    const rollbackSuffix = previousBundleMoved
      ? "; previous bundle was restored"
      : "";
    throw new Error(
      `Failed to publish staged bundle: ${errorMessage(promotionError)}${rollbackSuffix}`,
      { cause: promotionError },
    );
  }

  if (previousBundleMoved) {
    try {
      fs.rmSync(backupDir, { recursive: true, force: true });
    } catch (error) {
      options.onWarning?.(
        `New bundle is published, but the old backup could not be removed at ${backupDir}: ${errorMessage(error)}`,
      );
    }
  }
}
