#!/usr/bin/env node

import { readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const APP_ID_PATTERN = /^cli_[0-9a-fA-F]{16}$/;
const SECRET_REF_PATTERN =
  /^(store:[a-z0-9][a-z0-9_-]{0,63}|env:[A-Za-z_][A-Za-z0-9_]*)$/;
const OWNER_ONLY_MODE = 0o600;

export async function runFeishuMigrationPreflight(options) {
  const dataDir = resolve(options.dataDir);
  const channelDir = join(dataDir, "channels", "feishu");
  const checks = [];
  const add = (id, severity, message, extra = {}) => {
    checks.push({ id, severity, message, ...extra });
  };

  const accountsFile = await readJsonFile(
    join(channelDir, "accounts.json"),
    "accounts",
    true,
    add,
  );
  const bindingsFile = await readJsonFile(
    join(channelDir, "bindings.json"),
    "bindings",
    false,
    add,
  );
  const secretsFile = await readJsonFile(
    join(channelDir, "secrets.json"),
    "secrets",
    false,
    add,
  );

  await checkProtectedMode(join(channelDir, "accounts.json"), "accounts", add);
  await checkProtectedMode(join(channelDir, "bindings.json"), "bindings", add);
  await checkProtectedMode(join(channelDir, "secrets.json"), "secrets", add);

  const accounts = validateAccountsFile(accountsFile, add);
  const bindings = validateBindingsFile(bindingsFile, add);
  const storedSecrets = validateSecretsFile(secretsFile, add);
  const selectedAccounts = new Map();
  const workspacePolicies = new Map();

  for (const accountId of duplicates(accounts.map((account) => account?.id))) {
    add(
      "account_id_duplicate",
      "fail",
      "账号 ID 重复，无法确定唯一消费者配置。",
      {
        accountFingerprint: fingerprint(accountId),
      },
    );
  }
  for (const appId of duplicates(accounts.map((account) => account?.appId))) {
    add(
      "app_id_duplicate",
      "fail",
      "多个账号配置指向同一 appId，存在重复消费风险。",
      {
        appIdFingerprint: fingerprint(appId),
      },
    );
  }

  for (const accountId of options.accountIds) {
    const account = accounts.find((candidate) => candidate?.id === accountId);
    const accountFingerprint = fingerprint(accountId);
    if (!account) {
      add("account_missing", "fail", "目标账号不存在。", {
        accountFingerprint,
      });
      continue;
    }
    selectedAccounts.set(accountId, account);
    validateSelectedAccount(account, add);
    workspacePolicies.set(
      accountId,
      await validateWorkspacePolicy(account, add),
    );

    const secret = resolveSecret(account.secretRef, storedSecrets, options.env);
    if (!secret) {
      add(
        "credential_missing",
        "fail",
        "目标账号的 App Secret 未配置或为空。",
        {
          accountFingerprint,
          secretSource: secretSource(account.secretRef),
        },
      );
    } else if (options.probeCredentials) {
      const probe = await probeFeishuCredential(
        account,
        secret,
        options.timeoutMs,
      );
      add(
        probe.ok ? "credential_probe_ok" : "credential_probe_failed",
        probe.ok ? "pass" : "fail",
        probe.ok
          ? "凭据只读探测成功，bot identity 可读取。"
          : "凭据只读探测失败；未启动或修改任何消费者。",
        {
          accountFingerprint,
          domain: account.domain === "lark" ? "lark" : "feishu",
        },
      );
    } else {
      add(
        "credential_validity_unverified",
        "warn",
        "仅确认凭据存在；如获授权，可用 --probe-credentials 做只读有效性探测。",
        { accountFingerprint, secretSource: secretSource(account.secretRef) },
      );
    }
  }

  await validateBindings(bindings, selectedAccounts, workspacePolicies, add);
  validateLegacyReferences(accounts, bindings, options.legacyLabel, add);
  await validateDurableState(channelDir, add);

  add(
    "consumer_exclusivity_requires_cutover_evidence",
    "warn",
    "离线文件不能证明 long connection 单消费者；canary 前必须记录旧消费者已停收且 Yep 是唯一 owner。",
  );

  const summary = checks.reduce(
    (value, check) => {
      value[check.severity] += 1;
      return value;
    },
    { pass: 0, warn: 0, fail: 0 },
  );

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    mode: options.probeCredentials ? "online-read-only" : "offline-read-only",
    dataDirectory: {
      name: basename(dataDir),
      fingerprint: fingerprint(dataDir),
    },
    targetAccounts: options.accountIds.map(fingerprint),
    legacyLabelConfigured: Boolean(options.legacyLabel.trim()),
    summary,
    readyForCanary: summary.fail === 0,
    checks,
  };
}

function validateAccountsFile(value, add) {
  if (!value) return [];
  if (value.version !== 1 || !Array.isArray(value.accounts)) {
    add(
      "accounts_schema_invalid",
      "fail",
      "accounts.json 不是受支持的 version 1 结构。",
    );
    return [];
  }
  add("accounts_schema_ok", "pass", "accounts.json 结构可读取。", {
    count: value.accounts.length,
  });
  return value.accounts;
}

function validateBindingsFile(value, add) {
  if (!value) {
    add(
      "bindings_absent",
      "warn",
      "bindings.json 尚不存在；首次 canary 前应确认预期为空。",
    );
    return [];
  }
  if (value.version !== 1 || !Array.isArray(value.bindings)) {
    add(
      "bindings_schema_invalid",
      "fail",
      "bindings.json 不是受支持的 version 1 结构。",
    );
    return [];
  }
  add("bindings_schema_ok", "pass", "bindings.json 结构可读取。", {
    count: value.bindings.length,
  });
  return value.bindings;
}

function validateSecretsFile(value, add) {
  if (!value) return {};
  if (
    value.version !== 1 ||
    !value.secrets ||
    typeof value.secrets !== "object" ||
    Array.isArray(value.secrets)
  ) {
    add(
      "secrets_schema_invalid",
      "fail",
      "secrets.json 不是受支持的 version 1 结构。",
    );
    return {};
  }
  const valid = Object.values(value.secrets).every(
    (secret) => typeof secret === "string" && secret.trim().length > 0,
  );
  add(
    valid ? "secrets_schema_ok" : "secrets_schema_invalid",
    valid ? "pass" : "fail",
    valid
      ? "secrets.json 结构可读取且没有空值。"
      : "secrets.json 含空值或非法值。",
    { count: Object.keys(value.secrets).length },
  );
  return valid ? value.secrets : {};
}

function validateSelectedAccount(account, add) {
  const accountId = safeString(account.id);
  const accountFingerprint = fingerprint(accountId);
  const fieldsValid =
    ACCOUNT_ID_PATTERN.test(accountId) &&
    typeof account.name === "string" &&
    account.name.trim().length > 0 &&
    APP_ID_PATTERN.test(safeString(account.appId)) &&
    SECRET_REF_PATTERN.test(safeString(account.secretRef));
  add(
    fieldsValid ? "account_shape_ok" : "account_shape_invalid",
    fieldsValid ? "pass" : "fail",
    fieldsValid ? "账号关键字段有效。" : "账号关键字段缺失或格式非法。",
    { accountFingerprint },
  );
  add(
    account.enabled === true ? "account_enabled" : "account_disabled",
    account.enabled === true ? "pass" : "fail",
    account.enabled === true ? "账号已启用。" : "账号未启用。",
    { accountFingerprint },
  );
  const provider = account.defaultProvider ?? "codex";
  add(
    provider === "codex" ? "provider_codex" : "provider_not_codex",
    provider === "codex" ? "pass" : "fail",
    provider === "codex"
      ? "默认 provider 为 codex。"
      : "默认 provider 不是 codex。",
    { accountFingerprint },
  );
  const hasActorPolicy =
    (Array.isArray(account.allowedUsers) && account.allowedUsers.length > 0) ||
    (Array.isArray(account.adminUsers) && account.adminUsers.length > 0);
  add(
    hasActorPolicy ? "actor_policy_configured" : "actor_policy_open",
    hasActorPolicy ? "pass" : "warn",
    hasActorPolicy
      ? "账号已配置 actor allowlist。"
      : "actor allowlist 为空；请确认这符合 canary 的访问边界。",
    { accountFingerprint },
  );
}

async function validateWorkspacePolicy(account, add) {
  const accountFingerprint = fingerprint(safeString(account.id));
  const roots = [];
  if (
    !Array.isArray(account.allowedWorkspaceRoots) ||
    account.allowedWorkspaceRoots.length === 0
  ) {
    add(
      "workspace_roots_missing",
      "fail",
      "未配置 allowedWorkspaceRoots，消息无法安全 dispatch。",
      { accountFingerprint },
    );
    return { roots };
  }

  for (const configuredRoot of account.allowedWorkspaceRoots) {
    if (typeof configuredRoot !== "string" || !isAbsolute(configuredRoot)) {
      add(
        "workspace_root_invalid",
        "fail",
        "Workspace root 必须是存在的绝对路径。",
        {
          accountFingerprint,
        },
      );
      continue;
    }
    try {
      const canonical = await realpath(configuredRoot);
      const metadata = await stat(canonical);
      if (!metadata.isDirectory()) throw new Error("not-directory");
      roots.push(canonical);
      add("workspace_root_ok", "pass", "Workspace root 可访问。", {
        accountFingerprint,
        root: basename(canonical),
      });
    } catch {
      add(
        "workspace_root_unavailable",
        "fail",
        "Workspace root 不存在或不可访问。",
        { accountFingerprint, root: basename(configuredRoot) },
      );
    }
  }

  if (!account.defaultProjectPath) {
    add(
      "default_project_missing",
      "warn",
      "未配置 defaultProjectPath；首次消息需已有 binding。",
      { accountFingerprint },
    );
    return { roots };
  }
  try {
    const project = await realpath(account.defaultProjectPath);
    const metadata = await stat(project);
    if (!metadata.isDirectory()) throw new Error("not-directory");
    const allowed = roots.some((root) => isPathWithin(root, project));
    add(
      allowed ? "default_project_ok" : "default_project_outside_roots",
      allowed ? "pass" : "fail",
      allowed
        ? "默认项目存在且位于允许的 Workspace root 内。"
        : "默认项目不在 allowedWorkspaceRoots 内。",
      { accountFingerprint, project: basename(project) },
    );
  } catch {
    add("default_project_unavailable", "fail", "默认项目不存在或不可访问。", {
      accountFingerprint,
      project: basename(safeString(account.defaultProjectPath)),
    });
  }
  return { roots };
}

async function validateBindings(bindings, accounts, workspacePolicies, add) {
  const seen = new Set();
  for (const binding of bindings) {
    const scopeKey = safeString(binding?.scopeKey);
    if (seen.has(scopeKey)) {
      add("binding_scope_duplicate", "fail", "binding scopeKey 重复。", {
        scopeFingerprint: fingerprint(scopeKey),
      });
    }
    seen.add(scopeKey);
    const account = accounts.get(binding?.accountId);
    if (!account) continue;
    const accountId = account.id;
    const accountFingerprint = fingerprint(accountId);
    const valid =
      binding?.version === 1 &&
      binding?.provider === "codex" &&
      typeof binding?.sessionId === "string" &&
      binding.sessionId.length > 0 &&
      typeof binding?.projectPath === "string" &&
      isAbsolute(binding.projectPath) &&
      scopeKey.startsWith(`${accountId}:`);
    add(
      valid ? "binding_shape_ok" : "binding_shape_invalid",
      valid ? "pass" : "fail",
      valid
        ? "目标账号 binding 的 owner/provider/路径形状有效。"
        : "目标账号 binding 结构或 owner 不一致。",
      { accountFingerprint, scopeFingerprint: fingerprint(scopeKey) },
    );
    if (!valid) continue;

    let canonicalProject;
    try {
      canonicalProject = await realpath(binding.projectPath);
      const metadata = await stat(canonicalProject);
      if (!metadata.isDirectory()) throw new Error("not-directory");
    } catch {
      add(
        "binding_project_unavailable",
        "fail",
        "binding 项目路径不存在或不可访问。",
        {
          accountFingerprint,
          project: basename(binding.projectPath),
        },
      );
      continue;
    }
    const roots = workspacePolicies.get(accountId)?.roots ?? [];
    const insideRoot = roots.some((root) =>
      isPathWithin(root, canonicalProject),
    );
    if (!insideRoot) {
      add(
        "binding_project_outside_roots",
        "fail",
        "binding 项目路径不在账号允许的 Workspace roots 内。",
        { accountFingerprint, project: basename(canonicalProject) },
      );
    } else {
      add(
        "binding_project_ok",
        "pass",
        "binding 项目位于允许的 Workspace root 内。",
        {
          accountFingerprint,
          project: basename(canonicalProject),
        },
      );
    }
  }

  if (bindings.length === 0) {
    add(
      "bindings_empty",
      "pass",
      "当前没有历史 binding；canary 将创建新 binding。",
      {
        targetAccounts: accounts.size,
      },
    );
  }
}

function validateLegacyReferences(accounts, bindings, legacyLabel, add) {
  const needle = legacyLabel.trim().toLocaleLowerCase("en-US");
  if (!needle) {
    add(
      "legacy_marker_not_checked",
      "warn",
      "未提供旧消费者标记；离线预检无法检查残留 routing 标签。",
    );
    return;
  }
  const accountHits = accounts.filter((account) =>
    [account?.id, account?.name].some((value) =>
      safeString(value).toLocaleLowerCase("en-US").includes(needle),
    ),
  );
  const bindingHits = bindings.filter((binding) =>
    Object.values(binding ?? {}).some(
      (value) =>
        typeof value === "string" &&
        value.toLocaleLowerCase("en-US").includes(needle),
    ),
  );
  const hitCount = accountHits.length + bindingHits.length;
  add(
    hitCount === 0 ? "legacy_routing_clear" : "legacy_routing_present",
    hitCount === 0 ? "pass" : "fail",
    hitCount === 0
      ? "accounts/bindings 未发现旧消费者标记。"
      : "accounts/bindings 仍包含旧消费者标记。",
    { matches: hitCount },
  );
}

async function validateDurableState(channelDir, add) {
  const durableFiles = [
    "inbox.jsonl",
    "outbox.json",
    "operation-projections.json",
    "message-mutations.json",
  ];
  for (const file of durableFiles) {
    const path = join(channelDir, file);
    try {
      const metadata = await stat(path);
      add("durable_store_present", "pass", "Durable store 已存在。", {
        store: file,
        bytes: metadata.size,
      });
      await checkProtectedMode(path, `durable:${file}`, add);
    } catch (error) {
      if (error?.code === "ENOENT") {
        add(
          "durable_store_not_materialized",
          "warn",
          "Durable store 尚未物化；首次写入前确认恢复策略。",
          { store: file },
        );
      } else {
        add("durable_store_unreadable", "fail", "Durable store 不可读取。", {
          store: file,
        });
      }
    }
  }

  try {
    const obsolete = await stat(join(channelDir, "operations.json"));
    add(
      "legacy_operation_authority_present",
      "fail",
      "发现旧 operations.json；在 canary 前必须人工归档，不能与 broker projection 并存。",
      { bytes: obsolete.size },
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      add(
        "legacy_operation_authority_absent",
        "pass",
        "未发现旧 operations.json decision authority。",
      );
    } else {
      add(
        "legacy_operation_authority_unreadable",
        "fail",
        "无法确认旧 operations.json 是否存在。",
      );
    }
  }
}

async function readJsonFile(path, label, required, add) {
  try {
    const content = await readFile(path, "utf8");
    return JSON.parse(content);
  } catch (error) {
    if (error?.code === "ENOENT") {
      add(
        `${label}_file_missing`,
        required ? "fail" : "warn",
        `${label}.json 不存在。`,
      );
      return undefined;
    }
    add(`${label}_file_invalid`, "fail", `${label}.json 无法解析或读取。`);
    return undefined;
  }
}

async function checkProtectedMode(path, label, add) {
  if (process.platform === "win32") return;
  try {
    const mode = (await stat(path)).mode & 0o777;
    const protectedMode = mode === OWNER_ONLY_MODE;
    const strict = label === "secrets" || label.startsWith("durable:");
    add(
      protectedMode ? `${label}_mode_ok` : `${label}_mode_too_open`,
      protectedMode ? "pass" : strict ? "fail" : "warn",
      protectedMode ? `${label} 权限为 0600。` : `${label} 权限不是 0600。`,
      { mode: mode.toString(8).padStart(3, "0") },
    );
  } catch (error) {
    if (error?.code !== "ENOENT") {
      add(`${label}_mode_unreadable`, "fail", `无法检查 ${label} 权限。`);
    }
  }
}

function resolveSecret(secretRef, storedSecrets, env) {
  if (typeof secretRef !== "string") return undefined;
  const [source, key] = secretRef.split(":", 2);
  const value =
    source === "store"
      ? storedSecrets[key]
      : source === "env"
        ? env[key]
        : undefined;
  return typeof value === "string" && value.trim() ? value : undefined;
}

async function probeFeishuCredential(account, secret, timeoutMs) {
  const baseUrl =
    account.domain === "lark"
      ? "https://open.larksuite.com"
      : "https://open.feishu.cn";
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const tokenResponse = await fetch(
      `${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ app_id: account.appId, app_secret: secret }),
        signal,
      },
    );
    if (!tokenResponse.ok) return { ok: false };
    const tokenPayload = await tokenResponse.json();
    if (
      tokenPayload?.code !== 0 ||
      typeof tokenPayload?.tenant_access_token !== "string"
    ) {
      return { ok: false };
    }
    const botResponse = await fetch(`${baseUrl}/open-apis/bot/v3/info`, {
      headers: { authorization: `Bearer ${tokenPayload.tenant_access_token}` },
      signal,
    });
    if (!botResponse.ok) return { ok: false };
    const botPayload = await botResponse.json();
    return {
      ok:
        botPayload?.code === 0 && typeof botPayload?.bot?.open_id === "string",
    };
  } catch {
    return { ok: false };
  }
}

function isPathWithin(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
  );
}

function duplicates(values) {
  const seen = new Set();
  const duplicate = new Set();
  for (const value of values) {
    if (typeof value !== "string" || !value) continue;
    if (seen.has(value)) duplicate.add(value);
    seen.add(value);
  }
  return [...duplicate];
}

function fingerprint(value) {
  if (typeof value !== "string" || !value) return "missing";
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function safeString(value) {
  return typeof value === "string" ? value : "";
}

function secretSource(secretRef) {
  return typeof secretRef === "string" && secretRef.startsWith("env:")
    ? "env"
    : "store";
}

export function parseFeishuMigrationArgs(argv, env = process.env) {
  const options = {
    dataDir: env.YEP_ANYWHERE_DATA_DIR,
    accountIds: [],
    legacyLabel: "",
    probeCredentials: false,
    timeoutMs: 10_000,
    json: false,
    strict: false,
    env,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--data-dir")
      options.dataDir = requiredValue(argv, ++index, argument);
    else if (argument === "--accounts") {
      options.accountIds = requiredValue(argv, ++index, argument)
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    } else if (argument === "--legacy-label") {
      options.legacyLabel = requiredValue(argv, ++index, argument);
    } else if (argument === "--timeout-ms") {
      options.timeoutMs = Number.parseInt(
        requiredValue(argv, ++index, argument),
        10,
      );
    } else if (argument === "--probe-credentials")
      options.probeCredentials = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--strict") options.strict = true;
    else if (argument === "--help" || argument === "-h") return { help: true };
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.dataDir) {
    throw new Error("--data-dir or YEP_ANYWHERE_DATA_DIR is required");
  }
  if (options.accountIds.length === 0) {
    throw new Error("--accounts must list at least one explicit account ID");
  }
  if (duplicates(options.accountIds).length > 0) {
    throw new Error("--accounts must not contain duplicates");
  }
  if (
    !Number.isFinite(options.timeoutMs) ||
    options.timeoutMs < 1_000 ||
    options.timeoutMs > 60_000
  ) {
    throw new Error("--timeout-ms must be between 1000 and 60000");
  }
  return options;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function usage() {
  return `Usage: node scripts/feishu-migration-preflight.mjs --data-dir PATH --accounts ID[,ID] [options]

Read-only checks for a Feishu/Lark consumer migration. No service is started,
stopped, connected, disconnected, or reconfigured.

Options:
  --accounts ID[,ID]        Explicit target account IDs (required)
  --legacy-label LABEL      Optional legacy consumer marker to reject
  --probe-credentials       Perform explicit read-only credential/bot-info probes
  --timeout-ms N            Network probe timeout, 1000-60000 (default: 10000)
  --strict                  Treat warnings as a non-zero result
  --json                    Emit machine-readable JSON only
  -h, --help                Show this help
`;
}

function renderHuman(report) {
  const lines = [
    "Feishu migration preflight (read-only)",
    `mode: ${report.mode}`,
    `data: ${report.dataDirectory.name} (${report.dataDirectory.fingerprint})`,
    `targets: ${report.targetAccounts.join(", ")}`,
    `summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail`,
    "",
  ];
  for (const check of report.checks) {
    const scope = check.accountFingerprint
      ? ` [${check.accountFingerprint}]`
      : "";
    lines.push(
      `${check.severity.toUpperCase().padEnd(4)} ${check.id}${scope}: ${check.message}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  let options;
  try {
    options = parseFeishuMigrationArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const report = await runFeishuMigrationPreflight(options);
  process.stdout.write(
    options.json ? `${JSON.stringify(report, null, 2)}\n` : renderHuman(report),
  );
  if (report.summary.fail > 0 || (options.strict && report.summary.warn > 0)) {
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
