import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectFileOperations } from "../../src/session-files/operation-projection.js";
import { SessionFileOperationStore } from "../../src/session-files/operation-store.js";
import { importPiFileOperations } from "../../src/session-files/pi-operations.js";
import { contentId } from "../../src/session-files/store.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-file-operations-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("Pi operation artifact import", () => {
  it("keeps confirmed file identities when content quota is exhausted and retires the spool copy", async () => {
    const store = new SessionFileOperationStore(join(root, "limited"), 100, 1);
    const folder = join(store.directory, "pi-ingress", contentId("s"));
    await mkdir(folder, { recursive: true });
    const artifact = JSON.stringify({
      version: 1,
      sessionId: "s",
      turnId: "u",
      toolCallId: "call",
      toolName: "write",
      workspace: root,
      path: join(root, "doc.md"),
      timestamp: "2026-09-21T00:00:00Z",
      written: true,
      before: null,
      after: Buffer.from("saved content").toString("base64"),
    });
    await writeFile(join(folder, `${contentId(artifact)}.json`), artifact);
    expect(await importPiFileOperations(store, "s")).toBe(0);
    const snapshot = await store.snapshot({
      provider: "pi",
      sourceId: "local",
      sessionId: "s",
    });
    const projected = await projectFileOperations(
      store,
      snapshot.operations,
      root,
      new Map([["u", "u"]]),
    );
    expect(projected.files[0]).toMatchObject({
      path: "doc.md",
      count: 1,
      unknownOperations: 1,
    });
    expect(projected.files[0]?.additions).toBeUndefined();
    expect(snapshot.operations[0]?.record.changes[0]?.unavailableReason).toBe(
      "capture-failed",
    );
    expect(await readdir(folder)).toEqual([]);
  });

  it("imports only the session artifacts, with durable tool identities and real before/after bytes", async () => {
    const store = new SessionFileOperationStore(join(root, "operations"));
    const folder = join(store.directory, "pi-ingress", contentId("s"));
    await mkdir(folder, { recursive: true });
    const artifact = JSON.stringify({
      version: 1,
      sessionId: "s",
      turnId: "u",
      toolCallId: "call",
      toolName: "write",
      workspace: root,
      path: join(root, "doc.md"),
      timestamp: "2026-09-21T00:00:00Z",
      written: true,
      before: Buffer.from("old\n").toString("base64"),
      after: Buffer.from("new\n").toString("base64"),
    });
    await writeFile(join(folder, `${contentId(artifact)}.json`), artifact);
    expect(
      await Promise.all([
        importPiFileOperations(store, "s"),
        importPiFileOperations(store, "s"),
      ]),
    ).toEqual([0, 0]);
    await importPiFileOperations(store, "s");
    const snapshot = await store.snapshot({
      provider: "pi",
      sourceId: "local",
      sessionId: "s",
    });
    expect(snapshot.operations).toHaveLength(1);
    expect(
      (
        await projectFileOperations(
          store,
          snapshot.operations,
          root,
          new Map([["u", "u"]]),
        )
      ).files[0],
    ).toMatchObject({ additions: 1, deletions: 1 });
  });
});

// Optional local integration uses the installed Pi SDK directly; never starts a model or service.
const installedSdk = process.env.FILE_OPERATION_TEST_PI_SDK;
describe.skipIf(!installedSdk)("Pi installed native tool operations", () => {
  it.each(["write-edit", "storage-error"])(
    "verifies %s against the installed SDK without model calls",
    async (scenario) => {
      const result = await promisify(execFile)(
        process.execPath,
        [
          join(import.meta.dirname, "fixtures/pi-native-smoke.mjs"),
          installedSdk ?? "missing",
          root,
          scenario,
        ],
        { env: { ...process.env, NODE_OPTIONS: "" } },
      );
      expect(result.stdout).toContain("Pi native file operation smoke passed");
    },
  );
});
