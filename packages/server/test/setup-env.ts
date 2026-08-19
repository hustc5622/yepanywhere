/**
 * Test environment hygiene.
 *
 * Dev machines in this repo frequently run tests from shells that inherited
 * the local 8022 deployment environment. That environment carries managed
 * model credentials, bridge endpoints and provider toggles that can change
 * code paths under test.
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
  // Legacy unprefixed codex bridge vars.
  "CODEX_BRIDGE",
  // Gateway/AI-title credentials.
  "LLM_",
  "SESSION_TITLE_",
  // ZCode config/CLI path env vars (YEP_ZCODE_CLI_PATH, ZCODE_*).
  "ZCODE",
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

// The LLM gateway credentials overlay is discovered in the data directory, so
// scrubbing variables is not enough to isolate a machine that actually has one.
// Point it at a path that cannot exist; tests that exercise the overlay set
// YEP_LLM_GATEWAYS_FILE to their own temp file.
process.env.YEP_LLM_GATEWAYS_FILE =
  "/nonexistent/yep-anywhere-test/llm-gateways.json";
