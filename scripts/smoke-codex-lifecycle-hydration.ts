#!/usr/bin/env npx tsx

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getCodexMcpAppServerArgs } from "../packages/server/src/codex/mcp-profile.js";
import { findCodexCliPath } from "../packages/server/src/sdk/cli-detection.js";
import { CodexAppServerClient } from "../packages/server/src/sdk/providers/codex.js";

interface LifecycleThreadResponse {
  thread: {
    id: string;
    historyMode: string;
    turns: unknown[];
  };
  initialTurnsPage?: {
    data: Array<{ id: string; status: string }>;
  } | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function waitForTurnCompletion(
  client: CodexAppServerClient,
  threadId: string,
): Promise<string[]> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 10_000);
  const methods: string[] = [];
  try {
    for (;;) {
      const notification = await client.nextNotification(controller.signal);
      methods.push(notification.method);
      const params = asRecord(notification.params);
      if (
        notification.method === "turn/completed" &&
        params?.threadId === threadId
      ) {
        return methods;
      }
    }
  } catch (error) {
    if (timedOut) {
      throw new Error("Timed out materializing the disposable Codex turn", {
        cause: error,
      });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function drainNotificationMethods(
  client: CodexAppServerClient,
): Promise<string[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 150);
  const methods: string[] = [];
  try {
    for (;;) {
      methods.push((await client.nextNotification(controller.signal)).method);
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    clearTimeout(timeout);
  }
  return methods;
}

async function main(): Promise<void> {
  if (!process.argv.includes("--disposable")) {
    throw new Error("This smoke requires the explicit --disposable flag");
  }
  const command = process.env.CODEX_PATH ?? (await findCodexCliPath());
  if (!command) {
    throw new Error(
      "Codex CLI not found; set CODEX_PATH to run the smoke test",
    );
  }

  const tempRoot = mkdtempSync(join(tmpdir(), "yep-codex-lifecycle-smoke-"));
  const codexHome = join(tempRoot, "codex-home");
  const workspace = join(tempRoot, "workspace");
  mkdirSync(codexHome);
  mkdirSync(workspace);
  const childEnv = { ...process.env, CODEX_HOME: codexHome };
  const fixtureClient = new CodexAppServerClient(
    command,
    workspace,
    childEnv,
    getCodexMcpAppServerArgs("clear"),
  );
  let client: CodexAppServerClient | null = null;

  try {
    await fixtureClient.connect();
    await fixtureClient.request<{ userAgent: string }>("initialize", {
      clientInfo: {
        name: "yep-anywhere-lifecycle-smoke",
        version: "dev",
      },
      capabilities: { experimentalApi: true },
    });
    fixtureClient.notify("initialized");

    const started = await fixtureClient.request<LifecycleThreadResponse>(
      "thread/start",
      {
        cwd: workspace,
        historyMode: "paginated",
        config: { mcp_servers: {} },
      },
    );
    if (started.thread.historyMode !== "paginated") {
      throw new Error("Disposable Codex thread did not use paginated history");
    }

    // A new non-ephemeral thread has no rollout until its first turn. Use a
    // local shell turn to materialize a genuine paginated fixture without a
    // model request or any access outside the disposable workspace.
    await fixtureClient.request("thread/shellCommand", {
      threadId: started.thread.id,
      command: "pwd",
    });
    const materializationNotifications = await waitForTurnCompletion(
      fixtureClient,
      started.thread.id,
    );
    fixtureClient.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 150));

    client = new CodexAppServerClient(
      command,
      workspace,
      childEnv,
      getCodexMcpAppServerArgs("clear"),
    );
    await client.connect();
    const initialized = await client.request<{ userAgent: string }>(
      "initialize",
      {
        clientInfo: {
          name: "yep-anywhere-lifecycle-smoke",
          version: "dev",
        },
        capabilities: { experimentalApi: true },
      },
    );
    client.notify("initialized");

    const resumed = await client.request<LifecycleThreadResponse>(
      "thread/resume",
      {
        threadId: started.thread.id,
        excludeTurns: true,
        initialTurnsPage: {
          limit: 1,
          sortDirection: "desc",
          itemsView: "notLoaded",
        },
        config: { mcp_servers: {} },
      },
    );
    if (
      resumed.thread.turns.length !== 0 ||
      !resumed.initialTurnsPage ||
      resumed.initialTurnsPage.data.length !== 1
    ) {
      throw new Error(
        "Metadata-only resume unexpectedly hydrated turn history",
      );
    }
    const boundaryTurnId = resumed.initialTurnsPage.data[0]?.id;
    if (!boundaryTurnId) {
      throw new Error(
        "Initial resume page did not contain the disposable turn",
      );
    }

    const forked = await client.request<LifecycleThreadResponse>(
      "thread/fork",
      {
        threadId: started.thread.id,
        lastTurnId: boundaryTurnId,
        excludeTurns: true,
        config: { mcp_servers: {} },
      },
    );
    if (forked.thread.turns.length !== 0) {
      throw new Error("Metadata-only fork unexpectedly hydrated turn history");
    }

    const notificationMethods = [
      ...materializationNotifications,
      ...(await drainNotificationMethods(client)),
    ];
    if (notificationMethods.includes("deprecationNotice")) {
      throw new Error("Codex emitted a full-history hydration deprecation");
    }

    console.log(
      JSON.stringify({
        disposable: true,
        experimentalApi: true,
        cliVersion: initialized.userAgent,
        historyMode: started.thread.historyMode,
        resumeTurns: resumed.thread.turns.length,
        initialPageTurns: resumed.initialTurnsPage.data.length,
        forkTurns: forked.thread.turns.length,
        deprecationNotices: 0,
      }),
    );
  } finally {
    fixtureClient.close();
    client?.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Codex lifecycle smoke failed",
  );
  process.exitCode = 1;
});
