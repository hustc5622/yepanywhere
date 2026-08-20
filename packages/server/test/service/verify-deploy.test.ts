import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const verifyScript = path.join(repoRoot, "scripts", "verify-deploy.mjs");

function listen(server: ReturnType<typeof createServer>) {
  return new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: ReturnType<typeof createServer>) {
  return new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function runVerifier({
  workers = { activeWorkers: 0, queueLength: 0, hasActiveWork: false },
  maintenanceStatus = 200,
  includeMaintenance = true,
  serverBuildId = "build-new",
  clientBuildId = "build-new",
  invalidWorkersJson = false,
}: {
  workers?: unknown;
  maintenanceStatus?: number;
  includeMaintenance?: boolean;
  serverBuildId?: string;
  clientBuildId?: string;
  invalidWorkersJson?: boolean;
} = {}) {
  const stateDir = await mkdtemp(path.join(tmpdir(), "yep-verify-deploy-"));
  const buildInfo = path.join(stateDir, "build-info.json");
  await writeFile(
    buildInfo,
    JSON.stringify({ buildId: "build-new", gitCommit: "abc123" }),
    "utf8",
  );
  const main = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Connection", "close");
    if (request.url?.startsWith("/api/version?")) {
      response.end(
        JSON.stringify({
          build: { buildId: serverBuildId, gitCommit: "abc123" },
        }),
      );
    } else if (request.url?.startsWith("/build-info.json?")) {
      response.end(
        JSON.stringify({ buildId: clientBuildId, gitCommit: "abc123" }),
      );
    } else if (request.url?.startsWith("/api/status/workers?")) {
      response.end(invalidWorkersJson ? "{" : JSON.stringify(workers));
    } else {
      response.writeHead(404).end();
    }
  });
  const maintenance = createServer((request, response) => {
    response.setHeader("Connection", "close");
    if (request.url?.startsWith("/health?")) {
      response.writeHead(maintenanceStatus, {
        "Content-Type": "application/json",
      });
      response.end(JSON.stringify({ status: "ok" }));
    } else {
      response.writeHead(404).end();
    }
  });
  const baseUrl = await listen(main);
  const maintenanceUrl = await listen(maintenance);
  const args = [verifyScript, "--base-url", baseUrl, "--build-info", buildInfo];
  if (includeMaintenance) args.push("--maintenance-url", maintenanceUrl);

  try {
    return await new Promise<{ code: number; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, args, {
          cwd: repoRoot,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.once("error", reject);
        child.once("close", (code) =>
          resolve({ code: code ?? 1, stdout, stderr }),
        );
      },
    );
  } finally {
    await Promise.all([close(main), close(maintenance)]);
    await rm(stateDir, { recursive: true, force: true });
  }
}

it("verifies the running build, worker readiness shape, and maintenance health", async () => {
  const result = await runVerifier();

  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain("activeWorkers=0 queueLength=0");
  expect(result.stdout).toContain("maintenanceUrl=http://127.0.0.1:");
});

it("keeps maintenance optional and leaves idle enforcement to deployment", async () => {
  const result = await runVerifier({
    includeMaintenance: false,
    workers: { activeWorkers: 2, queueLength: 1, hasActiveWork: true },
  });

  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain("activeWorkers=2 queueLength=1");
});

it("rejects a malformed worker readiness payload", async () => {
  const result = await runVerifier({ workers: { activeWorkers: 0 } });

  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("/api/status/workers");
});

it("rejects a failing maintenance endpoint", async () => {
  const result = await runVerifier({ maintenanceStatus: 500 });

  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("/health");
});

it("identifies the endpoint when JSON parsing fails", async () => {
  const result = await runVerifier({ invalidWorkersJson: true });

  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("/api/status/workers");
});

it.each([
  ["serverBuildId", "/api/version"],
  ["clientBuildId", "/build-info.json"],
] as const)("identifies %s mismatches with %s", async (field, endpoint) => {
  const result = await runVerifier({ [field]: "build-wrong" });

  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain(endpoint);
});
