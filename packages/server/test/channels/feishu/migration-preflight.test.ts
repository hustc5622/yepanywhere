import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../..",
);
const PREFLIGHT_SCRIPT = join(
  REPOSITORY_ROOT,
  "scripts",
  "feishu-migration-preflight.mjs",
);
const TARGET_ACCOUNTS = "account-alpha,account-beta";

describe("Feishu migration preflight", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("accepts a safe offline configuration without exposing identities or secrets", async () => {
    const fixture = await createFixture(temporaryDirectories);
    const result = runPreflight(fixture.dataDir);

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as {
      mode: string;
      readyForCanary: boolean;
      summary: { fail: number; warn: number };
      checks: Array<{ id: string }>;
    };
    expect(report).toMatchObject({
      mode: "offline-read-only",
      readyForCanary: true,
      summary: { fail: 0 },
    });
    expect(report.summary.warn).toBeGreaterThan(0);
    expect(report.checks.map((check) => check.id)).toContain(
      "consumer_exclusivity_requires_cutover_evidence",
    );
    for (const sensitive of [
      "alpha-fixture-secret",
      "beta-fixture-secret",
      "account-alpha",
      "account-beta",
      fixture.dataDir,
    ]) {
      expect(result.stdout).not.toContain(sensitive);
    }
  });

  it("fails closed for disabled accounts, missing credentials, and legacy routing", async () => {
    const fixture = await createFixture(temporaryDirectories, {
      alphaEnabled: false,
      omitBetaSecret: true,
      legacyBinding: true,
    });
    const result = runPreflight(fixture.dataDir);

    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout) as {
      readyForCanary: boolean;
      checks: Array<{ id: string }>;
    };
    expect(report.readyForCanary).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "account_disabled" }),
        expect.objectContaining({ id: "credential_missing" }),
        expect.objectContaining({ id: "legacy_routing_present" }),
      ]),
    );
  });

  it("awaits every current durable store check and includes it in the summary", async () => {
    const fixture = await createFixture(temporaryDirectories);
    const channelDir = join(fixture.dataDir, "channels", "feishu");
    await writeProtectedText(join(channelDir, "inbox.jsonl"), "");
    await writeProtectedJson(join(channelDir, "outbox.json"), {});
    await writeProtectedJson(join(channelDir, "operation-projections.json"), {
      version: 1,
      records: [],
    });
    await writeProtectedJson(join(channelDir, "message-mutations.json"), {
      version: 1,
      events: [],
    });

    const result = runPreflight(fixture.dataDir);

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as {
      summary: { pass: number; warn: number; fail: number };
      checks: Array<{
        id: string;
        severity: "pass" | "warn" | "fail";
        store?: string;
      }>;
    };
    expect(
      report.checks
        .filter((check) => check.id === "durable_store_present")
        .map((check) => check.store),
    ).toEqual([
      "inbox.jsonl",
      "outbox.json",
      "operation-projections.json",
      "message-mutations.json",
    ]);
    expect(report.summary).toEqual({
      pass: report.checks.filter((check) => check.severity === "pass").length,
      warn: report.checks.filter((check) => check.severity === "warn").length,
      fail: report.checks.filter((check) => check.severity === "fail").length,
    });
  });

  it("rejects an obsolete local decision authority", async () => {
    const fixture = await createFixture(temporaryDirectories);
    await writeProtectedJson(
      join(fixture.dataDir, "channels", "feishu", "operations.json"),
      { version: 1, operations: [] },
    );

    const result = runPreflight(fixture.dataDir);

    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout) as {
      checks: Array<{ id: string; severity: string }>;
    };
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: "legacy_operation_authority_present",
        severity: "fail",
      }),
    );
  });

  it("requires explicit data and account targets and never guesses a live profile", () => {
    const noData = spawnSync(
      process.execPath,
      [PREFLIGHT_SCRIPT, "--accounts", TARGET_ACCOUNTS, "--json"],
      {
        cwd: REPOSITORY_ROOT,
        env: { PATH: process.env.PATH },
        encoding: "utf8",
      },
    );
    expect(noData.status).toBe(2);
    expect(noData.stderr).toContain(
      "--data-dir or YEP_ANYWHERE_DATA_DIR is required",
    );

    const noAccounts = spawnSync(
      process.execPath,
      [PREFLIGHT_SCRIPT, "--data-dir", "/opt/yep-fixtures/profile", "--json"],
      {
        cwd: REPOSITORY_ROOT,
        env: { PATH: process.env.PATH },
        encoding: "utf8",
      },
    );
    expect(noAccounts.status).toBe(2);
    expect(noAccounts.stderr).toContain(
      "--accounts must list at least one explicit account ID",
    );
  });
});

function runPreflight(dataDir: string) {
  return spawnSync(
    process.execPath,
    [
      PREFLIGHT_SCRIPT,
      "--data-dir",
      dataDir,
      "--accounts",
      TARGET_ACCOUNTS,
      "--legacy-label",
      "legacy-consumer",
      "--json",
    ],
    {
      cwd: REPOSITORY_ROOT,
      env: { PATH: process.env.PATH },
      encoding: "utf8",
    },
  );
}

async function createFixture(
  temporaryDirectories: string[],
  options: {
    alphaEnabled?: boolean;
    omitBetaSecret?: boolean;
    legacyBinding?: boolean;
  } = {},
): Promise<{ dataDir: string }> {
  const dataDir = await mkdtemp(join(tmpdir(), "yep-feishu-preflight-"));
  temporaryDirectories.push(dataDir);
  const channelDir = join(dataDir, "channels", "feishu");
  const workspaceRoot = join(dataDir, "workspace");
  const project = join(workspaceRoot, "project");
  await mkdir(project, { recursive: true });
  await mkdir(channelDir, { recursive: true });

  const account = (id: "account-alpha" | "account-beta", appId: string) => ({
    id,
    name: id,
    enabled: id === "account-alpha" ? (options.alphaEnabled ?? true) : true,
    domain: "feishu",
    appId,
    secretRef: `store:${id}`,
    defaultProjectPath: project,
    allowedWorkspaceRoots: [workspaceRoot],
    allowedUsers: [`user-${id}`],
    adminUsers: [],
    allowedChats: [],
    requireMentionInGroup: true,
    groupSessionMode: "thread-when-available",
    defaultProvider: "codex",
    defaultCodexMcpMode: "standard",
    defaultPermissionMode: "default",
    replyMode: "card",
  });

  const binding = {
    version: 1,
    scopeKey: options.legacyBinding
      ? "account-alpha:legacy-consumer:fixture"
      : "account-alpha:p2p:fixture",
    accountId: "account-alpha",
    chatId: "chat-fixture",
    projectId: "project-fixture",
    projectPath: project,
    sessionId: "session-fixture",
    provider: "codex",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
  };

  await writeProtectedJson(join(channelDir, "accounts.json"), {
    version: 1,
    accounts: [
      account("account-alpha", "cli_0123456789abcdef"),
      account("account-beta", "cli_fedcba9876543210"),
    ],
  });
  await writeProtectedJson(join(channelDir, "bindings.json"), {
    version: 1,
    bindings: [binding],
  });
  await writeProtectedJson(join(channelDir, "secrets.json"), {
    version: 1,
    secrets: {
      "account-alpha": "alpha-fixture-secret",
      ...(options.omitBetaSecret
        ? {}
        : { "account-beta": "beta-fixture-secret" }),
    },
  });
  return { dataDir };
}

async function writeProtectedJson(path: string, value: unknown): Promise<void> {
  await writeProtectedText(path, `${JSON.stringify(value)}\n`);
}

async function writeProtectedText(path: string, value: string): Promise<void> {
  await writeFile(path, value, "utf8");
  if (process.platform !== "win32") await chmod(path, 0o600);
}
