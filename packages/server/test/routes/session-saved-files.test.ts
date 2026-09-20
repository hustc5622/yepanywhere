import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeProjectId } from "../../src/projects/paths.js";
import { registerSessionDisplayRoutes } from "../../src/routes/session-display.js";
import { captureWorkspace } from "../../src/session-files/capture.js";
import { recordSnapshotChanges } from "../../src/session-files/changes.js";
import { SessionFileStore } from "../../src/session-files/store.js";

let root: string;
let workspace: string;
let store: SessionFileStore;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "saved-files-api-"));
  workspace = join(root, "project");
  await mkdir(workspace);
  store = new SessionFileStore(join(root, "store"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function setup(provider: "codex" | "pi" = "codex") {
  const projectId = encodeProjectId(workspace);
  const summary = {
    id: "s",
    projectId,
    provider,
    title: "Test",
    fullTitle: "Test",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    messageCount: 1,
    ownership: { owner: "none" },
  };
  const reader = {
    getSessionSummary: vi.fn(async () => summary),
    getSession: vi.fn(
      async (
        _id: string,
        _project: string,
        _limit: unknown,
        options: { branchId?: string },
      ) => ({
        summary,
        data: { provider: "codex", session: { entries: [] } },
        projectedMessages: [
          {
            type: "user",
            uuid: options.branchId === "old" ? "old" : "visible",
            codexTurnId: options.branchId === "old" ? "old" : "visible",
            message: { role: "user", content: "prompt" },
          },
        ],
      }),
    ),
  };
  const app = new Hono();
  registerSessionDisplayRoutes(app, {
    sessionFileStore: store,
    scanner: {
      getOrCreateProject: vi.fn(
        async () =>
          ({
            id: projectId,
            path: workspace,
            provider,
            sessionDir: root,
          }) as never,
      ),
    },
    providerResolution: {
      readerFactory: () => reader as never,
      codexReaderFactory: () => reader as never,
      piReaderFactory: () => reader as never,
    },
  });
  const base = `/projects/${projectId}/sessions/s/files`;
  return { app, base, reader };
}

async function captureChange(
  turnId = "visible",
  provider: "codex" | "pi" = "codex",
  content = "# Saved document\n",
) {
  const before = await captureWorkspace(store, workspace);
  await writeFile(join(workspace, "report.md"), content);
  const after = await captureWorkspace(store, workspace);
  return recordSnapshotChanges(
    store,
    { provider, sessionId: "s", branchId: "s", turnId },
    before.id,
    after.id,
  );
}

describe("saved session file routes", () => {
  it.each(["codex", "pi"] as const)(
    "shares concurrent %s snapshot selection scans",
    async (provider) => {
      await captureChange("visible", provider);
      const { app, base, reader } = setup(provider);
      const responses = await Promise.all([
        app.request(base),
        app.request(base),
        app.request(base),
      ]);
      expect(responses.map((response) => response.status)).toEqual([
        200, 200, 200,
      ]);
      expect(reader.getSession).toHaveBeenCalledTimes(1);
      await app.request(base);
      expect(reader.getSession).toHaveBeenCalledTimes(1);
      await captureChange("visible", provider, "new version");
      await app.request(base);
      expect(reader.getSession).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["codex", "pi"] as const)(
    "lists and previews %s snapshots independently of current disk state",
    async (provider) => {
      const { id } = await captureChange("visible", provider);
      const { app, base } = setup(provider);
      await rm(join(workspace, "report.md"));
      const index = await app.request(base);
      expect(index.status).toBe(200);
      const body = await index.json();
      expect(body.source).toBe("snapshot");
      expect(body.files).toEqual([
        expect.objectContaining({
          path: "report.md",
          source: "snapshot",
          savedVersions: [
            expect.objectContaining({ recordId: id, kind: "added" }),
          ],
        }),
      ]);
      const content = await app.request(
        `${base}/content?path=report.md&recordId=${id}`,
      );
      expect(content.status).toBe(200);
      expect(await content.json()).toMatchObject({
        content: "# Saved document\n",
        binary: false,
        deleted: false,
      });
      const diff = await app.request(`${base}/diff`, {
        method: "POST",
        body: JSON.stringify({ path: "report.md", recordId: id }),
      });
      expect(diff.status).toBe(200);
      expect((await diff.json()).diffHtml).toContain("Saved");
    },
  );

  it("keeps execution versions separate and refreshes without transcript mtime changes", async () => {
    const first = await captureChange();
    const { app, base } = setup();
    expect(
      (await (await app.request(base)).json()).files[0].savedVersions,
    ).toHaveLength(1);
    await captureChange("visible", "codex", "second version");
    expect(
      (await (await app.request(base)).json()).files[0].savedVersions,
    ).toHaveLength(2);
    const old = await app.request(
      `${base}/content?path=report.md&recordId=${first.id}`,
    );
    expect((await old.json()).content).toBe("# Saved document\n");
  });

  it("filters branches for both listing and direct record access", async () => {
    const hidden = await captureChange("old");
    const { app, base, reader } = setup();
    expect((await (await app.request(base)).json()).files).toEqual([]);
    expect(
      (
        await app.request(
          `${base}/content?path=report.md&recordId=${hidden.id}`,
        )
      ).status,
    ).toBe(404);
    expect(
      (await (await app.request(`${base}?branchId=old`)).json()).files,
    ).toHaveLength(1);
    expect(
      (
        await app.request(
          `${base}/content?path=report.md&recordId=${hidden.id}&branchId=old`,
        )
      ).status,
    ).toBe(200);
    expect(reader.getSession).toHaveBeenCalledWith(
      "s",
      expect.any(String),
      undefined,
      expect.objectContaining({ branchId: "old", includeOrphans: false }),
    );
  });

  it("returns deleted preimages and identifies binary content without decoding garbage", async () => {
    await writeFile(join(workspace, "report.md"), "deleted text");
    const before = await captureWorkspace(store, workspace);
    await rm(join(workspace, "report.md"));
    await writeFile(join(workspace, "image.bin"), Buffer.from([0, 255, 17]));
    const after = await captureWorkspace(store, workspace);
    const { id } = await recordSnapshotChanges(
      store,
      { provider: "codex", sessionId: "s", branchId: "s", turnId: "visible" },
      before.id,
      after.id,
    );
    const { app, base } = setup();
    expect(
      await (
        await app.request(`${base}/content?path=report.md&recordId=${id}`)
      ).json(),
    ).toMatchObject({ deleted: true, content: "deleted text" });
    expect(
      await (
        await app.request(`${base}/content?path=image.bin&recordId=${id}`)
      ).json(),
    ).toMatchObject({ binary: true, bytes: 3 });
    expect(
      (
        await app.request(`${base}/diff`, {
          method: "POST",
          body: JSON.stringify({ path: "image.bin", recordId: id }),
        })
      ).status,
    ).toBe(415);
  });

  it("rejects foreign sessions, workspaces, paths and raw blob IDs", async () => {
    const current = await captureChange();
    const foreignScope = { ...current.record.scope, sessionId: "foreign" };
    const foreign = await store.putRecord({
      ...current.record,
      scope: foreignScope,
    });
    const { app, base } = setup();
    expect(
      (await app.request(`${base}/content?path=report.md&recordId=${foreign}`))
        .status,
    ).toBe(404);
    expect(
      (
        await app.request(
          `${base}/content?path=report.md&recordId=${current.record.changes[0]?.after?.blob}`,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(
          `${base}/content?path=../secret&recordId=${current.id}`,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request(
          `${base}/content?path=other.md&recordId=${current.id}`,
        )
      ).status,
    ).toBe(404);
    const other = join(root, "other");
    await mkdir(other);
    const before = await captureWorkspace(store, other);
    await writeFile(join(other, "secret.md"), "wrong workspace");
    const after = await captureWorkspace(store, other);
    const wrong = await recordSnapshotChanges(
      store,
      current.record.scope,
      before.id,
      after.id,
    );
    expect(
      (await app.request(`${base}/content?path=secret.md&recordId=${wrong.id}`))
        .status,
    ).toBe(404);
  });

  it("does not fill new indexes from transcript guesses when there are no captures", async () => {
    const { app, base } = setup();
    expect(await (await app.request(base)).json()).toMatchObject({
      source: "snapshot",
      files: [],
    });
  });
});
