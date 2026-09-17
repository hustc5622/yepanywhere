#!/usr/bin/env tsx
/**
 * 查询任意 Codex 账号的用量额度（只读）。
 *
 * 账号身份完全由 $CODEX_HOME/auth.json 决定，因此只要为第二个账号准备一个
 * 独立的 CODEX_HOME 目录，就能在不切换本机登录状态的前提下读取它的额度。
 *
 * 用法：
 *   npx tsx scripts/codex-usage.ts                          # 默认 ~/.codex
 *   npx tsx scripts/codex-usage.ts ~/.codex-alt             # 指定 CODEX_HOME
 *   npx tsx scripts/codex-usage.ts ~/.codex ~/.codex-alt    # 多账号对比
 *   npx tsx scripts/codex-usage.ts --json ~/.codex-alt
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const INIT_ID = 1;
const LIMITS_ID = 2;
const TIMEOUT_MS = 20_000;

interface Rpc {
  id?: number | string;
  result?: unknown;
  error?: { message?: string };
}

function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : resolve(p);
}

function readAccountLabel(codexHome: string): string {
  try {
    const auth = JSON.parse(
      readFileSync(join(codexHome, "auth.json"), "utf-8"),
    ) as {
      auth_mode?: string;
      tokens?: { id_token?: string; account_id?: string };
    };
    const idToken = auth.tokens?.id_token;
    if (idToken) {
      const payload = JSON.parse(
        Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf-8"),
      ) as { email?: string; preferred_username?: string };
      const email = payload.email ?? payload.preferred_username;
      if (email) return email;
    }
    const accountId = auth.tokens?.account_id;
    if (accountId) return `account_id=${accountId}`;
    return auth.auth_mode ?? "unknown";
  } catch {
    return "unknown (auth.json unreadable)";
  }
}

function queryUsage(codexHome: string): Promise<unknown> {
  return new Promise((res, rej) => {
    const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CODEX_HOME: codexHome },
    });
    let settled = false;
    let buf = "";
    const err: string[] = [];
    const timer = setTimeout(
      () => finish(() => rej(new Error("timeout"))),
      TIMEOUT_MS,
    );
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      fn();
    };
    const send = (m: unknown) => child.stdin?.write(`${JSON.stringify(m)}\n`);

    child.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        let msg: Rpc;
        try {
          msg = JSON.parse(line) as Rpc;
        } catch {
          continue;
        }
        if (msg.id === INIT_ID) {
          if (msg.error) {
            finish(() => rej(new Error(msg.error?.message ?? "init failed")));
            return;
          }
          send({ jsonrpc: "2.0", method: "initialized" });
          send({
            jsonrpc: "2.0",
            id: LIMITS_ID,
            method: "account/rateLimits/read",
            params: null,
          });
        } else if (msg.id === LIMITS_ID) {
          if (msg.error) {
            finish(() =>
              rej(new Error(msg.error?.message ?? "rateLimits/read failed")),
            );
            return;
          }
          finish(() => res(msg.result));
        }
      }
    });
    child.stderr?.on("data", (c: Buffer) => err.push(c.toString("utf-8")));
    child.on("error", (e) => finish(() => rej(e)));
    child.on("exit", (code) =>
      finish(() =>
        rej(new Error(`app-server exited (${code}) ${err.join("").trim()}`)),
      ),
    );

    send({
      jsonrpc: "2.0",
      id: INIT_ID,
      method: "initialize",
      params: {
        clientInfo: { name: "yep-anywhere-usage-cli", version: "dev" },
        capabilities: null,
      },
    });
  });
}

function fmtWindow(label: string, w: unknown): string | null {
  if (!w || typeof w !== "object") return null;
  const win = w as {
    used_percent?: number;
    usedPercent?: number;
    window_duration_mins?: number;
    windowDurationMins?: number;
    resets_at?: number;
    resetsAt?: number;
  };
  const used = win.used_percent ?? win.usedPercent;
  if (typeof used !== "number") return null;
  const mins = win.window_duration_mins ?? win.windowDurationMins;
  const resets = win.resets_at ?? win.resetsAt;
  const span =
    typeof mins === "number"
      ? mins >= 1440
        ? `${Math.round(mins / 1440)}d`
        : `${Math.round(mins / 60)}h`
      : "?";
  const resetAt =
    typeof resets === "number"
      ? new Date(resets * 1000).toLocaleString()
      : "unknown";
  return `  ${label} (${span}): used ${used.toFixed(1)}% · resets ${resetAt}`;
}

async function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const homes = argv.filter((a) => !a.startsWith("--"));
  const targets = (homes.length ? homes : ["~/.codex"]).map(expandHome);

  for (const codexHome of targets) {
    const label = readAccountLabel(codexHome);
    try {
      const result = await queryUsage(codexHome);
      if (asJson) {
        console.log(
          JSON.stringify({ codexHome, account: label, result }, null, 2),
        );
        continue;
      }
      console.log(`\n${codexHome}  [${label}]`);
      const r = result as Record<string, unknown>;
      const byLimit = (r.rateLimitsByLimitId ?? r.rate_limits_by_limit_id) as
        | Record<string, Record<string, unknown>>
        | undefined;
      const buckets = byLimit
        ? Object.entries(byLimit)
        : ([["codex", (r.rateLimits ?? r.rate_limits) as never]] as [
            string,
            Record<string, unknown>,
          ][]);
      for (const [id, bucket] of buckets) {
        if (!bucket) continue;
        console.log(` ${id}:`);
        for (const line of [
          fmtWindow("primary", bucket.primary),
          fmtWindow("secondary", bucket.secondary),
        ]) {
          if (line) console.log(line);
        }
      }
      const credits = (r.rateLimitResetCredits ?? r.rate_limit_reset_credits) as
        | { availableCount?: number }
        | undefined;
      if (credits?.availableCount !== undefined) {
        console.log(` reset credits: ${credits.availableCount}`);
      }
    } catch (error) {
      console.log(`\n${codexHome}  [${label}]`);
      console.log(` error: ${(error as Error).message}`);
    }
  }
}

void main();
