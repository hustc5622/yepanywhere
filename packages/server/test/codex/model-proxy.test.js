import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  configArguments,
  describeLaunchFailure,
  isolateProtocolStdio,
  launch,
  readLaunchContext,
  routedArguments,
} from "../../resources/codex-model-proxy/launcher.mjs";
import {
  directEnvironment,
  selectOpenAiBase,
  startModelRelay,
} from "../../resources/codex-model-proxy/relay.mjs";
import { ensureSelfSignedCertificate } from "../../src/https/self-signed.ts";

describe("model-only proxy routing", () => {
  let directory;
  let upstream;
  let proxy;
  let relay;
  let cert;
  let wsServer;
  let received;
  let tunnels;
  let proxyPorts;
  let sockets;
  let rejectTunnel;

  async function listen(server) {
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return server.address().port;
  }

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "yep-model-route-"));
    const certificate = ensureSelfSignedCertificate({
      dataDir: directory,
      host: "localhost",
    });
    cert = certificate.cert;
    received = [];
    tunnels = [];
    proxyPorts = new Set();
    sockets = new Set();
    rejectTunnel = false;
    upstream = https.createServer(
      { key: certificate.key, cert },
      (req, res) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
          received.push({
            url: req.url,
            headers: req.headers,
            body: Buffer.concat(chunks),
            remote: proxyPorts.has(req.socket.remotePort),
          });
          if (req.url.endsWith("?redirect")) {
            res
              .writeHead(307, {
                location: "https://api.openai.com/v1/responses",
              })
              .end();
            return;
          }
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "x-upstream": "preserved",
          });
          res.write("data: first\n\n");
          if (req.url.endsWith("?hold")) return;
          setTimeout(() => res.end("data: last\n\n"), 30);
        });
      },
    );
    wsServer = new WebSocketServer({ noServer: true });
    upstream.on("upgrade", (req, socket, head) => {
      received.push({
        url: req.url,
        remote: proxyPorts.has(socket.remotePort),
        headers: req.headers,
      });
      if (req.url.endsWith("?redirect")) {
        socket.end(
          `HTTP/1.1 302 Found\r\nLocation: ${relay.baseUrl.replace("http:", "ws:")}/tool-stream\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
        );
        return;
      }
      wsServer.handleUpgrade(req, socket, head, (ws) =>
        ws.on("message", (message) => ws.send(message)),
      );
    });
    const port = await listen(upstream);
    proxy = http.createServer((_req, res) => res.writeHead(500).end());
    proxy.on("connect", (req, socket, head) => {
      tunnels.push({
        target: req.url,
        authorization: req.headers["proxy-authorization"],
      });
      if (rejectTunnel) {
        socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      const connection = net.connect(port, "127.0.0.1", () => {
        proxyPorts.add(connection.localPort);
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) connection.write(head);
        socket.pipe(connection).pipe(socket);
      });
      sockets.add(connection);
      connection.on("error", () => socket.destroy());
      socket.on("error", () => connection.destroy());
      socket.on("close", () => connection.destroy());
      connection.on("close", () => {
        sockets.delete(connection);
        socket.destroy();
      });
    });
    const proxyPort = await listen(proxy);
    relay = await startModelRelay({
      upstreamBase: `https://localhost:${port}/backend-api/codex`,
      proxyUrl: `http://test-user:test-password@127.0.0.1:${proxyPort}`,
      ca: cert,
    });
  });

  afterEach(async () => {
    await relay?.close();
    for (const socket of sockets) socket.destroy();
    wsServer?.close();
    await Promise.all(
      [upstream, proxy].map(
        (server) => new Promise((resolve) => server.close(resolve)),
      ),
    );
    rmSync(directory, { recursive: true, force: true });
  });

  function request(path, method = "GET", body = Buffer.alloc(0)) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        `${relay.baseUrl}${path}`,
        {
          method,
          headers: {
            authorization: "Bearer model-test-token",
            "content-encoding": "zstd",
            "content-length": body.length,
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: Buffer.concat(chunks).toString(),
              chunks,
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  }

  it("tunnels only inference operations and preserves streaming, headers and opaque bodies", async () => {
    const body = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 1, 2]);
    const result = await request("/responses?trace=1", "POST", body);
    expect(result.status).toBe(200);
    expect(result.headers["x-upstream"]).toBe("preserved");
    expect(result.chunks).toHaveLength(2);
    expect(received[0]).toMatchObject({
      remote: true,
      body,
      url: "/backend-api/codex/responses?trace=1",
    });
    expect(received[0].headers.authorization).toBe("Bearer model-test-token");
    expect(received[0].headers["proxy-authorization"]).toBeUndefined();
    expect(tunnels[0].authorization).toBe(
      `Basic ${Buffer.from("test-user:test-password").toString("base64")}`,
    );
    await request("/responses/compact", "POST");
    await request("/memories/trace_summarize", "POST");
    expect(received.every((item) => item.remote)).toBe(true);
  });

  it("keeps model lists and tool endpoints direct even on the same OpenAI origin", async () => {
    await request("/models");
    await request("/alpha/search", "POST");
    await request("/responses", "GET");
    expect(tunnels).toHaveLength(0);
    expect(received.every((item) => !item.remote)).toBe(true);
  });

  it("preserves WebSocket frames and routes only the Responses upgrade remotely", async () => {
    for (const [path, remote] of [
      ["/responses", true],
      ["/tool-stream", false],
    ]) {
      const ws = new WebSocket(
        `${relay.baseUrl.replace("http:", "ws:")}${path}`,
      );
      await once(ws, "open");
      ws.send(Buffer.from([0, 255, 1]));
      const [message] = await once(ws, "message");
      expect(message).toEqual(Buffer.from([0, 255, 1]));
      expect(received.at(-1).remote).toBe(remote);
      ws.close();
      await once(ws, "close");
    }
  });

  it("does not fall back to direct inference when the remote proxy fails", async () => {
    rejectTunnel = true;
    const result = await request("/responses", "POST");
    expect(result.status).toBe(502);
    expect(received).toHaveLength(0);
    expect(result.body).not.toContain("test-password");
    expect((await request("/models")).status).toBe(200);
    expect(received[0].remote).toBe(false);
  });

  it("rejects model redirects so Codex cannot follow them outside the model relay", async () => {
    const result = await request("/responses?redirect", "POST");
    expect(result.status).toBe(502);
    expect(result.headers.location).toBeUndefined();
    expect(received).toHaveLength(1);
    expect(received[0].remote).toBe(true);
  });

  it("also blocks WebSocket redirects when the client enables redirect following", async () => {
    const ws = new WebSocket(
      `${relay.baseUrl.replace("http:", "ws:")}/responses?redirect`,
      { followRedirects: true },
    );
    const closed = new Promise((resolve) => ws.once("close", resolve));
    await once(ws, "error");
    await closed;
    expect(received).toHaveLength(1);
    expect(received[0].remote).toBe(true);
  });

  it("closes the upstream stream when the consumer cancels", async () => {
    let resolveClosed;
    const closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    upstream.once("request", (_req, res) => res.once("close", resolveClosed));
    const req = http.request(
      `${relay.baseUrl}/responses?hold`,
      { method: "POST" },
      (res) => {
        res.once("data", () => res.destroy());
      },
    );
    req.end();
    await closed;
    expect(received[0].remote).toBe(true);
  });

  it("rejects unrelated destinations instead of becoming a general forwarding proxy", async () => {
    expect((await request("/../../mcp", "POST")).status).toBe(404);
    expect(tunnels).toHaveLength(0);
    expect(received).toHaveLength(0);
  });

  it("gives tool subprocesses a direct environment, including previously unknown MCP hosts", async () => {
    const env = directEnvironment({
      ...process.env,
      HTTP_PROXY: "http://remote.invalid",
      https_proxy: "http://remote.invalid",
      ALL_PROXY: "socks5://remote.invalid",
      YEP_CODEX_MODEL_PROXY_URL: "http://private-secret.invalid",
    });
    expect(
      Object.keys(env).filter((key) => /^(https?|all)_proxy$/i.test(key)),
    ).toEqual([]);
    expect(env.YEP_CODEX_MODEL_PROXY_URL).toBeUndefined();
    expect(env.no_proxy).toBe("*");
    const local = http.createServer((_req, res) => res.end("mcp-direct"));
    const port = await listen(local);
    try {
      const child = spawn(
        "python3",
        [
          "-c",
          `import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:${port}/new-mcp').read().decode())`,
        ],
        { env },
      );
      let output = "";
      child.stdout.on("data", (data) => {
        output += data;
      });
      const [code] = await once(child, "exit");
      expect(code).toBe(0);
      expect(output.trim()).toBe("mcp-direct");
      expect(tunnels).toHaveLength(0);
    } finally {
      await new Promise((resolve) => local.close(resolve));
    }
  });
});

describe("Codex routing configuration", () => {
  it("fails cleanly when the real CLI cannot start", async () => {
    await expect(
      readLaunchContext(
        "/nonexistent/yep-codex-test",
        [],
        directEnvironment(process.env),
      ),
    ).rejects.toThrow("probe exited");
  });
  it("reports which launch stage failed, without proxy credentials", async () => {
    const error = await launch("/nonexistent/yep-codex-test", [], {
      ...process.env,
      YEP_CODEX_MODEL_PROXY_URL: "http://user:secret@127.0.0.1:9",
    }).catch((caught) => caught);
    expect(describeLaunchFailure(error)).toMatch(
      /^Codex model routing failed during configuration probe \(Error: Codex routing configuration probe exited\)/,
    );
    const relayError = Object.assign(
      new Error("connect ECONNREFUSED http://user:secret@proxy.invalid:8080"),
      { code: "ECONNREFUSED", launchStage: "model relay start" },
    );
    const described = describeLaunchFailure(relayError);
    expect(described).toContain("model relay start (Error ECONNREFUSED");
    expect(described).not.toContain("secret");
  });
  it("retains the builtin provider and auth-specific endpoint without rewriting custom gateways", () => {
    expect(selectOpenAiBase({}, { type: "chatgpt" }).href).toBe(
      "https://chatgpt.com/backend-api/codex",
    );
    expect(selectOpenAiBase({}, { type: "apiKey" }).href).toBe(
      "https://api.openai.com/v1",
    );
    expect(
      selectOpenAiBase({ openai_base_url: "https://gateway.example/v1" }, null),
    ).toBeNull();
    expect(
      selectOpenAiBase(
        { openai_base_url: "https://api.openai.com.evil.test/v1" },
        null,
      ),
    ).toBeNull();
  });

  it("preserves CLI configuration and prompt boundaries", () => {
    const args = [
      "app-server",
      "-c",
      'model_provider="openai"',
      "--cd",
      "/project with spaces",
      "--listen",
      "stdio://",
      "--",
      "--config=prompt-text",
    ];
    expect(configArguments(args)).toEqual([
      "-c",
      'model_provider="openai"',
      "--cd",
      "/project with spaces",
    ]);
    const actual = routedArguments(
      args,
      "http://127.0.0.1:1234/backend-api/codex",
    );
    expect(actual.slice(-2)).toEqual(["--", "--config=prompt-text"]);
    expect(actual).toContain(
      'openai_base_url="http://127.0.0.1:1234/backend-api/codex"',
    );
    expect(actual).toContain('model_provider="openai"');
  });

  it("never opens a handle on the protocol stdio inherited by Codex", async () => {
    const target = {};
    isolateProtocolStdio(target);
    expect(target.stdout).not.toBeInstanceOf(net.Socket);
    expect(target.stdin).not.toBeInstanceOf(net.Socket);

    // Lazy process.stdout init would mark the shared descriptor non-blocking
    // after Codex started, truncating a large line while the reader is slow.
    const launcherUrl = pathToFileURL(
      fileURLToPath(
        new URL(
          "../../resources/codex-model-proxy/launcher.mjs",
          import.meta.url,
        ),
      ),
    ).href;
    const size = 1 << 20;
    const writer = `setTimeout(() => require("node:fs").writeSync(1, Buffer.alloc(${size}, 97)), 300)`;
    const script = `
      import { spawn } from "node:child_process";
      import { isolateProtocolStdio } from ${JSON.stringify(launcherUrl)};
      isolateProtocolStdio();
      const child = spawn(process.execPath, ["-e", ${JSON.stringify(writer)}], { stdio: "inherit" });
      void process.stdout;
      child.on("exit", (code) => { process.exitCode = code ?? 1; });
    `;
    const launcher = spawn(
      process.execPath,
      ["--input-type=module", "-e", script],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    let received = 0;
    launcher.stdout.pause();
    launcher.stdout.on("data", (chunk) => {
      received += chunk.length;
    });
    setTimeout(() => launcher.stdout.resume(), 800);
    const [code] = await once(launcher, "close");
    expect(code).toBe(0);
    expect(received).toBe(size);
  });
});
