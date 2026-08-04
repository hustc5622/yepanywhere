import { describe, expect, it } from "vitest";
import { versionFaviconLinks } from "./vite-plugin-favicon-version";

describe("versionFaviconLinks", () => {
  it("versions local favicon links and leaves the manifest unchanged", () => {
    const html = `
      <link rel="icon" href="/yep/favicon.ico" sizes="48x48" />
      <link href='/yep/icon-192.png?purpose=app' rel='apple-touch-icon' />
      <link rel="manifest" href="/yep/manifest.json" />
    `;

    const versioned = versionFaviconLinks(html, "0.4.29-abc123");

    expect(versioned).toContain(
      'rel="icon" href="/yep/favicon.ico?v=0.4.29-abc123"',
    );
    expect(versioned).toContain(
      "href='/yep/icon-192.png?purpose=app&v=0.4.29-abc123' rel='apple-touch-icon'",
    );
    expect(versioned).toContain(
      '<link rel="manifest" href="/yep/manifest.json" />',
    );
  });

  it("replaces an existing build id instead of appending duplicates", () => {
    const once = versionFaviconLinks(
      '<link rel="icon" href="/favicon.ico?v=old#icon" />',
      "new",
    );
    const twice = versionFaviconLinks(once, "new");

    expect(twice).toBe('<link rel="icon" href="/favicon.ico?v=new#icon" />');
  });

  it("does not rewrite externally hosted icons", () => {
    const html =
      '<link rel="icon" href="https://cdn.example.com/favicon.ico" />';

    expect(versionFaviconLinks(html, "build-1")).toBe(html);
  });
});
