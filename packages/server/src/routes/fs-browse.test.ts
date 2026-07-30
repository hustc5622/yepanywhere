import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFsBrowseRoutes } from "./fs-browse.js";

describe("createFsBrowseRoutes", () => {
  let tmp: string;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "fs-browse-"));
    await mkdir(join(tmp, "alpha"));
    await mkdir(join(tmp, "beta"));
    await mkdir(join(tmp, ".hidden"));
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("falls back to home directory when no path is given", async () => {
    const app = createFsBrowseRoutes();
    const res = await app.request("/browse");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      path: string;
      parent: string | null;
      entries: { name: string; isDirectory: boolean }[];
    };
    expect(body.entries.every((e) => e.isDirectory)).toBe(true);
  });

  it("lists only directories (not files) in the target dir", async () => {
    const app = createFsBrowseRoutes();
    const res = await app.request(`/browse?path=${encodeURIComponent(tmp)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      path: string;
      entries: { name: string; isDirectory: boolean }[];
    };
    expect(body.path).toBe(tmp);
    const names = body.entries
      .map((e) => e.name)
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    expect(names).toEqual([".hidden", "alpha", "beta"]);
  });

  it("rejects non-absolute paths with 400", async () => {
    const app = createFsBrowseRoutes();
    const res = await app.request("/browse?path=relative/path");
    expect(res.status).toBe(400);
  });

  it("returns parent path for a nested directory", async () => {
    const app = createFsBrowseRoutes();
    const res = await app.request(
      `/browse?path=${encodeURIComponent(join(tmp, "alpha"))}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { parent: string | null };
    expect(body.parent).toBe(tmp);
  });

  it("reports an error (not 500) when directory is unreadable", async () => {
    const app = createFsBrowseRoutes();
    const res = await app.request("/browse?path=/proc/this-should-not-list");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { error?: string };
    expect(typeof body.error).toBe("string");
  });
});
