#!/usr/bin/env node
/**
 * Yep Anywhere bridge hook entry for ZCode.
 *
 * Invoked by ZCode 0.16.1 for each registered hook event (see
 * hooks/hooks.json). The event JSON arrives on stdin; the script forwards it
 * to the Yep server and, for PermissionRequest, writes the user's decision
 * back on stdout in the CLI's hook contract:
 *
 *   { "hookSpecificOutput": {
 *       "hookEventName": "PermissionRequest",
 *       "decision": { "behavior": "allow", "updatedInput": ... }
 *                 | { "behavior": "deny", "message": ... } } }
 *
 * Fail-safe contract: any error, timeout, or missing bridge config exits 0
 * WITHOUT writing stdout, so the CLI falls back to its own native TUI
 * dialog. The hook must never crash the TUI or block a tool indefinitely.
 *
 * Config: `$ZCODE_HOME/yep-bridge.json` (default ~/.zcode/yep-bridge.json)
 * written by scripts/install-zcode-yep-plugin.sh:
 *   { "serverUrl": "http://127.0.0.1:8022/yep", "token": "<shared>" }
 * Env overrides (mainly for tests): YEP_ZCODE_BRIDGE_CONFIG.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const HOOK_URL_PATH = "/api/zcode-bridge/hook";
/** Fire-and-forget events: never hold the session up for them. */
const EVENT_TIMEOUT_MS = 3_000;
/**
 * PermissionRequest: slightly above the server's internal long-poll budget
 * (25s) and well below hooks.json's timeoutMs (45s).
 */
const DECISION_TIMEOUT_MS = 30_000;

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

async function loadBridgeConfig() {
  const configFile =
    process.env.YEP_ZCODE_BRIDGE_CONFIG ??
    join(homedir(), ".zcode", "yep-bridge.json");
  try {
    const parsed = JSON.parse(await readFile(configFile, "utf-8"));
    if (
      typeof parsed.serverUrl === "string" &&
      parsed.serverUrl.length > 0 &&
      typeof parsed.token === "string" &&
      parsed.token.length > 0
    ) {
      return {
        serverUrl: parsed.serverUrl.replace(/\/+$/, ""),
        token: parsed.token,
      };
    }
  } catch {
    // Missing/invalid config → bridge not installed: stay silent.
  }
  return null;
}

async function postHook(serverUrl, token, payload, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${serverUrl}${HOOK_URL_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-yep-anywhere": "true",
        "x-zcode-bridge-token": token,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const config = await loadBridgeConfig();
  if (!config) return;

  const stdinRaw = await readStdin();
  let event;
  try {
    event = JSON.parse(stdinRaw);
  } catch {
    return;
  }
  const eventName = event?.hook_event_name;
  if (typeof eventName !== "string") return;

  const isPermissionRequest = eventName === "PermissionRequest";
  const result = await postHook(
    config.serverUrl,
    config.token,
    event,
    isPermissionRequest ? DECISION_TIMEOUT_MS : EVENT_TIMEOUT_MS,
  );

  if (isPermissionRequest) {
    const decision = result?.decision;
    if (
      decision &&
      (decision.behavior === "allow" || decision.behavior === "deny")
    ) {
      const output = {
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision,
        },
      };
      process.stdout.write(`${JSON.stringify(output)}\n`);
    }
    // No decision (timeout/offline): no stdout → TUI shows its own dialog.
  }
}

await main();
process.exit(0);
