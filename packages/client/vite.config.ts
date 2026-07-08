import { execSync } from "node:child_process";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { cspPlugin } from "./vite-plugin-csp";
import { reloadNotify } from "./vite-plugin-reload-notify";

// NO_FRONTEND_RELOAD: Disable HMR and use manual reload notifications instead
const noFrontendReload = process.env.NO_FRONTEND_RELOAD === "true";

// Port defaults to 3402 (base port 3400 + 2), can be overridden via VITE_PORT
const vitePort = process.env.VITE_PORT
  ? Number.parseInt(process.env.VITE_PORT, 10)
  : 3402;

// VITE_HOST: Set to "true" to bind to all interfaces (needed in Docker containers)
const viteHost = process.env.VITE_HOST === "true" ? true : undefined;

// BASE_PATH: when the server is mounted under a reverse-proxy prefix (e.g.
// Caddy at /yep/), Vite needs to emit asset URLs with that prefix and the
// runtime needs to know where /api lives. Empty / "/" = serve at root.
const basePath = (() => {
  const raw = process.env.BASE_PATH?.trim();
  if (!raw || raw === "/") return "/";
  const withLeadingSlash = raw.startsWith("/") ? raw : `/${raw}`;
  return withLeadingSlash.endsWith("/")
    ? withLeadingSlash
    : `${withLeadingSlash}/`;
})();

function getGitVersion(): string {
  try {
    return execSync("git describe --tags --always", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    })
      .trim()
      .replace(/^v/, "");
  } catch {
    return "dev";
  }
}

function getDevBuildId(): string {
  try {
    const commit = execSync("git rev-parse HEAD", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return `dev-${commit.slice(0, 12)}`;
  } catch {
    return "dev-nogit";
  }
}

export default defineConfig({
  clearScreen: false,
  base: basePath,
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("/@xterm/")) return "vendor-xterm";
          if (id.includes("/react/") || id.includes("/react-dom/")) {
            return "vendor-react";
          }
          if (
            id.includes("/react-router/") ||
            id.includes("/react-router-dom/")
          ) {
            return "vendor-router";
          }
          if (id.includes("/zod/")) return "vendor-zod";
          return "vendor";
        },
      },
    },
  },
  define: {
    __BUILD_ID__: JSON.stringify(process.env.YEP_BUILD_ID ?? getDevBuildId()),
    __APP_VERSION__: JSON.stringify(
      process.env.YEP_BUILD_VERSION ??
        process.env.YEP_BUILD_GIT_DESCRIBE ??
        getGitVersion(),
    ),
    // Wall-clock build time (see vite.config.remote.ts for rationale).
    __BUILD_DATE__: JSON.stringify(
      process.env.YEP_BUILD_DATE ?? new Date().toISOString(),
    ),
    __BUILD_PROFILE__: JSON.stringify(process.env.YEP_BUILD_PROFILE ?? "dev"),
  },
  plugins: [
    react(),
    // When HMR is disabled, use reload-notify plugin to tell backend about changes
    reloadNotify({ enabled: noFrontendReload }),
    // Content Security Policy (stricter in production, permissive in dev for HMR)
    cspPlugin({ isRemote: false }),
  ],
  resolve: {
    conditions: ["source"],
  },
  server: {
    port: vitePort,
    strictPort: true,
    host: viteHost,
    allowedHosts: ["localhost", ".yepanywhere.com"],
    // HMR configuration for reverse proxy setup
    // When accessed through backend proxy (port 3400) or Tailscale, HMR needs to
    // connect back through the same proxy path, not directly to Vite's port
    hmr: noFrontendReload
      ? false
      : {
          // Let the client determine host/port from its current location
          // This allows HMR to work through any proxy (backend, Tailscale, etc.)
          // The backend will proxy WebSocket connections to us
        },
    // No proxy needed - backend (port 3400) proxies to us, not the other way around
    // Users access http://localhost:3400 and backend forwards non-API requests here
  },
});
