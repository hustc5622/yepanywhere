# Codex Protocol Subset

This directory contains a checked-in subset of Codex app-server generated
TypeScript types used by the Codex provider runtime.

- `generated/`: copied subset from `codex app-server generate-ts`
- `index.ts`: stable typed exports consumed by provider code

Update subset:

```bash
pnpm codex:protocol:update
```

Check subset drift:

```bash
pnpm codex:protocol:check
```

Notes:

- The full generated Codex protocol dump is intentionally not checked in.
- Expected local Codex CLI version is configured in root `package.json` at
  `yepAnywhere.codexCli.expectedVersion`. `pnpm codex:protocol:update` keeps
  this pin in sync with the installed `codex` CLI; `pnpm codex:protocol:check`
  fails if it has drifted (e.g. codex auto-updated without a re-run).
- The server's startup warning is semver-tolerant: only major/minor drift
  triggers it (patch-level drift like 0.142.1 -> 0.142.2 is ignored). The
  warning is also skipped entirely when `CODEX_BRIDGE_MODE=disabled`.
