import { Hono } from "hono";
import { readCodexImageSnapshot } from "../sessions/codex-image-reader.js";
import { CodexRolloutScanError } from "../sessions/codex-rollout-file.js";

interface CodexImageDeps {
  resolveSessionFile: (sessionId: string) => Promise<string | null>;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export function createCodexImageRoutes(deps: CodexImageDeps): Hono {
  const routes = new Hono();
  routes.get("/:sessionId/codex-images/:itemId", async (c) => {
    // An unavailable live response can become available on the next request.
    c.header("Cache-Control", "private, no-store");
    const { sessionId, itemId } = c.req.param();
    if (!ID.test(sessionId) || !ID.test(itemId)) {
      return c.json({ error: "Invalid session or image call ID" }, 400);
    }
    const filePath = await deps.resolveSessionFile(sessionId);
    if (!filePath) return c.json({ error: "Session not found" }, 404);
    try {
      const url = await readCodexImageSnapshot(filePath, itemId);
      // Only render inline raster images; never fetch arbitrary recorded URLs.
      const match = url?.match(
        /^data:(image\/(?:png|jpeg|gif|webp)|application\/octet-stream);base64,/,
      );
      if (!url || !match) {
        return c.json(
          { error: "Recorded image unavailable or ambiguous" },
          404,
        );
      }
      const bytes = Buffer.from(url.slice(match[0].length), "base64");
      c.header("X-Content-Type-Options", "nosniff");
      c.header("Content-Type", match[1] ?? "application/octet-stream");
      return c.body(bytes);
    } catch (error) {
      if (error instanceof CodexRolloutScanError) {
        return c.json({ error: "Recorded image scan limit exceeded" }, 413);
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return c.json({ error: "Session not found" }, 404);
      }
      throw error;
    }
  });
  return routes;
}
