import type { Plugin } from "vite";

const LINK_TAG_PATTERN = /<link\b[^>]*>/gi;
const REL_ATTRIBUTE_PATTERN = /\brel\s*=\s*(["'])([^"']*)\1/i;
const HREF_ATTRIBUTE_PATTERN = /\bhref\s*=\s*(["'])([^"']*)\1/i;

function isIconRelationship(rel: string): boolean {
  return rel
    .toLowerCase()
    .split(/\s+/)
    .some((token) => token === "icon" || token.endsWith("-icon"));
}

function versionLocalUrl(url: string, buildId: string): string {
  if (/^(?:data:|https?:|\/\/)/i.test(url)) return url;

  const hashIndex = url.indexOf("#");
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : "";
  const withoutHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const queryIndex = withoutHash.indexOf("?");
  const pathname =
    queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
  const search = queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : "";
  const params = new URLSearchParams(search);
  params.set("v", buildId);

  return `${pathname}?${params.toString()}${hash}`;
}

/** Add a build-specific URL to icon links so browsers retry after a deploy. */
export function versionFaviconLinks(html: string, buildId: string): string {
  if (!buildId.trim()) {
    throw new Error("A non-empty build id is required for favicon versioning");
  }

  return html.replace(LINK_TAG_PATTERN, (tag) => {
    const rel = tag.match(REL_ATTRIBUTE_PATTERN)?.[2];
    if (!rel || !isIconRelationship(rel)) return tag;

    return tag.replace(
      HREF_ATTRIBUTE_PATTERN,
      (attribute, quote: string, href: string) => {
        const versionedHref = versionLocalUrl(href, buildId);
        if (versionedHref === href) return attribute;
        return `href=${quote}${versionedHref}${quote}`;
      },
    );
  });
}

export function faviconVersionPlugin(buildId: string): Plugin {
  return {
    name: "vite-plugin-favicon-version",
    transformIndexHtml: {
      // Vite has already applied BASE_PATH when this hook runs.
      order: "post",
      handler(html) {
        return versionFaviconLinks(html, buildId);
      },
    },
  };
}
