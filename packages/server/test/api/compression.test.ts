import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzip as gunzipCb } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const gunzip = promisify(gunzipCb);
import { createApp } from "../../src/app.js";
import { MockClaudeSDK } from "../../src/sdk/mock.js";
import { encodeProjectId } from "../../src/supervisor/types.js";

/**
 * Session payloads are dominated by server-rendered augment HTML, which is
 * highly redundant: a measured 1.72 MB response compressed to 0.238 MB (7.2:1).
 * Uncompressed that needed roughly two minutes over a throttled remote tunnel,
 * so these tests pin the middleware's presence and its decode correctness.
 *
 * Two guards belong to Hono rather than to us, and are verified by reading its
 * source instead of here because this harness exposes no route that returns
 * them: it skips responses already carrying `Content-Encoding` or
 * `Transfer-Encoding` (so `streamSSE` output is untouched), and its
 * compressible-type allowlist both excludes `text/event-stream` and omits the
 * binary types used by the APK and image downloads served through `stream()`.
 */
describe("API response compression", () => {
  let mockSdk: MockClaudeSDK;
  let testDir: string;
  let projectId: string;
  let projectPath: string;

  beforeEach(async () => {
    mockSdk = new MockClaudeSDK();
    testDir = join(tmpdir(), `compress-test-${randomUUID()}`);
    projectPath = join(testDir, "myproject");
    projectId = encodeProjectId(projectPath);
    const encodedPath = projectPath.replaceAll("/", "-");

    await mkdir(projectPath, { recursive: true });
    const sessionsDir = join(testDir, "sessions", "localhost", encodedPath);
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      join(sessionsDir, "sess-existing.jsonl"),
      `{"type":"user","cwd":"${projectPath}","message":{"content":"Hello"}}\n`,
    );

    // Comfortably above the 1 KiB threshold, and repetitive like real augment
    // HTML so the ratio is meaningful.
    await writeFile(
      join(projectPath, "big.md"),
      `${"# Heading\n\nsome repeated prose about compression. ".repeat(400)}\n`,
    );
    await writeFile(join(projectPath, "tiny.md"), "hi");
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  function makeApp() {
    return createApp({
      sdk: mockSdk,
      projectsDir: join(testDir, "sessions"),
    }).app;
  }

  it("gzips a large JSON response when the client accepts it", async () => {
    const res = await makeApp().request(
      `/api/projects/${projectId}/files?path=big.md`,
      { headers: { "Accept-Encoding": "gzip" } },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Encoding")).toBe("gzip");

    // Content-Length must be dropped: the body length is no longer known up
    // front, and a stale value would truncate the response.
    expect(res.headers.get("Content-Length")).toBeNull();

    const compressed = await res.arrayBuffer();
    const plain = await makeApp()
      .request(`/api/projects/${projectId}/files?path=big.md`, {
        headers: { "Accept-Encoding": "identity" },
      })
      .then((r) => r.arrayBuffer());

    expect(compressed.byteLength).toBeLessThan(plain.byteLength / 2);
  });

  it("leaves the response untouched when the client does not accept encoding", async () => {
    const res = await makeApp().request(
      `/api/projects/${projectId}/files?path=big.md`,
      { headers: { "Accept-Encoding": "identity" } },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Encoding")).toBeNull();
  });

  it("also compresses small JSON, because c.json() sets no Content-Length", async () => {
    // Hono's threshold can only be honoured when the handler declared a
    // Content-Length, which `c.json()` does not. Routes that stream files do set
    // it, so the threshold still protects those. This test records the actual
    // behaviour rather than the intended one: the cost is a few bytes and a
    // little CPU on small polling responses, which we accept in exchange for
    // keeping Hono's well-tested middleware instead of a bespoke one.
    const res = await makeApp().request(
      `/api/projects/${projectId}/files?path=tiny.md`,
      { headers: { "Accept-Encoding": "gzip" } },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Encoding")).toBe("gzip");
  });

  it("round-trips to the same JSON the uncompressed response returns", async () => {
    const compressed = await makeApp().request(
      `/api/projects/${projectId}/files?path=big.md`,
      { headers: { "Accept-Encoding": "gzip" } },
    );
    expect(compressed.headers.get("Content-Encoding")).toBe("gzip");
    // `Response` does not inflate on its own — that happens in fetch's HTTP
    // layer — so decode explicitly to exercise the real encode/decode path.
    const inflated = await gunzip(Buffer.from(await compressed.arrayBuffer()));
    const fromCompressed = JSON.parse(inflated.toString("utf8"));

    const plain = await makeApp().request(
      `/api/projects/${projectId}/files?path=big.md`,
      { headers: { "Accept-Encoding": "identity" } },
    );
    const fromPlain = await plain.json();

    expect(fromCompressed).toEqual(fromPlain);
  });
});
