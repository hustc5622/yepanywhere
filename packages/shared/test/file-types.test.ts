import { describe, expect, it } from "vitest";
import { withCanonicalFilePath } from "../src/file-tool-input.js";
import {
  classifyPreview,
  getFileExtension,
  getFileMimeType,
  getMediaPreviewKind,
  getPathBasename,
  isMarkdownFilePath,
  isPreviewLinkablePath,
  isTextFilePath,
} from "../src/file-types.js";
import { isLikelyFilePath } from "../src/filePathDetection.js";

describe("file types", () => {
  it("follows Node extname rules for extensions", () => {
    expect(getFileExtension("/a/b/File.TS")).toBe("ts");
    expect(getFileExtension("/a/.env")).toBe("");
    expect(getFileExtension("archive.tar.gz")).toBe("gz");
    expect(getFileExtension("C:\\work\\a.PNG")).toBe("png");
    expect(getPathBasename("/a/b/c.md/")).toBe("c.md");
  });

  it("classifies each preview kind", () => {
    expect(classifyPreview("notes.txt")).toBe("text");
    expect(classifyPreview("src/app.tsx")).toBe("text");
    expect(classifyPreview("data.csv")).toBe("text");
    expect(classifyPreview("README.md")).toBe("markdown");
    expect(classifyPreview("/tmp/pw/c-1.png")).toBe("image");
    expect(classifyPreview("logo.svg")).toBe("image");
    expect(classifyPreview("clip.mov")).toBe("video");
    expect(classifyPreview("voice.m4a")).toBe("audio");
    expect(classifyPreview("spec.pdf")).toBe("pdf");
    expect(classifyPreview("report.docx")).toBe("office");
    expect(classifyPreview("sheet.xlsx")).toBe("office");
    expect(classifyPreview("bundle.zip")).toBe("binary");
    expect(classifyPreview("unknown.xyz")).toBe("binary");
  });

  it("uses a sniffed MIME type only for unknown extensions", () => {
    expect(classifyPreview("blob-123", "image/png")).toBe("image");
    expect(classifyPreview("notes.txt", "image/png")).toBe("text");
  });

  it("treats extensionless well-known files and dotfiles as text", () => {
    expect(isTextFilePath("/repo/Dockerfile")).toBe(true);
    expect(isTextFilePath("/repo/.gitignore")).toBe(true);
    expect(isTextFilePath("/repo/.env")).toBe(true);
    expect(isTextFilePath("/repo/random-binary")).toBe(false);
  });

  it("keeps SVG both an image and inline text", () => {
    expect(isTextFilePath("a.svg")).toBe(true);
    expect(getFileMimeType("a.svg")).toBe("image/svg+xml");
    expect(getMediaPreviewKind("a.svg")).toBe("image");
  });

  it("limits local media kinds to image and video", () => {
    expect(getMediaPreviewKind("a.webm")).toBe("video");
    expect(getMediaPreviewKind("a.mp3")).toBeNull();
    expect(getMediaPreviewKind("a.pdf")).toBeNull();
  });

  it("returns MIME types with an octet-stream fallback", () => {
    expect(getFileMimeType("a.json")).toBe("application/json");
    expect(getFileMimeType("a.JPG")).toBe("image/jpeg");
    expect(getFileMimeType("a.unknown")).toBe("application/octet-stream");
  });

  it("detects markdown including mdx", () => {
    expect(isMarkdownFilePath("docs/a.markdown")).toBe(true);
    expect(isMarkdownFilePath("docs/a.mdx")).toBe(true);
    expect(isMarkdownFilePath("docs/a.txt")).toBe(false);
  });

  it("feeds path detection from the same table", () => {
    expect(isLikelyFilePath("/Users/me/Downloads/report.pdf")).toBe(true);
    expect(isLikelyFilePath("/tmp/plan.docx")).toBe(true);
    expect(isLikelyFilePath("/tmp/voice.mp3")).toBe(true);
    expect(isLikelyFilePath("example.com")).toBe(false);
  });
});

describe("isPreviewLinkablePath", () => {
  it("links absolute paths with an extension", () => {
    expect(isPreviewLinkablePath("/tmp/x.log")).toBe(true);
    expect(isPreviewLinkablePath("/usr/bin/node")).toBe(false);
    expect(isPreviewLinkablePath("//cdn/x.js")).toBe(false);
  });

  it("links relative paths only with a directory and a known type", () => {
    expect(isPreviewLinkablePath("packages/client/src/a.ts")).toBe(true);
    expect(isPreviewLinkablePath("./docs/plan.md")).toBe(true);
    expect(isPreviewLinkablePath("README.md")).toBe(false);
    expect(isPreviewLinkablePath("src/utils")).toBe(false);
    expect(isPreviewLinkablePath("and/or")).toBe(false);
    expect(isPreviewLinkablePath("~/notes.md")).toBe(false);
  });
});

describe("withCanonicalFilePath", () => {
  it("copies provider aliases into file_path and keeps native fields", () => {
    expect(withCanonicalFilePath({ path: "/a.ts" })).toEqual({
      path: "/a.ts",
      file_path: "/a.ts",
    });
    expect(withCanonicalFilePath({ filePath: "b.ts" })).toMatchObject({
      file_path: "b.ts",
    });
  });

  it("keeps an existing file_path and falls back to ACP locations", () => {
    expect(
      withCanonicalFilePath({ file_path: "/x", path: "/y" }).file_path,
    ).toBe("/x");
    expect(
      withCanonicalFilePath({}, [{ path: "/from/location.ts", line: 3 }]),
    ).toEqual({ file_path: "/from/location.ts" });
    expect(withCanonicalFilePath({ command: "ls" })).toEqual({
      command: "ls",
    });
  });
});
