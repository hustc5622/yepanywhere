import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ReportDocumentResponse,
  ReportImageUploadResponse,
  ReportsListResponse,
} from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReportsRoutes } from "../../src/routes/reports.js";

describe("Reports routes", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "yep-reports-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("lists markdown reports and Bilibili transcript artifacts", async () => {
    const markdownDir = path.join(tempDir, "outputs", "model_speed_benchmark");
    await mkdir(markdownDir, { recursive: true });
    const markdownPath = path.join(markdownDir, "model_speed_report.md");
    await writeFile(markdownPath, "# Model Speed Report\n\nBody");

    const transcriptDir = path.join(
      tempDir,
      "outputs",
      "bilibili_transcripts",
      "20260629-102253-bv1uhtu6teks",
    );
    await mkdir(transcriptDir, { recursive: true });
    const correctedPath = path.join(
      transcriptDir,
      "deepseek_corrected_speaker_turns.txt",
    );
    const rawTurnsPath = path.join(transcriptDir, "speaker_turns.txt");
    await writeFile(
      correctedPath,
      "[00:00:00 - 00:00:01] Speaker 0\nDeepSeek transcript",
    );
    await writeFile(rawTurnsPath, "raw transcript");
    await writeFile(path.join(transcriptDir, "notes.txt"), "not a report");
    await writeFile(
      path.join(transcriptDir, "source.info.json"),
      JSON.stringify({
        title: "梁圣亲自挂帅！V4超级Buff全解析！DSpark【论文精读】",
      }),
    );

    const routes = createReportsRoutes({ reportsDir: tempDir });
    const response = await routes.request("/");

    expect(response.status).toBe(200);
    const json = (await response.json()) as ReportsListResponse;
    expect(json.rootPath).toBe(tempDir);

    const paths = json.documents.map((doc) => doc.path);
    expect(paths).toContain(
      "outputs/model_speed_benchmark/model_speed_report.md",
    );
    expect(paths).toContain(
      "outputs/bilibili_transcripts/20260629-102253-bv1uhtu6teks/deepseek_corrected_speaker_turns.txt",
    );
    expect(paths).toContain(
      "outputs/bilibili_transcripts/20260629-102253-bv1uhtu6teks/speaker_turns.txt",
    );
    expect(paths).not.toContain(
      "outputs/bilibili_transcripts/20260629-102253-bv1uhtu6teks/notes.txt",
    );

    const transcript = json.documents.find(
      (doc) =>
        doc.path ===
        paths.find((p) => p.endsWith("corrected_speaker_turns.txt")),
    );
    expect(transcript).toMatchObject({
      absolutePath: correctedPath,
      kind: "transcript",
      title:
        "梁圣亲自挂帅！V4超级Buff全解析！DSpark【论文精读】 (DeepSeek 校正版)",
    });

    const markdown = json.documents.find((doc) =>
      doc.path.endsWith("model_speed_report.md"),
    );
    expect(markdown).toMatchObject({
      absolutePath: markdownPath,
      kind: "markdown",
      title: "Model Speed Report",
    });
  });

  it("keeps prompt and intermediate markdown artifacts out of the list", async () => {
    await writeFile(path.join(tempDir, "README.md"), "# Workspace notes");
    await writeFile(path.join(tempDir, "field-guide.md"), "# Field Guide");

    const promptsDir = path.join(tempDir, "prompts");
    await mkdir(promptsDir, { recursive: true });
    await writeFile(
      path.join(promptsDir, "codex-transcript-prompt.md"),
      "# Codex Prompt\n\nInternal instructions",
    );

    const outputDir = path.join(tempDir, "outputs", "run-123");
    await mkdir(path.join(outputDir, "codex_chunks"), { recursive: true });
    await mkdir(path.join(outputDir, "feishu_chunks"), { recursive: true });
    await writeFile(
      path.join(outputDir, "final_report.md"),
      "# Final Report\n\nPublished output",
    );
    await writeFile(
      path.join(outputDir, "codex_chunks", "chunk_001_pass1_prompt.md"),
      "# Chunk Prompt\n\nCorrect this transcript",
    );
    await writeFile(
      path.join(outputDir, "codex_chunks", "chunk_001_pass1_draft.txt"),
      "intermediate draft",
    );
    await writeFile(
      path.join(outputDir, "feishu_chunks", "00_overview.md"),
      "# Feishu Import Chunk",
    );

    const routes = createReportsRoutes({ reportsDir: tempDir });
    const response = await routes.request("/");

    expect(response.status).toBe(200);
    const json = (await response.json()) as ReportsListResponse;
    const paths = json.documents.map((doc) => doc.path);

    expect(paths).toContain("field-guide.md");
    expect(paths).toContain("outputs/run-123/final_report.md");
    expect(paths).not.toContain("README.md");
    expect(paths).not.toContain("prompts/codex-transcript-prompt.md");
    expect(paths).not.toContain(
      "outputs/run-123/codex_chunks/chunk_001_pass1_prompt.md",
    );
    expect(paths).not.toContain("outputs/run-123/feishu_chunks/00_overview.md");

    const directPromptResponse = await routes.request(
      `/document?path=${encodeURIComponent(
        "outputs/run-123/codex_chunks/chunk_001_pass1_prompt.md",
      )}`,
    );
    expect(directPromptResponse.status).toBe(200);
    const directPromptJson =
      (await directPromptResponse.json()) as ReportDocumentResponse;
    expect(directPromptJson.content).toContain("Correct this transcript");
  });

  it("lists final Codex transcript markdown without chunk prompts", async () => {
    const transcriptDir = path.join(
      tempDir,
      "outputs",
      "bilibili_transcripts",
      "20260629-102253-bv1uhtu6teks-codex-cli",
    );
    await mkdir(path.join(transcriptDir, "codex_chunks"), { recursive: true });
    await writeFile(
      path.join(transcriptDir, "codex_corrected_speaker_turns.md"),
      "# Codex Transcript\n\n[00:00:00 - 00:00:01] Speaker 0\nHello",
    );
    await writeFile(
      path.join(transcriptDir, "codex_chunks", "chunk_001_pass1_prompt.md"),
      "# Codex Prompt\n\nInternal correction prompt",
    );

    const routes = createReportsRoutes({ reportsDir: tempDir });
    const response = await routes.request("/");

    expect(response.status).toBe(200);
    const json = (await response.json()) as ReportsListResponse;
    const paths = json.documents.map((doc) => doc.path);

    expect(paths).toContain(
      "outputs/bilibili_transcripts/20260629-102253-bv1uhtu6teks-codex-cli/codex_corrected_speaker_turns.md",
    );
    expect(paths).not.toContain(
      "outputs/bilibili_transcripts/20260629-102253-bv1uhtu6teks-codex-cli/codex_chunks/chunk_001_pass1_prompt.md",
    );

    const transcript = json.documents.find((doc) =>
      doc.path.endsWith("codex_corrected_speaker_turns.md"),
    );
    expect(transcript).toMatchObject({
      kind: "transcript",
      title: "20260629-102253-bv1uhtu6teks-codex-cli (Codex 校正版)",
    });
  });

  it("serves Bilibili transcript documents by relative path", async () => {
    const transcriptDir = path.join(
      tempDir,
      "outputs",
      "bilibili_transcripts",
      "20260629-102253-bv1uhtu6teks",
    );
    await mkdir(transcriptDir, { recursive: true });
    const correctedPath = path.join(
      transcriptDir,
      "deepseek_corrected_speaker_turns.txt",
    );
    await writeFile(correctedPath, "[00:00:00 - 00:00:01] Speaker 0\nHello");

    const routes = createReportsRoutes({ reportsDir: tempDir });
    const relativePath =
      "outputs/bilibili_transcripts/20260629-102253-bv1uhtu6teks/deepseek_corrected_speaker_turns.txt";
    const response = await routes.request(
      `/document?path=${encodeURIComponent(relativePath)}`,
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as ReportDocumentResponse;
    expect(json.metadata).toMatchObject({
      path: relativePath,
      absolutePath: correctedPath,
      kind: "transcript",
    });
    expect(json.content).toContain("Speaker 0");
    expect(json.renderedHtml).toContain("Speaker 0");
  });

  it("prefers markdown transcript files in the document list", async () => {
    const transcriptDir = path.join(
      tempDir,
      "outputs",
      "bilibili_transcripts",
      "20260629-102253-bv1uhtu6teks",
    );
    await mkdir(transcriptDir, { recursive: true });
    await writeFile(
      path.join(transcriptDir, "deepseek_corrected_speaker_turns.txt"),
      "plain transcript",
    );
    await writeFile(
      path.join(transcriptDir, "deepseek_corrected_speaker_turns.md"),
      "# Markdown Transcript\n\nplain transcript",
    );

    const routes = createReportsRoutes({ reportsDir: tempDir });
    const response = await routes.request("/");

    expect(response.status).toBe(200);
    const json = (await response.json()) as ReportsListResponse;
    const paths = json.documents.map((doc) => doc.path);
    expect(paths).toContain(
      "outputs/bilibili_transcripts/20260629-102253-bv1uhtu6teks/deepseek_corrected_speaker_turns.md",
    );
    expect(paths).not.toContain(
      "outputs/bilibili_transcripts/20260629-102253-bv1uhtu6teks/deepseek_corrected_speaker_turns.txt",
    );
  });

  it("uploads text reports into the reports upload directory", async () => {
    const routes = createReportsRoutes({ reportsDir: tempDir });
    const form = new FormData();
    form.set(
      "file",
      new File(["plain uploaded report"], "uploaded-report.txt", {
        type: "text/plain",
      }),
    );

    const uploadResponse = await routes.request("/upload", {
      method: "POST",
      body: form,
    });

    expect(uploadResponse.status).toBe(201);
    const uploadJson = (await uploadResponse.json()) as {
      document: { path: string; absolutePath: string; kind: string };
    };
    expect(uploadJson.document.path).toMatch(
      /^uploads\/[0-9a-f-]{36}_uploaded-report\.txt$/,
    );
    expect(uploadJson.document.absolutePath).toContain(
      path.join(tempDir, "uploads"),
    );
    expect(uploadJson.document.kind).toBe("text");

    const listResponse = await routes.request("/");
    const listJson = (await listResponse.json()) as ReportsListResponse;
    expect(listJson.documents.map((doc) => doc.path)).toContain(
      uploadJson.document.path,
    );

    const documentResponse = await routes.request(
      `/document?path=${encodeURIComponent(uploadJson.document.path)}`,
    );
    expect(documentResponse.status).toBe(200);
    const documentJson =
      (await documentResponse.json()) as ReportDocumentResponse;
    expect(documentJson.content).toBe("plain uploaded report");
  });

  it("renders and securely serves report-relative images", async () => {
    const researchDir = path.join(tempDir, "research");
    const assetsDir = path.join(researchDir, "assets");
    await mkdir(assetsDir, { recursive: true });
    await writeFile(
      path.join(researchDir, "image-report.md"),
      "# Image report\n\n![Benchmark chart](assets/chart.png)",
    );
    await writeFile(path.join(assetsDir, "chart.png"), Buffer.from([1, 2, 3]));
    const routes = createReportsRoutes({
      reportsDir: tempDir,
      basePath: "/yep",
    });

    const documentResponse = await routes.request(
      "/document?path=research%2Fimage-report.md",
    );
    expect(documentResponse.status).toBe(200);
    const documentJson =
      (await documentResponse.json()) as ReportDocumentResponse;
    expect(documentJson.renderedHtml).toContain(
      'src="/yep/api/reports/image?path=research%2Fimage-report.md&amp;image=assets%2Fchart.png"',
    );
    expect(documentJson.renderedHtml).toContain('alt="Benchmark chart"');

    const imageResponse = await routes.request(
      "/image?path=research%2Fimage-report.md&image=assets%2Fchart.png",
    );
    expect(imageResponse.status).toBe(200);
    expect(imageResponse.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await imageResponse.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );

    const traversalResponse = await routes.request(
      "/image?path=research%2Fimage-report.md&image=..%2F..%2Foutside.png",
    );
    expect(traversalResponse.status).toBe(404);
  });

  it("uploads report images into a report-specific assets directory", async () => {
    const researchDir = path.join(tempDir, "research");
    await mkdir(researchDir, { recursive: true });
    const reportPath = path.join(researchDir, "model-assessment.md");
    await writeFile(reportPath, "# Model assessment");
    const routes = createReportsRoutes({ reportsDir: tempDir });
    const form = new FormData();
    form.set("path", "research/model-assessment.md");
    form.set(
      "file",
      new File([new Uint8Array([4, 5, 6])], "benchmark #50%.png", {
        type: "image/png",
      }),
    );

    const uploadResponse = await routes.request("/images/upload", {
      method: "POST",
      body: form,
    });
    expect(uploadResponse.status).toBe(201);
    const uploaded = (await uploadResponse.json()) as ReportImageUploadResponse;
    expect(uploaded.path).toMatch(
      /^assets\/model-assessment\/[0-9a-f-]{36}_benchmark #50%\.png$/,
    );
    expect(uploaded.markdown).toMatch(
      /^!\[benchmark #50%\]\(assets\/model-assessment\/[0-9a-f-]{36}_benchmark%20%2350%25\.png\)$/,
    );
    expect(await readFile(path.join(researchDir, uploaded.path))).toEqual(
      Buffer.from([4, 5, 6]),
    );

    const imageResponse = await routes.request(
      `/image?path=${encodeURIComponent(
        "research/model-assessment.md",
      )}&image=${encodeURIComponent(uploaded.path)}`,
    );
    expect(imageResponse.status).toBe(200);

    await writeFile(reportPath, `# Model assessment\n\n${uploaded.markdown}`);
    const documentResponse = await routes.request(
      "/document?path=research%2Fmodel-assessment.md",
    );
    expect(documentResponse.status).toBe(200);
    const documentJson =
      (await documentResponse.json()) as ReportDocumentResponse;
    expect(documentJson.renderedHtml).toContain(
      `src="${uploaded.url.replaceAll("&", "&amp;")}"`,
    );
  });

  it("rejects unsupported report upload extensions", async () => {
    const routes = createReportsRoutes({ reportsDir: tempDir });
    const form = new FormData();
    form.set(
      "file",
      new File(["{}"], "report.json", { type: "application/json" }),
    );

    const response = await routes.request("/upload", {
      method: "POST",
      body: form,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Only .md, .markdown, and .txt reports are supported",
    });
  });

  it("applies the configured report upload size limit", async () => {
    const routes = createReportsRoutes({
      reportsDir: tempDir,
      maxUploadSizeBytes: 4,
    });
    const form = new FormData();
    form.set(
      "file",
      new File(["12345"], "report.md", { type: "text/markdown" }),
    );

    const response = await routes.request("/upload", {
      method: "POST",
      body: form,
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "File size exceeds maximum allowed size of 1MB",
    });
  });

  it("creates, loads, and edits persisted inline comments", async () => {
    const reportPath = path.join(tempDir, "report.md");
    const dataDir = path.join(tempDir, "app-data");
    const originalContent = "# Report\n\nAlpha beta gamma";
    await writeFile(reportPath, originalContent);
    const routes = createReportsRoutes({ reportsDir: tempDir, dataDir });

    const createResponse = await routes.request("/comments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: "report.md",
        anchor: {
          exact: "beta",
          prefix: "Alpha ",
          suffix: " gamma",
          start: 12,
          end: 16,
        },
        body: "Check this claim",
      }),
    });

    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as {
      comment: { id: string; body: string };
    };
    expect(created.comment.body).toBe("Check this claim");

    const documentResponse = await routes.request("/document?path=report.md");
    const documentJson =
      (await documentResponse.json()) as ReportDocumentResponse;
    expect(documentJson.comments).toHaveLength(1);
    expect(documentJson.comments[0]).toMatchObject({
      id: created.comment.id,
      reportPath: "report.md",
      body: "Check this claim",
    });

    const updateResponse = await routes.request(
      `/comments/${created.comment.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: "report.md",
          body: "Updated review note",
        }),
      },
    );
    expect(updateResponse.status).toBe(200);

    const reloadedRoutes = createReportsRoutes({
      reportsDir: tempDir,
      dataDir,
    });
    const reloadedResponse = await reloadedRoutes.request(
      "/document?path=report.md",
    );
    const reloadedJson =
      (await reloadedResponse.json()) as ReportDocumentResponse;
    expect(reloadedJson.comments[0]?.body).toBe("Updated review note");
    expect(await readFile(reportPath, "utf-8")).toBe(originalContent);
  });

  it("rejects absolute document paths", async () => {
    const routes = createReportsRoutes({ reportsDir: tempDir });
    const response = await routes.request(
      `/document?path=${encodeURIComponent(path.join(tempDir, "report.md"))}`,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid report path",
    });
  });
});
