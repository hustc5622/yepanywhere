import { X509Certificate } from "node:crypto";
import * as fs from "node:fs";
import type { Server as HttpsServer } from "node:https";
import * as path from "node:path";

export interface TlsCertificateInfo {
  subject: string;
  subjectAltName?: string;
  validFrom: string;
  validTo: string;
}

export interface TlsCertificateLoaderOptions {
  certPath: string;
  keyPath: string;
  /** Debounce window for filesystem change events (default: 300ms). */
  reloadDebounceMs?: number;
  /** Optional logger callback for startup and reload events. */
  onLog?: (message: string) => void;
  /** Optional error callback when reload fails (previous valid cert remains active). */
  onError?: (message: string, error: unknown) => void;
}

export interface HotReloadableTlsLoader {
  /** Initial certificate and key buffers for https.createServer(). */
  readonly initialOptions: { cert: Buffer; key: Buffer };
  /** Parsed metadata of the currently active certificate. */
  getCertificateInfo(): TlsCertificateInfo | null;
  /** Attach an HTTPS server so certificate renewals update its SecureContext live. */
  attachServer(server: HttpsServer): void;
  /** Manually trigger a certificate reload from disk (returns true if reloaded). */
  reload(): boolean;
  /** Stop filesystem watchers. */
  close(): void;
}

function parseCertificateInfo(cert: Buffer): TlsCertificateInfo | null {
  try {
    const x509 = new X509Certificate(cert);
    return {
      subject: x509.subject,
      subjectAltName: x509.subjectAltName || undefined,
      validFrom: x509.validFrom,
      validTo: x509.validTo,
    };
  } catch {
    return null;
  }
}

function readCertificatePair(
  certPath: string,
  keyPath: string,
): { cert: Buffer; key: Buffer; info: TlsCertificateInfo | null } {
  const cert = fs.readFileSync(certPath);
  const key = fs.readFileSync(keyPath);
  if (cert.length === 0 || key.length === 0) {
    throw new Error(
      `TLS certificate or key file is empty (${certPath}, ${keyPath})`,
    );
  }
  const info = parseCertificateInfo(cert);
  return { cert, key, info };
}

/**
 * Loads a TLS certificate + private key pair and watches their parent
 * directory so renewed certificates (from setup-private-tls.sh or acme.sh)
 * are hot-reloaded into attached HTTPS servers via setSecureContext() without
 * dropping connections or restarting Yep.
 *
 * Using setSecureContext() (rather than SNICallback alone) ensures both
 * hostname-based SNI connections and bare-IP HTTPS connections (where TLS
 * ClientHello omits SNI per RFC 6066) pick up renewed certificates.
 */
export function createHotReloadableTlsLoader(
  options: TlsCertificateLoaderOptions,
): HotReloadableTlsLoader {
  const certPath = path.resolve(options.certPath);
  const keyPath = path.resolve(options.keyPath);
  const debounceMs = options.reloadDebounceMs ?? 300;
  const log = options.onLog ?? ((msg) => console.log(`[HTTPS] ${msg}`));
  const logError =
    options.onError ?? ((msg, err) => console.error(`[HTTPS] ${msg}`, err));

  let current = readCertificatePair(certPath, keyPath);
  const attachedServers = new Set<HttpsServer>();
  const watchers: fs.FSWatcher[] = [];
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const reload = (): boolean => {
    if (closed) return false;
    try {
      const next = readCertificatePair(certPath, keyPath);
      if (next.cert.equals(current.cert) && next.key.equals(current.key)) {
        return false;
      }
      for (const server of attachedServers) {
        server.setSecureContext({ cert: next.cert, key: next.key });
      }
      current = next;
      const expiry = current.info?.validTo ?? "unknown";
      log(`Reloaded TLS certificate from ${certPath} (validTo=${expiry})`);
      return true;
    } catch (error) {
      logError(
        `Failed to reload TLS certificate from ${certPath}; keeping previous certificate active:`,
        error,
      );
      return false;
    }
  };

  const scheduleReload = () => {
    if (closed) return;
    if (reloadTimer) {
      clearTimeout(reloadTimer);
    }
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      reload();
    }, debounceMs);
  };

  // Watch parent directories so atomic rename replacements (standard in
  // acme.sh and openssl scripts) trigger reloads reliably.
  const watchedDirs = new Set([path.dirname(certPath), path.dirname(keyPath)]);
  const targetNames = new Set([
    path.basename(certPath),
    path.basename(keyPath),
  ]);

  for (const dir of watchedDirs) {
    try {
      const watcher = fs.watch(dir, (_eventType, filename) => {
        if (!filename || targetNames.has(String(filename))) {
          scheduleReload();
        }
      });
      watcher.on("error", (err) => {
        logError(`TLS directory watcher error (${dir}):`, err);
      });
      watchers.push(watcher);
    } catch (error) {
      logError(`Could not watch TLS directory (${dir}) for hot reload:`, error);
    }
  }

  return {
    initialOptions: {
      cert: current.cert,
      key: current.key,
    },
    getCertificateInfo() {
      return current.info;
    },
    attachServer(server: HttpsServer) {
      attachedServers.add(server);
      server.once("close", () => {
        attachedServers.delete(server);
      });
    },
    reload,
    close() {
      closed = true;
      if (reloadTimer) {
        clearTimeout(reloadTimer);
        reloadTimer = null;
      }
      for (const watcher of watchers) {
        try {
          watcher.close();
        } catch {
          // Ignore watcher cleanup errors
        }
      }
      watchers.length = 0;
      attachedServers.clear();
    },
  };
}
