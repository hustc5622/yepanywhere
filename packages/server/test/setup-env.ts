/**
 * Test environment hygiene.
 *
 * Dev machines in this repo frequently run tests from shells that inherited
 * the local 8022 deployment environment (launchd deploy env, OpenCode-managed
 * agent sessions). That environment carries managed-model credentials, bridge
 * endpoints and provider toggles that change code paths under test — e.g.
 * getOpenCodeEnv() picking up a real YEP_OPENCODE_LLM_API_KEY.
 *
 * Scrub those variables before any test module loads so results do not depend
 * on which terminal the test command was typed in. Tests that need one of
 * these values set it explicitly (vi.stubEnv / process.env assignment).
 *
 * NODE_ENV itself is forced to "test" via `test.env` in vitest.config.ts,
 * which applies even earlier (before worker module resolution).
 */
const SCRUB_PREFIXES = [
  // Deployment/bridge/runtime config and Yep-managed credentials.
  "YEP_",
  // OPENCODE=1 / OPENCODE_PID / OPENCODE_CONFIG_CONTENT injected by the
  // opencode runtime, plus OPENCODE_LLM_* / OPENCODE_BRIDGE_* legacy names.
  "OPENCODE",
  // Legacy unprefixed codex bridge vars.
  "CODEX_BRIDGE",
  // Gateway/AI-title credentials.
  "LLM_",
  "SESSION_TITLE_",
];

const SCRUB_EXACT = new Set([
  "ENABLED_PROVIDERS",
  "VOICE_INPUT",
  "GOOGLE_APPLICATION_CREDENTIALS",
]);

for (const key of Object.keys(process.env)) {
  if (
    SCRUB_EXACT.has(key) ||
    SCRUB_PREFIXES.some((prefix) => key.startsWith(prefix))
  ) {
    delete process.env[key];
  }
}
