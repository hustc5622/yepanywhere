# Codex Session Compatibility Fix Implementation Plan

> **For agentic workers:** Execute inline with test-driven development; keep unrelated working-tree changes untouched.

**Goal:** Hide Codex Desktop synthetic plugin context, prevent false 500 errors during normal Codex cold starts, and establish whether resumed turns have a separate lifecycle defect.

**Architecture:** Reuse the server's existing synthetic-user-prompt classifier so every downstream consumer (titles, questions, branches, normalized messages) agrees. Extend the existing Process initialization contract from 5 seconds to 15 seconds. Treat post-initialization turn completion as a separate provider lifecycle investigation and only modify it if a deterministic repro identifies a Yep-side fault.

**Tech Stack:** TypeScript, Vitest, Codex app-server JSON-RPC, YepAnywhere server supervisor.

## Global Constraints

- Preserve all pre-existing uncommitted folder-browser and i18n changes.
- Make no frontend filtering fork when the server classifier already owns this behavior.
- Require a failing regression test before each production-code change.
- Verify with targeted tests, lint, typecheck, and a real local production request.

---

### Task 1: Filter recommended plugin context

**Files:**
- Modify: `packages/server/src/sessions/user-prompt-classification.ts`
- Modify: `packages/server/src/indexes/SessionIndexService.ts`
- Test: `packages/server/test/sessions/codex-reader-oss.test.ts`
- Test: `packages/server/test/indexes/SessionIndexService.test.ts`

- [x] Add an integration-style JSONL test asserting the title, question list, and normalized message stream ignore `<recommended_plugins>`.
- [x] Run the test and confirm it fails on the synthetic title.
- [x] Add the prefix to the central classifier.
- [x] Run the Codex reader suite and confirm it passes.
- [x] Add a regression test proving version 8 indexes preserve the stale title.
- [x] Bump the replaceable session-summary index to version 9 so parsing-rule changes rebuild historical titles.

### Task 2: Allow normal Codex cold starts

**Files:**
- Modify: `packages/server/src/supervisor/Process.ts`
- Test: `packages/server/test/process.test.ts`

- [x] Add a fake-timer test asserting the default initialization promise remains pending after 5.001 seconds and times out at 15 seconds.
- [x] Run the test and confirm it fails at 5.001 seconds.
- [x] Change the default provider initialization timeout to 15 seconds.
- [x] Run the Process suite and confirm it passes.

### Task 3: Investigate resumed-turn completion

**Files:**
- Modify only if evidence identifies a Yep-side lifecycle defect.
- Test the closest provider/public lifecycle seam if a fix is required.

- [x] Trace `turn/start`, the persisted turn result, Process state transitions, and connection state.
- [x] Confirm the diagnostic turn completed after 117.984 seconds and Process reached idle.
- [x] Identify the apparent stall as a 153k-token resumed context with a 117.462-second time to first token plus WebSocket reconnects, not a dropped terminal event.
- [x] Do not add an unsafe guessed execution timeout for legitimately long turns.

### Task 4: Verification and deployment

- [x] Run targeted session, Process, and Codex provider tests.
- [x] Run `pnpm lint` and `pnpm typecheck`.
- [x] Inspect the diff to prove unrelated edits were not changed.
- [x] Rebuild/restart the local production service.
- [x] Verify a real new Codex session no longer returns 500 and reaches a terminal state.
- [x] Verify the affected session title/message no longer exposes `<recommended_plugins>`.
