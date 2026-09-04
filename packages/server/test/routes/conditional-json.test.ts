import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  conditionalJson,
  matchesIfNoneMatch,
} from "../../src/routes/conditional-json.js";

function createRoutes(payload: () => unknown): Hono {
  const app = new Hono();
  app.get("/thing", (c) => conditionalJson(c, payload()));
  return app;
}

describe("conditionalJson", () => {
  it("emits a revalidatable validator on the first response", async () => {
    const routes = createRoutes(() => ({ a: 1 }));

    const response = await routes.request("/thing");

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toMatch(/^W\/"/);
    // `no-cache` (not `no-store`) is what lets the browser keep the body and
    // revalidate it into a 304 on the next visit.
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    expect(await response.json()).toEqual({ a: 1 });
  });

  it("answers 304 with no body when the client copy is current", async () => {
    const routes = createRoutes(() => ({ a: 1 }));

    const first = await routes.request("/thing");
    const etag = first.headers.get("etag") as string;

    const second = await routes.request("/thing", {
      headers: { "If-None-Match": etag },
    });

    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
    expect(second.headers.get("etag")).toBe(etag);
  });

  it("returns a full body once the payload changes", async () => {
    let counter = 1;
    const routes = createRoutes(() => ({ a: counter }));

    const first = await routes.request("/thing");
    const etag = first.headers.get("etag") as string;

    counter = 2;
    const second = await routes.request("/thing", {
      headers: { "If-None-Match": etag },
    });

    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ a: 2 });
    expect(second.headers.get("etag")).not.toBe(etag);
  });

  it("preserves headers set earlier in the handler", async () => {
    const app = new Hono();
    app.get("/thing", (c) => {
      c.header("Server-Timing", "pageRead;dur=1.0");
      return conditionalJson(c, { a: 1 });
    });

    const response = await app.request("/thing");

    expect(response.headers.get("server-timing")).toBe("pageRead;dur=1.0");
    expect(response.headers.get("etag")).toBeTruthy();
  });
});

describe("matchesIfNoneMatch", () => {
  it("compares weakly and supports lists and wildcards", () => {
    expect(matchesIfNoneMatch('W/"abc"', 'W/"abc"')).toBe(true);
    // Weak comparison ignores the W/ prefix on either side (RFC 9110 §13.1.2).
    expect(matchesIfNoneMatch('"abc"', 'W/"abc"')).toBe(true);
    expect(matchesIfNoneMatch('W/"abc", W/"def"', 'W/"def"')).toBe(true);
    expect(matchesIfNoneMatch("*", 'W/"abc"')).toBe(true);
    expect(matchesIfNoneMatch('W/"other"', 'W/"abc"')).toBe(false);
    expect(matchesIfNoneMatch(undefined, 'W/"abc"')).toBe(false);
  });
});
