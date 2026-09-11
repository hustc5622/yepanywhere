import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";

describe("native Feishu MCP distribution resources", () => {
  it("initializes and forwards a tool call through an isolated local server", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yep-native-mcp-"));
    const requests: unknown[] = [];
    const server = createServer(async (req, res) => {
      expect(req.headers.authorization).toBe("Bearer fixture-credential");
      expect(req.headers["x-yep-anywhere"]).toBe("true");
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({ content: [{ type: "text", text: "native result" }] }),
      );
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture");
    const config = join(directory, "connector.json");
    await writeFile(
      config,
      JSON.stringify({
        serverUrl: `http://127.0.0.1:${address.port}`,
        token: "fixture-credential",
      }),
    );
    const child = spawn(
      process.execPath,
      [resolve("resources/feishu/connector.mjs"), config],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const lines = createInterface({ input: child.stdout });
    try {
      const pending = new Map<
        number,
        (value: Record<string, unknown>) => void
      >();
      lines.on("line", (line) => {
        const response = JSON.parse(line);
        pending.get(response.id)?.(response);
      });
      const call = (id: number, method: string, params?: unknown) =>
        new Promise<Record<string, unknown>>((done) => {
          pending.set(id, done);
          child.stdin.write(
            `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
          );
        });
      expect(await call(1, "initialize")).toMatchObject({
        result: { serverInfo: { name: "yep-feishu" } },
      });
      expect(
        await call(2, "tools/call", {
          name: "lark_fetch_doc",
          arguments: { doc_id: "document" },
        }),
      ).toMatchObject({ result: { content: [{ text: "native result" }] } });
      expect(requests).toHaveLength(1);
      const source = await readFile(
        resolve("resources/feishu/connector.mjs"),
        "utf8",
      );
      expect(source).not.toMatch(/MLB_WORKSPACE|MLB Manager|tokens\.json/);
    } finally {
      lines.close();
      child.stdin.end();
      child.kill();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("replaces only the two legacy MCP tables and their children", async () => {
    const module = await import(
      "../../../resources/feishu/configure-codex.mjs"
    );
    const before =
      '[mcp_servers.lark]\ncommand = "old"\n[mcp_servers.lark.env]\nLARK_APP_SECRET = "old-secret"\n[mcp_servers.chrome]\ncommand = "chrome"\n[mcp_servers."feishu-mcp"]\nurl = "https://old.test"\n[projects."/work"]\ntrust_level = "trusted"\n';
    const after = module.replaceLarkConfig(before, "node", [
      "/yep/connector.mjs",
      "/yep/client.json",
    ]);
    expect(after).toContain('[mcp_servers.chrome]\ncommand = "chrome"');
    expect(after).toContain('[projects."/work"]');
    expect(after).not.toContain("old-secret");
    expect(after).not.toContain("https://old.test");
    expect(after.match(/\[mcp_servers.yep-feishu\]/g)).toHaveLength(1);
  });
});
