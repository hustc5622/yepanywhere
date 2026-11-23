import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import type * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHotReloadableTlsLoader } from "../../src/https/tls-loader.js";

function generateTestCert(
  dir: string,
  cn: string,
): { certPath: string; keyPath: string } {
  const keyPath = path.join(dir, `${cn}.key`);
  const certPath = path.join(dir, `${cn}.crt`);
  const result = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      `/CN=${cn}`,
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:localhost",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`openssl failed: ${result.stderr}`);
  }
  return { certPath, keyPath };
}

describe("createHotReloadableTlsLoader", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tls-loader-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("loads certificate metadata and hot-reloads updated cert/key into attached HTTPS server", () => {
    const pairA = generateTestCert(tempDir, "cert-a");
    const pairB = generateTestCert(tempDir, "cert-b");

    const activeCertPath = path.join(tempDir, "server.crt");
    const activeKeyPath = path.join(tempDir, "server.key");
    fs.copyFileSync(pairA.certPath, activeCertPath);
    fs.copyFileSync(pairA.keyPath, activeKeyPath);

    const loader = createHotReloadableTlsLoader({
      certPath: activeCertPath,
      keyPath: activeKeyPath,
      reloadDebounceMs: 50,
      onLog: () => {},
    });

    try {
      expect(loader.getCertificateInfo()?.subject).toContain("CN=cert-a");

      let updatedContextCount = 0;
      const fakeServer = {
        setSecureContext: () => {
          updatedContextCount += 1;
        },
        once: () => {},
      } as unknown as https.Server;

      loader.attachServer(fakeServer);

      // No-op reload when files have not changed
      expect(loader.reload()).toBe(false);
      expect(updatedContextCount).toBe(0);

      // Replace cert + key atomically and trigger reload
      fs.copyFileSync(pairB.certPath, activeCertPath);
      fs.copyFileSync(pairB.keyPath, activeKeyPath);
      expect(loader.reload()).toBe(true);
      expect(updatedContextCount).toBe(1);
      expect(loader.getCertificateInfo()?.subject).toContain("CN=cert-b");
    } finally {
      loader.close();
    }
  });

  it("keeps previous valid certificate active if reload encounters corrupt file", () => {
    const pairA = generateTestCert(tempDir, "cert-stable");
    const activeCertPath = path.join(tempDir, "server.crt");
    const activeKeyPath = path.join(tempDir, "server.key");
    fs.copyFileSync(pairA.certPath, activeCertPath);
    fs.copyFileSync(pairA.keyPath, activeKeyPath);

    const errors: string[] = [];
    const loader = createHotReloadableTlsLoader({
      certPath: activeCertPath,
      keyPath: activeKeyPath,
      onLog: () => {},
      onError: (msg) => errors.push(msg),
    });

    try {
      fs.writeFileSync(activeCertPath, "");
      expect(loader.reload()).toBe(false);
      expect(errors.length).toBeGreaterThan(0);
      expect(loader.getCertificateInfo()?.subject).toContain("CN=cert-stable");
    } finally {
      loader.close();
    }
  });
});
