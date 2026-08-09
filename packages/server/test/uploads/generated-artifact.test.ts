import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CodexGeneratedArtifactGrant,
  GeneratedArtifactMaterializer,
} from "../../src/uploads/generated-artifact.js";
import { UploadManager } from "../../src/uploads/manager.js";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("GeneratedArtifactMaterializer", () => {
  it("copies a canonical added file into managed storage and deduplicates it", async () => {
    const context = await createContext();
    const source = join(context.workspace, "reports", "result.pdf");
    await mkdir(dirname(source), { recursive: true });
    const bytes = Buffer.from("%PDF-1.7\nGenerated report\n");
    await writeFile(source, bytes);

    const first = await context.materializer.materialize(
      fileChangeItem("reports/result.pdf"),
      context.grant,
    );
    const second = await context.materializer.materialize(
      fileChangeItem("reports/result.pdf"),
      context.grant,
    );

    expect(first.warnings).toEqual([]);
    expect(first.artifacts).toHaveLength(1);
    expect(second).toEqual(first);
    expect(first.artifacts[0]).toMatchObject({
      schemaVersion: 1,
      id: expect.stringMatching(/^ga_[a-f0-9]{32}$/),
      managedRef: expect.stringMatching(/^upload:[a-f0-9-]{36}$/),
      fileName: "result.pdf",
      mimeType: "application/pdf",
      kind: "document",
      sizeBytes: bytes.length,
      sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      source: {
        provider: "codex",
        type: "file_change",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "file-item-1",
      },
      retention: { policy: "temporary" },
    });
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain(context.workspace);
    expect(serialized).not.toContain(context.uploadsDir);

    const artifact = first.artifacts[0];
    if (!artifact) throw new Error("missing artifact");
    const restored = await context.uploadManager.readGeneratedArtifactBytes(
      {
        projectId: context.grant.projectId,
        sessionId: context.grant.sessionId,
      },
      {
        artifactId: artifact.id,
        managedRef: artifact.managedRef,
        fileName: artifact.fileName,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.sizeBytes,
        sha256: artifact.sha256,
        expiresAtMs: Date.parse(artifact.retention.expiresAt),
      },
    );
    expect(Buffer.from(restored.bytes)).toEqual(bytes);
    expect(artifact.downloadUrl).toBe(
      `/api/projects/${context.grant.projectId}/sessions/session-1/generated-artifact/${artifact.id}/${artifact.sha256.slice("sha256:".length)}/result.pdf`,
    );
  });

  it("binds deduplication to the exact canonical event", async () => {
    const context = await createContext();
    const source = join(context.workspace, "result.txt");
    await writeFile(source, "first result\n");
    const first = await context.materializer.materialize(
      fileChangeItem("result.txt", "stable-item"),
      context.grant,
    );

    await writeFile(source, "second result\n");
    const second = await context.materializer.materialize(
      fileChangeItem("result.txt", "stable-item"),
      {
        ...context.grant,
        canonicalEventId: "connection-1:2",
        canonicalEventSequence: 2,
      },
    );

    expect(first.artifacts).toHaveLength(1);
    expect(second.artifacts).toHaveLength(1);
    expect(second.artifacts[0]?.id).not.toBe(first.artifacts[0]?.id);
    expect(second.artifacts[0]?.sha256).not.toBe(first.artifacts[0]?.sha256);
  });

  it("does not materialize replayed completed items", async () => {
    const context = await createContext();
    const source = join(context.workspace, "result.txt");
    await writeFile(source, "safe output\n");

    const result = await context.materializer.materialize(
      { ...fileChangeItem("result.txt"), replay: true },
      context.grant,
    );

    expect(result).toEqual({ artifacts: [], warnings: [] });
  });

  it("rebuilds only source-bound, unexpired, integrity-checked manifests after restart", async () => {
    const context = await createContext({
      now: () => 1_000,
      retentionMs: 1_000,
    });
    await writeFile(join(context.workspace, "restart.txt"), "safe restart\n");
    const live = await context.materializer.materialize(
      fileChangeItem("restart.txt", "restart-item"),
      context.grant,
    );
    const artifact = live.artifacts[0];
    if (!artifact) throw new Error("missing artifact");
    const selectedEvent = {
      eventId: context.grant.canonicalEventId,
      sequence: context.grant.canonicalEventSequence,
      method: "item/completed",
      threadId: context.grant.threadId,
      turnId: context.grant.turnId,
      itemId: "restart-item",
    };
    const reopenedManager = new UploadManager({
      uploadsDir: context.uploadsDir,
    });

    await expect(
      reopenedManager.listReplayableGeneratedArtifacts(
        {
          projectId: context.grant.projectId,
          sessionId: context.grant.sessionId,
        },
        [selectedEvent],
        1_500,
      ),
    ).resolves.toEqual(live.artifacts);
    await expect(
      reopenedManager.listReplayableGeneratedArtifacts(
        {
          projectId: context.grant.projectId,
          sessionId: context.grant.sessionId,
        },
        [{ ...selectedEvent, eventId: "bridge-connection:1" }],
        1_500,
      ),
    ).resolves.toEqual([]);
    await expect(
      reopenedManager.listReplayableGeneratedArtifacts(
        {
          projectId: context.grant.projectId,
          sessionId: context.grant.sessionId,
        },
        [selectedEvent],
        2_001,
      ),
    ).resolves.toEqual([]);

    const managedPath = await reopenedManager.resolveTaskPathRef(
      {
        projectId: context.grant.projectId,
        sessionId: context.grant.sessionId,
      },
      artifact.managedRef,
    );
    await writeFile(managedPath, "evil restart\n");
    await expect(
      reopenedManager.listReplayableGeneratedArtifacts(
        {
          projectId: context.grant.projectId,
          sessionId: context.grant.sessionId,
        },
        [selectedEvent],
        1_500,
      ),
    ).resolves.toEqual([]);

    const registryPath = join(
      context.uploadsDir,
      context.grant.projectId,
      context.grant.sessionId,
      ".generated",
      `${artifact.id}.json`,
    );
    const registry = await readFile(registryPath, "utf8");
    expect(registry).not.toContain(context.workspace);
    await rename(registryPath, `${registryPath}.missing`);
    await expect(
      reopenedManager.listReplayableGeneratedArtifacts(
        {
          projectId: context.grant.projectId,
          sessionId: context.grant.sessionId,
        },
        [selectedEvent],
        1_500,
      ),
    ).resolves.toEqual([]);
  });

  it("rejects forged outside paths and symlinks without exposing either path", async () => {
    const context = await createContext();
    const outside = join(context.root, "outside.pdf");
    await writeFile(outside, "%PDF-1.7\noutside\n");
    const link = join(context.workspace, "linked.pdf");
    await symlink(outside, link);

    const forged = await context.materializer.materialize(
      fileChangeItem(outside, "file-outside"),
      context.grant,
    );
    const linked = await context.materializer.materialize(
      fileChangeItem("linked.pdf", "file-link"),
      context.grant,
    );

    expect(forged.warnings).toEqual([
      { sourceId: "file-outside:0", reason: "outside_workspace" },
    ]);
    expect(linked.warnings).toEqual([
      { sourceId: "file-link:0", reason: "symlink" },
    ]);
    expect(JSON.stringify([forged, linked])).not.toContain(outside);
  });

  it("accepts the granted workspace root alias but still reads from its real root", async () => {
    const context = await createContext();
    const alias = join(context.root, "workspace-alias");
    await symlink(context.workspace, alias, "dir");
    await writeFile(
      join(context.workspace, "aliased.pdf"),
      "%PDF-1.7\nalias\n",
    );

    const result = await context.materializer.materialize(
      fileChangeItem(join(alias, "aliased.pdf"), "file-alias"),
      { ...context.grant, workspaceRoot: alias },
    );

    expect(result.warnings).toEqual([]);
    expect(result.artifacts).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(alias);
    expect(JSON.stringify(result)).not.toContain(context.workspace);
  });

  it("detects a file replacement between validation and open", async () => {
    const context = await createContext({
      beforeOpenForTest: async (candidatePath) => {
        await writeFile(candidatePath, "%PDF-1.7\nreplacement with new size\n");
      },
    });
    await writeFile(join(context.workspace, "race.pdf"), "%PDF-1.7\nold\n");

    const result = await context.materializer.materialize(
      fileChangeItem("race.pdf", "file-race"),
      context.grant,
    );

    expect(result.warnings).toEqual([
      { sourceId: "file-race:0", reason: "changed_during_read" },
    ]);
  });

  it("rejects hard-linked candidates and simulated cross-device mounts", async () => {
    const hardLinkContext = await createContext();
    const original = join(hardLinkContext.workspace, "hardlink.pdf");
    await writeFile(original, "%PDF-1.7\nhardlink\n");
    await link(original, join(hardLinkContext.workspace, "alias.pdf"));

    await expectReason(
      hardLinkContext,
      "hardlink.pdf",
      "hard-link",
      "hard_link",
    );

    const crossDeviceContext = await createContext({
      workspaceRootDeviceForTest: 0xffffffffffffn,
    });
    await writeFile(
      join(crossDeviceContext.workspace, "mounted.pdf"),
      "%PDF-1.7\nmounted\n",
    );
    await expectReason(
      crossDeviceContext,
      "mounted.pdf",
      "cross-device",
      "cross_device",
    );
  });

  it("rechecks link count on the opened descriptor and after reading", async () => {
    const beforeOpen = await createContext({
      beforeOpenForTest: async (candidatePath) => {
        await link(candidatePath, `${candidatePath}.alias`);
      },
    });
    await writeFile(
      join(beforeOpen.workspace, "open-race.pdf"),
      "%PDF-1.7\nopen-race\n",
    );
    await expectReason(
      beforeOpen,
      "open-race.pdf",
      "open-link-race",
      "changed_during_read",
    );

    const afterRead = await createContext({
      beforeFinalValidationForTest: async (candidatePath) => {
        await link(candidatePath, `${candidatePath}.alias`);
      },
    });
    await writeFile(
      join(afterRead.workspace, "read-race.pdf"),
      "%PDF-1.7\nread-race\n",
    );
    await expectReason(
      afterRead,
      "read-race.pdf",
      "final-link-race",
      "changed_during_read",
    );
  });

  it("detects a symlink swap after reading but before final identity validation", async () => {
    const context = await createContext({
      beforeFinalValidationForTest: async (candidatePath) => {
        const outside = join(dirname(candidatePath), "..", "race-outside.pdf");
        await writeFile(outside, "%PDF-1.7\noutside\n");
        await rename(candidatePath, `${candidatePath}.original`);
        await symlink(outside, candidatePath);
      },
    });
    await writeFile(
      join(context.workspace, "race-final.pdf"),
      "%PDF-1.7\nold\n",
    );

    const result = await context.materializer.materialize(
      fileChangeItem("race-final.pdf", "file-final-race"),
      context.grant,
    );

    expect(result.warnings).toEqual([
      { sourceId: "file-final-race:0", reason: "changed_during_read" },
    ]);
  });

  it("fails closed for secret names/content, oversize files and archives", async () => {
    const context = await createContext({
      maxArtifactBytes: 64,
      maxInlineImageBytes: 64,
    });
    await writeFile(join(context.workspace, ".env"), "SAFE=value\n");
    await writeFile(
      join(context.workspace, "notes.txt"),
      "api_key=sk-this-is-a-secret-value\n",
    );
    await writeFile(
      join(context.workspace, "prod-credentials-backup.txt"),
      "otherwise safe\n",
    );
    await writeFile(join(context.workspace, "large.txt"), "x".repeat(65));
    await writeFile(
      join(context.workspace, "bundle.zip"),
      Buffer.from("504b0304", "hex"),
    );

    await expectReason(context, ".env", "secret-name", "sensitive_content");
    await expectReason(
      context,
      "notes.txt",
      "secret-content",
      "sensitive_content",
    );
    await expectReason(
      context,
      "prod-credentials-backup.txt",
      "secret-filename",
      "sensitive_content",
    );
    await expectReason(context, "large.txt", "large", "size_limit");
    await expectReason(context, "bundle.zip", "archive", "high_risk_archive");
  });

  it.each([
    "Cookie: session=this-is-a-cookie-secret",
    "Authorization: Basic dXNlcjpwYXNzd29yZA==",
    "NPM_TOKEN=npm-token-must-not-leak",
    "DEPLOY_TOKEN=generic-token-must-not-leak",
    "SLACK_TOKEN=xoxb-1234567890-secret",
  ])("blocks expanded unified secret syntax: %s", async (content) => {
    const context = await createContext();
    await writeFile(join(context.workspace, "result.txt"), `${content}\n`);
    await expectReason(
      context,
      "result.txt",
      `secret-${roots.length}`,
      "sensitive_content",
    );
  });

  it("applies the unified detector to generated-image prompts before persistence", async () => {
    const context = await createContext();
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
    ]);
    const result = await context.materializer.materialize(
      {
        lifecycle: "completed",
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "imageGeneration",
          id: "image-secret-prompt",
          status: "completed",
          revisedPrompt: "Draw xoxb-1234567890-secret",
          result: png.toString("base64"),
        },
      },
      context.grant,
    );

    expect(result).toEqual({
      artifacts: [],
      warnings: [
        { sourceId: "image-secret-prompt", reason: "sensitive_content" },
      ],
    });
  });

  it("fails closed when generated registry/retention is missing, expired, or same-size bytes change", async () => {
    const context = await createContext({
      now: () => 1_000,
      retentionMs: 1_000,
    });
    await writeFile(join(context.workspace, "result.txt"), "safe-output\n");
    const materialized = await context.materializer.materialize(
      fileChangeItem("result.txt", "registry-check"),
      context.grant,
    );
    const artifact = materialized.artifacts[0];
    if (!artifact) throw new Error("missing artifact");
    const expectation = {
      artifactId: artifact.id,
      managedRef: artifact.managedRef,
      fileName: artifact.fileName,
      mimeType: artifact.mimeType,
      sizeBytes: artifact.sizeBytes,
      sha256: artifact.sha256,
      expiresAtMs: Date.parse(artifact.retention.expiresAt),
    };

    await expect(
      context.uploadManager.readGeneratedArtifactBytes(
        {
          projectId: context.grant.projectId,
          sessionId: context.grant.sessionId,
        },
        expectation,
        1_500,
      ),
    ).resolves.toMatchObject({ bytes: Buffer.from("safe-output\n") });
    await expect(
      context.uploadManager.readGeneratedArtifactBytes(
        {
          projectId: context.grant.projectId,
          sessionId: context.grant.sessionId,
        },
        { ...expectation, mimeType: "application/json" },
        1_500,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const registryPath = join(
      context.uploadsDir,
      context.grant.projectId,
      context.grant.sessionId,
      ".generated",
      `${artifact.id}.json`,
    );
    await rename(registryPath, `${registryPath}.missing`);
    await expect(
      context.uploadManager.readGeneratedArtifactBytes(
        {
          projectId: context.grant.projectId,
          sessionId: context.grant.sessionId,
        },
        expectation,
        1_500,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await rename(`${registryPath}.missing`, registryPath);

    await expect(
      context.uploadManager.readGeneratedArtifactBytes(
        {
          projectId: context.grant.projectId,
          sessionId: context.grant.sessionId,
        },
        expectation,
        2_001,
      ),
    ).rejects.toMatchObject({ code: "EXPIRED" });

    const managedPath = await context.uploadManager.resolveTaskPathRef(
      {
        projectId: context.grant.projectId,
        sessionId: context.grant.sessionId,
      },
      artifact.managedRef,
    );
    await writeFile(managedPath, "evil-output\n");
    await expect(
      context.uploadManager.readGeneratedArtifactBytes(
        {
          projectId: context.grant.projectId,
          sessionId: context.grant.sessionId,
        },
        expectation,
        1_500,
      ),
    ).rejects.toMatchObject({ code: "INTEGRITY" });

    const attachmentId = artifact.managedRef.slice("upload:".length);
    await rm(
      join(
        context.uploadsDir,
        context.grant.projectId,
        context.grant.sessionId,
        ".retention",
        `generated-${attachmentId}.json`,
      ),
    );
    await expect(
      context.uploadManager.readGeneratedArtifactBytes(
        {
          projectId: context.grant.projectId,
          sessionId: context.grant.sessionId,
        },
        expectation,
        1_500,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("removes the generated registry entry with its retained managed copy", async () => {
    const context = await createContext({ now: () => 1_000 });
    await writeFile(join(context.workspace, "cleanup.txt"), "safe cleanup\n");
    const materialized = await context.materializer.materialize(
      fileChangeItem("cleanup.txt", "registry-cleanup"),
      context.grant,
    );
    const artifact = materialized.artifacts[0];
    if (!artifact) throw new Error("missing artifact");
    const attachmentId = artifact.managedRef.slice("upload:".length);
    const registryPath = join(
      context.uploadsDir,
      context.grant.projectId,
      context.grant.sessionId,
      ".generated",
      `${artifact.id}.json`,
    );
    expect(await readFile(registryPath, "utf8")).toContain(artifact.id);

    await expect(
      context.uploadManager.cleanupTaskAttachments({
        projectId: context.grant.projectId,
        sessionId: context.grant.sessionId,
        taskId: `generated-${attachmentId}`,
      }),
    ).resolves.toMatchObject({ removed: true });
    await expect(readFile(registryPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      context.uploadManager.readGeneratedArtifactBytes(
        {
          projectId: context.grant.projectId,
          sessionId: context.grant.sessionId,
        },
        {
          artifactId: artifact.id,
          managedRef: artifact.managedRef,
          fileName: artifact.fileName,
          mimeType: artifact.mimeType,
          sizeBytes: artifact.sizeBytes,
          sha256: artifact.sha256,
          expiresAtMs: Date.parse(artifact.retention.expiresAt),
        },
        1_500,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("enforces the per-task artifact count across canonical added changes", async () => {
    const context = await createContext({ maxArtifactsPerTask: 1 });
    await writeFile(join(context.workspace, "first.txt"), "first output\n");
    await writeFile(join(context.workspace, "second.txt"), "second output\n");

    const result = await context.materializer.materialize(
      {
        lifecycle: "completed",
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "fileChange",
          id: "file-count",
          status: "completed",
          changes: [
            { path: "first.txt", kind: { type: "add" } },
            { path: "second.txt", kind: { type: "add" } },
          ],
        },
      },
      context.grant,
    );

    expect(result.artifacts).toHaveLength(1);
    expect(result.warnings).toEqual([
      { sourceId: "file-count:1", reason: "count_limit" },
    ]);
  });

  it("requires the pinned canonical add shape and exact active turn scope", async () => {
    const context = await createContext();
    await writeFile(join(context.workspace, "result.txt"), "safe output\n");

    const legacyKind = await context.materializer.materialize(
      {
        ...fileChangeItem("result.txt", "legacy-kind"),
        item: {
          type: "fileChange",
          id: "legacy-kind",
          status: "completed",
          changes: [{ path: "result.txt", kind: "add" }],
        },
      },
      context.grant,
    );
    const wrongTurn = await context.materializer.materialize(
      {
        ...fileChangeItem("result.txt", "wrong-turn"),
        turnId: "turn-forged",
      },
      context.grant,
    );

    expect(legacyKind).toEqual({
      artifacts: [],
      warnings: [{ sourceId: "legacy-kind", reason: "invalid_payload" }],
    });
    expect(wrongTurn).toEqual({
      artifacts: [],
      warnings: [{ sourceId: "wrong-turn", reason: "scope_mismatch" }],
    });

    const invalidGrant = await context.materializer.materialize(
      fileChangeItem("result.txt", "invalid-grant"),
      { ...context.grant, projectId: "../outside" },
    );
    expect(invalidGrant).toEqual({
      artifacts: [],
      warnings: [{ sourceId: "invalid-grant", reason: "scope_mismatch" }],
    });
  });

  it("fails closed before persistence when the retention clock is invalid", async () => {
    const context = await createContext({ now: () => Number.NaN });
    await writeFile(join(context.workspace, "result.txt"), "safe output\n");

    const result = await context.materializer.materialize(
      fileChangeItem("result.txt", "invalid-clock"),
      context.grant,
    );

    expect(result).toEqual({
      artifacts: [],
      warnings: [{ sourceId: "invalid-clock:0", reason: "storage_failed" }],
    });
  });

  it("rejects extension/MIME mismatch and reports managed upload failure safely", async () => {
    const context = await createContext();
    await writeFile(join(context.workspace, "fake.png"), "%PDF-1.7\nnot png\n");
    const mismatch = await context.materializer.materialize(
      fileChangeItem("fake.png", "file-mismatch"),
      context.grant,
    );
    expect(mismatch.warnings).toEqual([
      { sourceId: "file-mismatch:0", reason: "mime_mismatch" },
    ]);

    await writeFile(join(context.workspace, "safe.txt"), "safe output\n");
    vi.spyOn(context.uploadManager, "ingest").mockRejectedValueOnce(
      new Error("must-not-leak /private/path token=secret"),
    );
    const failed = await context.materializer.materialize(
      fileChangeItem("safe.txt", "file-upload-fail"),
      context.grant,
    );
    expect(failed.warnings).toEqual([
      { sourceId: "file-upload-fail:0", reason: "storage_failed" },
    ]);
    expect(JSON.stringify(failed)).not.toContain("must-not-leak");
    expect(JSON.stringify(failed)).not.toContain("/private/path");
  });

  it("accepts a fully validated OOXML document and rejects active content", async () => {
    const context = await createContext();
    await writeFile(
      join(context.workspace, "report.docx"),
      createStoredZip([
        ["[Content_Types].xml", "<Types />"],
        [
          "word/document.xml",
          "<w:document><w:t>Safe report</w:t></w:document>",
        ],
      ]),
    );
    await writeFile(
      join(context.workspace, "macro.docx"),
      createStoredZip([
        ["[Content_Types].xml", "<Types />"],
        ["word/document.xml", "<w:document />"],
        ["word/vbaProject.bin", "macro"],
      ]),
    );

    const safe = await context.materializer.materialize(
      fileChangeItem("report.docx", "office-safe"),
      context.grant,
    );
    const active = await context.materializer.materialize(
      fileChangeItem("macro.docx", "office-active"),
      context.grant,
    );

    expect(safe.artifacts[0]).toMatchObject({
      kind: "document",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    expect(active.warnings).toEqual([
      { sourceId: "office-active:0", reason: "high_risk_archive" },
    ]);
  });

  it("preserves completed inline PNG support without consulting savedPath", async () => {
    const context = await createContext();
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
    ]);
    const result = await context.materializer.materialize(
      {
        lifecycle: "completed",
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "imageGeneration",
          id: "image-1",
          status: "completed",
          revisedPrompt: "Draw a blue square",
          result: png.toString("base64"),
          savedPath: "/forged/must-not-be-read.png",
        },
      },
      context.grant,
    );

    expect(result.warnings).toEqual([]);
    expect(result.artifacts[0]).toMatchObject({
      kind: "image",
      mimeType: "image/png",
      sizeBytes: png.length,
      previewUrl: expect.stringContaining("/api/projects/"),
    });
    expect(JSON.stringify(result)).not.toContain("/forged");
  });
});

function fileChangeItem(path: string, id = "file-item-1") {
  return {
    lifecycle: "completed" as const,
    threadId: "thread-1",
    turnId: "turn-1",
    item: {
      type: "fileChange",
      id,
      status: "completed",
      changes: [{ path, kind: { type: "add" }, diff: "" }],
    },
  };
}

async function expectReason(
  context: Awaited<ReturnType<typeof createContext>>,
  path: string,
  id: string,
  reason: string,
) {
  const result = await context.materializer.materialize(
    fileChangeItem(path, id),
    context.grant,
  );
  expect(result.warnings).toEqual([{ sourceId: `${id}:0`, reason }]);
}

async function createContext(
  options: Omit<
    ConstructorParameters<typeof GeneratedArtifactMaterializer>[0],
    "uploadManager"
  > = {},
) {
  const root = await mkdtemp(join(tmpdir(), "yep-generated-artifact-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const uploadsDir = join(root, "uploads");
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(uploadsDir, { recursive: true }),
  ]);
  const uploadManager = new UploadManager({ uploadsDir });
  const materializer = new GeneratedArtifactMaterializer({
    uploadManager,
    ...options,
  });
  const grant: CodexGeneratedArtifactGrant = {
    projectId: Buffer.from(workspace).toString("base64url"),
    sessionId: "session-1",
    taskId: "task-1",
    workspaceRoot: workspace,
    threadId: "thread-1",
    turnId: "turn-1",
    canonicalEventId: "connection-1:1",
    canonicalEventSequence: 1,
  };
  return { root, workspace, uploadsDir, uploadManager, materializer, grant };
}

function createStoredZip(entries: Array<[string, string]>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let localOffset = 0;
  for (const [entryName, text] of entries) {
    const name = Buffer.from(entryName, "utf8");
    const data = Buffer.from(text, "utf8");
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centrals.push(central, name);
    localOffset += local.length + name.length + data.length;
  }
  const localBytes = Buffer.concat(locals);
  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(localBytes.length, 16);
  return Buffer.concat([localBytes, centralBytes, eocd]);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
