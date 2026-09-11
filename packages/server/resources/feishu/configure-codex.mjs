#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export function replaceLarkConfig(source, command, args) {
  const lines = source.split("\n");
  let skipping = false;
  const result = [];
  for (const line of lines) {
    const table = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (table)
      skipping =
        /^mcp_servers\.(?:lark|"lark"|'lark'|feishu-mcp|"feishu-mcp"|'feishu-mcp'|yep-feishu|"yep-feishu"|'yep-feishu')(?:\.|$)/.test(
          table[1].trim(),
        );
    if (!skipping) result.push(line);
  }
  return `${result.join("\n").trimEnd()}\n\n[mcp_servers.yep-feishu]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\ntool_timeout_sec = 240\n`;
}

async function main() {
  const args = process.argv.slice(2);
  const value = (flag) => {
    const index = args.indexOf(flag);
    return index < 0 ? undefined : args[index + 1];
  };
  const connector = value("--connector-config");
  if (!connector)
    throw new Error(
      "Usage: configure-codex.mjs --connector-config PATH [--config PATH] [--apply]. Defaults to dry-run.",
    );
  // Validate the generated file, but never print its bearer token.
  const binding = JSON.parse(await readFile(connector, "utf8"));
  if (
    !binding.serverUrl ||
    !binding.token ||
    !binding.accountId ||
    !binding.userOpenId
  )
    throw new Error("Invalid Yep connector configuration.");
  const path = value("--config") ?? join(homedir(), ".codex", "config.toml");
  const source = await readFile(path, "utf8");
  const next = replaceLarkConfig(source, process.execPath, [
    join(import.meta.dirname, "connector.mjs"),
    connector,
  ]);
  if (!args.includes("--apply")) {
    console.log(
      "Dry-run: replace lark and feishu-mcp entries (including their child tables) with the Yep connector. Other configuration is preserved. No process will be restarted.",
    );
    console.log(
      `Target: ${path}\nConnector configuration: ${connector}\nUse --apply after active tasks have finished.`,
    );
    return;
  }
  const backup = `${path}.before-yep-feishu-${Date.now()}`;
  await writeFile(backup, source, { mode: 0o600, flag: "wx" });
  const temporary = join(dirname(path), `.yep-feishu-${randomUUID()}.tmp`);
  await writeFile(temporary, next, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  console.log(
    `Updated Codex MCP configuration. Backup: ${backup}. Active processes were not changed.`,
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
