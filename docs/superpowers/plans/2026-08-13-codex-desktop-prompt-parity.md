# Codex Desktop Prompt Display Parity Implementation Plan

> **For agentic workers:** Execute inline with test-driven development; preserve unrelated working-tree changes.

**Goal:** Make Codex Desktop titles and user prompts match the existing Claude/Codex transcript display contract without adding a parallel renderer.

**Architecture:** Add one shared parser for provider-injected user prompt metadata. Reuse it from server title/question extraction and the existing client user-prompt parser, broaden the existing Codex subagent predicate, then rebuild cached summaries through an index version increment.

**Tech Stack:** TypeScript, Zod-backed Codex JSONL reader, React, Vitest.

## Global Constraints

- Preserve original JSONL and all existing tool/reasoning/final-answer behavior.
- Preserve pre-existing uncommitted drive-picker, i18n, timeout, and plugin-filter changes.
- Write and observe failing tests before each production change.
- Do not create a Codex-only transcript renderer.

---

### Task 1: Shared Codex Desktop prompt metadata parsing

**Files:**
- Modify: `packages/shared/src/ideMetadata.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/ideMetadata.test.ts`

- [ ] Add failing cases for request extraction, ambient browser-context removal, mentioned files, empty attachment prompts, and unchanged XML.
- [ ] Run the shared test and confirm the new expectations fail.
- [ ] Add the minimum shared parser and exports.
- [ ] Run the shared test and confirm it passes.

### Task 2: Server titles and questions use shared visible text

**Files:**
- Modify: `packages/server/src/sessions/codex-reader.ts`
- Modify: `packages/server/src/sessions/session-message-text.ts`
- Modify: `packages/server/src/sessions/user-questions.ts`
- Modify: `packages/server/src/indexes/SessionIndexService.ts`
- Test: `packages/server/test/sessions/codex-reader-oss.test.ts`
- Test: `packages/server/test/indexes/SessionIndexService.test.ts`

- [ ] Add a failing Codex JSONL integration case asserting the actual request becomes title/question text.
- [ ] Add a failing version 9 stale-title cache case.
- [ ] Run both tests and confirm the failures are caused by raw wrapper text and cache reuse.
- [ ] Route existing text cleanup through the shared parser and bump the index to version 10.
- [ ] Run the tests and confirm they pass.

### Task 3: Existing client attachment UI consumes mentioned files

**Files:**
- Modify: `packages/client/src/lib/parseUserPrompt.ts`
- Modify: `packages/client/src/components/blocks/UserPromptBlock.tsx`
- Test: `packages/client/src/lib/__tests__/parseUserPrompt.test.ts`
- Test: `packages/client/src/components/blocks/__tests__/UserPromptBlock.test.tsx`

- [ ] Add failing parser/component cases for cleaned request text and a file-only prompt.
- [ ] Run the client tests and confirm wrapper text is currently visible.
- [ ] Map shared mentioned files into the existing `UploadedFileInfo` path and avoid duplicate image chips when inline images exist.
- [ ] Run the client tests and confirm they pass.

### Task 4: Filter guardian subagent sessions

**Files:**
- Modify: `packages/server/src/sessions/codex-session-manifest.ts`
- Test: `packages/server/test/sessions/codex-reader-oss.test.ts`

- [ ] Add a failing top-level listing case for `source.subagent.other = "guardian"` without `forked_from_id`.
- [ ] Run the test and confirm the guardian session leaks.
- [ ] Broaden the existing subagent predicate to any lower/camel-case subagent descriptor.
- [ ] Run the test and confirm it passes alongside thread-spawn coverage.

### Task 5: Regression and production verification

- [ ] Run shared, server session/index, and client prompt/component suites.
- [ ] Run `pnpm lint` and `pnpm typecheck`.
- [ ] Inspect the scoped diff and run `git diff --check`.
- [ ] Rebuild/restart production using the project entry point.
- [ ] Verify affected historical titles and prompt bodies no longer expose wrapper text.
- [ ] Verify XML user content and tool rows remain visible.
