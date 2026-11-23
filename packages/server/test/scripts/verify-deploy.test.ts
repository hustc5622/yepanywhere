import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(process.cwd(), "../..");
const script = join(root, "scripts/verify-deploy.mjs");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const expectedBuild = {
  buildId: "2026.11.0-test",
  version: "2026.11.0",
  gitCommit: "abc123",
};

function writeExpectedBuild() {
  const dir = mkdtempSync(join(tmpdir(), "yep-verify-deploy-"));
  dirs.push(dir);
  const buildInfo = join(dir, "build-info.json");
  writeFileSync(buildInfo, JSON.stringify(expectedBuild));
  return buildInfo;
}

function runVerify(baseUrl: string, buildInfo: string) {
  return new Promise<{ status: number; stdout: string; stderr: string }>(
    (resolvePromise, reject) => {
      const child = spawn(
        process.execPath,
        [script, "--base-url", baseUrl, "--build-info", buildInfo],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", reject);
      child.on("close", (status) => {
        resolvePromise({
          status: status ?? 1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      });
    },
  );
}

async function withServer(
  routes: Record<string, { status: number; body: unknown }>,
  check: (baseUrl: string, hits: string[]) => Promise<void>,
) {
  const hits: string[] = [];
  const server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    hits.push(path);
    const route = routes[path];
    if (!route) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(route.status, {
      "content-type": "application/json",
      connection: "close",
    });
    response.end(JSON.stringify(route.body));
  });
  await new Promise<void>((resolveListen) => {
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("expected a TCP port");
  }
  try {
    await check(`http://127.0.0.1:${address.port}`, hits);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => (error ? rejectClose(error) : resolveClose()));
    });
  }
}

describe("verify-deploy", () => {
  it("compares the server version endpoint and the served build info", async () => {
    const buildInfo = writeExpectedBuild();
    await withServer(
      {
        "/api/version": {
          status: 200,
          body: {
            current: "2026.11.0",
            resumeProtocolVersion: 4,
            build: {
              ...expectedBuild,
              source: "bundle",
              entrypoint: "dist/cli.js",
            },
          },
        },
        "/build-info.json": { status: 200, body: expectedBuild },
      },
      async (baseUrl) => {
        const result = await runVerify(baseUrl, buildInfo);
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("buildId=2026.11.0-test");
        expect(result.stdout).toContain("source=bundle");
        expect(result.stdout).not.toContain("requires authentication");
      },
    );
  });

  it("accepts the served build info when /api/version requires authentication", async () => {
    const buildInfo = writeExpectedBuild();
    await withServer(
      {
        "/api/version": {
          status: 401,
          body: { error: "Authentication required" },
        },
        "/build-info.json": { status: 200, body: expectedBuild },
      },
      async (baseUrl, hits) => {
        const result = await runVerify(baseUrl, buildInfo);
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("requires authentication");
        expect(result.stdout).toContain("buildId=2026.11.0-test");
        expect(hits).toEqual(["/api/version", "/build-info.json"]);
      },
    );
  });

  it("does not treat a non-401 version failure as an authenticated deploy", async () => {
    const buildInfo = writeExpectedBuild();
    await withServer(
      {
        "/api/version": { status: 500, body: { error: "unavailable" } },
        "/build-info.json": { status: 200, body: expectedBuild },
      },
      async (baseUrl, hits) => {
        const result = await runVerify(baseUrl, buildInfo);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("500");
        expect(hits).toEqual(["/api/version"]);
      },
    );
  });
});
