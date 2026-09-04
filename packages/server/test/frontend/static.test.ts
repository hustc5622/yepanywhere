import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { brotliCompress, gunzipSync, gzip } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createStaticRoutes,
  negotiateEncoding,
} from "../../src/frontend/static.js";

const gzipAsync = promisify(gzip);
const brotliCompressAsync = promisify(brotliCompress);

/** Large enough to clear the 1 KB compression threshold. */
const BIG_JS = `console.log(${JSON.stringify("x".repeat(4096))});`;

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

    const response = await routes.request("/yep/sessions");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors",
    );
  });

  describe("content coding negotiation", () => {
    it("prefers brotli, falls back to gzip, and honours q=0", () => {
      expect(negotiateEncoding("gzip, deflate, br")).toBe("br");
      expect(negotiateEncoding("gzip, deflate")).toBe("gzip");
      expect(negotiateEncoding("br;q=0, gzip")).toBe("gzip");
      expect(negotiateEncoding("gzip;q=0")).toBe("identity");
      expect(negotiateEncoding("*")).toBe("br");
      expect(negotiateEncoding("")).toBe("identity");
      expect(negotiateEncoding("identity")).toBe("identity");
    });

    it("compresses assets on demand and keeps the payload decodable", async () => {
      await writeFile(path.join(tempDir, "assets", "app-CREDb_As.js"), BIG_JS);

      const routes = createStaticRoutes({ distPath: tempDir });
      const response = await routes.request("/assets/app-CREDb_As.js", {
        headers: { "Accept-Encoding": "gzip" },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-encoding")).toBe("gzip");
      expect(response.headers.get("vary")).toBe("Accept-Encoding");

      const body = Buffer.from(await response.arrayBuffer());
      expect(body.byteLength).toBeLessThan(BIG_JS.length);
      expect(gunzipSync(body).toString("utf-8")).toBe(BIG_JS);
    });

    it("leaves the payload alone when the client accepts nothing", async () => {
      await writeFile(path.join(tempDir, "assets", "app-CREDb_As.js"), BIG_JS);

      const routes = createStaticRoutes({ distPath: tempDir });
      const response = await routes.request("/assets/app-CREDb_As.js");

      expect(response.status).toBe(200);
      expect(response.headers.has("content-encoding")).toBe(false);
      expect(await response.text()).toBe(BIG_JS);
    });

    it("does not compress already-compressed media", async () => {
      const png = Buffer.alloc(2048, 7);
      await writeFile(path.join(tempDir, "assets", "pic-CREDb_As.png"), png);

      const routes = createStaticRoutes({ distPath: tempDir });
      const response = await routes.request("/assets/pic-CREDb_As.png", {
        headers: { "Accept-Encoding": "br, gzip" },
      });

      expect(response.status).toBe(200);
      expect(response.headers.has("content-encoding")).toBe(false);
      expect(response.headers.get("content-type")).toBe("image/png");
    });

    it("skips payloads below the compression threshold", async () => {
      await writeFile(path.join(tempDir, "assets", "tiny-CREDb_As.js"), "x=1;");

      const routes = createStaticRoutes({ distPath: tempDir });
      const response = await routes.request("/assets/tiny-CREDb_As.js", {
        headers: { "Accept-Encoding": "br, gzip" },
      });

      expect(response.headers.has("content-encoding")).toBe(false);
    });

    it("serves build-time precompressed siblings when present", async () => {
      const source = path.join(tempDir, "assets", "pre-CREDb_As.js");
      await writeFile(source, BIG_JS);
      // A distinguishable payload proves the sibling was used rather than a
      // fresh on-demand compression of the source.
      const marker = `${BIG_JS}//precompressed`;
      await writeFile(`${source}.gz`, await gzipAsync(Buffer.from(marker)));
      await writeFile(
        `${source}.br`,
        await brotliCompressAsync(Buffer.from(marker)),
      );

      const routes = createStaticRoutes({ distPath: tempDir });
      const response = await routes.request("/assets/pre-CREDb_As.js", {
        headers: { "Accept-Encoding": "gzip" },
      });

      expect(response.headers.get("content-encoding")).toBe("gzip");
      const body = Buffer.from(await response.arrayBuffer());
      expect(gunzipSync(body).toString("utf-8")).toBe(marker);
    });
  });

  describe("conditional requests", () => {
    it("answers 304 for a matching asset validator", async () => {
      await writeFile(path.join(tempDir, "assets", "app-CREDb_As.js"), BIG_JS);

      const routes = createStaticRoutes({ distPath: tempDir });
      const first = await routes.request("/assets/app-CREDb_As.js", {
        headers: { "Accept-Encoding": "gzip" },
      });
      const etag = first.headers.get("etag");
      expect(etag).toBeTruthy();

      const second = await routes.request("/assets/app-CREDb_As.js", {
        headers: { "Accept-Encoding": "gzip", "If-None-Match": etag as string },
      });

      expect(second.status).toBe(304);
      expect(await second.text()).toBe("");
      // A 304 must not claim a coding for a body it does not send.
      expect(second.headers.has("content-encoding")).toBe(false);
    });

    it("keeps validators distinct per content coding", async () => {
      await writeFile(path.join(tempDir, "assets", "app-CREDb_As.js"), BIG_JS);

      const routes = createStaticRoutes({ distPath: tempDir });
      const gzipped = await routes.request("/assets/app-CREDb_As.js", {
        headers: { "Accept-Encoding": "gzip" },
      });
      const identity = await routes.request("/assets/app-CREDb_As.js");

      expect(gzipped.headers.get("etag")).not.toBe(
        identity.headers.get("etag"),
      );

      // A gzip validator must not satisfy an identity request, otherwise a
      // client that cannot decode gzip would be told its copy is current.
      const crossed = await routes.request("/assets/app-CREDb_As.js", {
        headers: { "If-None-Match": gzipped.headers.get("etag") as string },
      });
      expect(crossed.status).toBe(200);
    });

    it("answers 304 for the SPA shell so navigations skip the body", async () => {
      const routes = createStaticRoutes({
        distPath: tempDir,
        basePath: "/yep",
      });

      const first = await routes.request("/yep/sessions");
      const etag = first.headers.get("etag");
      expect(etag).toBeTruthy();

      const second = await routes.request("/yep/sessions", {
        headers: { "If-None-Match": etag as string },
      });
      expect(second.status).toBe(304);
      expect(await second.text()).toBe("");

      // A rebuilt shell must invalidate the cached copy.
      await writeFile(path.join(tempDir, "index.html"), "<div>rebuilt</div>");
      const third = await routes.request("/yep/sessions", {
        headers: { "If-None-Match": etag as string },
      });
      expect(third.status).toBe(200);
      expect(await third.text()).toContain("rebuilt");
    });
  });

  it("types the PWA manifest so it is parseable and compressible", async () => {
    await writeFile(
      path.join(tempDir, "site.webmanifest"),
      JSON.stringify({ name: "yep" }),
    );

    const routes = createStaticRoutes({ distPath: tempDir });
    const response = await routes.request("/site.webmanifest");

    expect(response.headers.get("content-type")).toBe(
      "application/manifest+json",
    );
  });
});
