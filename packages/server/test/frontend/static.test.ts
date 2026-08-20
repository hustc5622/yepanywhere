import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStaticRoutes } from "../../src/frontend/static.js";

describe("static frontend routes", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "yep-static-"));
    await mkdir(path.join(tempDir, "assets"), { recursive: true });
    await writeFile(path.join(tempDir, "index.html"), "<div>app</div>");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("serves Vite hashed assets with long browser and CDN cache headers", async () => {
    await writeFile(
      path.join(tempDir, "assets", "index-CREDb_As.js"),
      "console.log('app');",
    );

    const routes = createStaticRoutes({
      distPath: tempDir,
      basePath: "/yep",
    });

    const response = await routes.request("/yep/assets/index-CREDb_As.js");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(response.headers.get("cdn-cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(response.headers.get("content-type")).toBe(
      "application/javascript; charset=utf-8",
    );
  });

  it("keeps non-hashed assets revalidated", async () => {
    await writeFile(path.join(tempDir, "assets", "logo.svg"), "<svg></svg>");

    const routes = createStaticRoutes({
      distPath: tempDir,
      basePath: "/yep",
    });

    const response = await routes.request("/yep/assets/logo.svg");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=0, must-revalidate",
    );
    expect(response.headers.has("cdn-cache-control")).toBe(false);
    expect(response.headers.has("cloudflare-cdn-cache-control")).toBe(false);
  });

  it("serves the SPA shell without long caching", async () => {
    const routes = createStaticRoutes({
      distPath: tempDir,
      basePath: "/yep",
    });

    const response = await routes.request("/yep/sessions", {
      headers: { Accept: "text/html" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors",
    );
  });

  it("returns 404 for missing explicit assets and API routes", async () => {
    const routes = createStaticRoutes({
      distPath: tempDir,
      basePath: "/yep",
    });

    const missingAsset = await routes.request(
      "/yep/assets/missing-deadbeef.js",
      {
        headers: { Accept: "text/html,application/xhtml+xml" },
      },
    );
    expect(missingAsset.status).toBe(404);
    expect(missingAsset.headers.get("content-type")).toContain("text/plain");
    expect(missingAsset.headers.get("cache-control")).toBe("no-store");

    const missingApi = await routes.request("/yep/api/missing", {
      headers: { Accept: "text/html" },
    });
    expect(missingApi.status).toBe(404);
    expect(missingApi.headers.get("cache-control")).toBe("no-store");
  });

  it.each(["styles.css", "font.woff2", "manifest.json"])(
    "returns 404 for a missing %s request",
    async (filename) => {
      const routes = createStaticRoutes({
        distPath: tempDir,
        basePath: "/yep",
      });

      const response = await routes.request(`/yep/${filename}`, {
        headers: { Accept: "text/html" },
      });

      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
    },
  );

  it("only falls back to the SPA shell for HTML navigations", async () => {
    const routes = createStaticRoutes({
      distPath: tempDir,
      basePath: "/yep",
    });

    const navigation = await routes.request("/yep/projects/project-1", {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    expect(navigation.status).toBe(200);
    expect(await navigation.text()).toContain("<div>app</div>");

    const nonHtmlNavigation = await routes.request("/yep/projects/project-1", {
      headers: { Accept: "application/json" },
    });
    expect(nonHtmlNavigation.status).toBe(404);
  });
});
