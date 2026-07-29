import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexOSSProvider } from "../../../src/sdk/providers/codex-oss.js";
import { setOllamaUrl } from "../../../src/sdk/providers/ollama-client.js";

describe("CodexOSSProvider", () => {
  afterEach(() => {
    setOllamaUrl();
  });

  it("passes the configured Ollama endpoint to first and resumed turns", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codex-oss-endpoint-"));
    const capturePath = join(tempDir, "capture.jsonl");
    const fakeCodexPath = join(tempDir, "fake-codex.js");
    writeFileSync(
      fakeCodexPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.CODEX_OSS_CAPTURE, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv[3] === "resume") {
  process.stdout.write("codex\\nresumed answer\\n");
} else {
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-local" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }) + "\\n");
}
`,
    );
    chmodSync(fakeCodexPath, 0o755);
    const previousCapture = process.env.CODEX_OSS_CAPTURE;
    process.env.CODEX_OSS_CAPTURE = capturePath;
    setOllamaUrl("https://ollama.example.test/custom/");

    const provider = new CodexOSSProvider({ codexPath: fakeCodexPath });
    const session = await provider.startSession({
      cwd: tempDir,
      initialMessage: { text: "first" },
    });

    try {
      for await (const message of session.iterator) {
        if (message.type !== "result") continue;
        const captures = readFileSync(capturePath, "utf-8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[]);
        if (captures.length === 1) {
          session.queue.push({ text: "second" });
          continue;
        }

        expect(captures[0]).toContain(
          'model_providers.ollama.base_url="https://ollama.example.test/custom"',
        );
        expect(captures[1]).toContain(
          'model_providers.ollama.base_url="https://ollama.example.test/custom"',
        );
        break;
      }
    } finally {
      session.abort();
      if (previousCapture === undefined) {
        process.env.CODEX_OSS_CAPTURE = undefined;
      } else {
        process.env.CODEX_OSS_CAPTURE = previousCapture;
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
