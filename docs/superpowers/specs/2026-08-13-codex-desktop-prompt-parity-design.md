# Codex Desktop Prompt Display Parity Design

## Goal

Render Codex Desktop sessions through Yep Anywhere's existing shared transcript model so recent-session titles and conversation user prompts show the actual request, while provider-supplied context remains available to the model but hidden from the primary UI.

## Existing Architecture

Yep Anywhere already centralizes provider session normalization on the server and renders Claude/Codex messages through the same client components. It also has shared metadata stripping, client attachment rendering, synthetic prompt classification, and Codex subagent filtering. The defect is format drift: newer Codex Desktop user records wrap the real request in `# Files mentioned by the user`, `<in-app-browser-context>`, and `## My request`, while guardian threads use a broader `source.subagent` shape than the manifest filter accepts.

## Design

Extend the shared prompt-metadata utility instead of adding a Codex renderer. The parser returns visible user text plus mentioned-file metadata. It removes complete ambient browser-context blocks, extracts the body after `## My request`, and recognizes file lines in the existing Codex Desktop wrapper. Plain user messages, XML/JSON messages, skills, Claude uploads, and incomplete tag examples remain unchanged.

Server title/question extraction uses the same cleaned text. If a wrapped prompt has no text but includes a file, the file name is the display fallback. The client reuses its current user prompt and attachment components: it renders the cleaned request and uses mentioned files only when no richer inline Codex image blocks already represent them.

The Codex manifest treats any `source.subagent` or `source.subAgent` descriptor as a non-top-level session. This includes `other: "guardian"` and retains the existing `thread_spawn` behavior.

## Data Flow

1. Codex JSONL remains untouched and continues to contain the full provider input.
2. Codex reader uses shared prompt parsing for titles and question text.
3. Normalization preserves the original message, so resume/branch correlation is unchanged.
4. The client user-prompt parser strips provider context at display time and returns attachment metadata to the existing component.
5. Session index version increments so cached historical titles are rebuilt.

## Non-goals

- Do not hide real XML/JSON user messages.
- Do not change reasoning, commentary, tool-call, or final-answer rendering.
- Do not introduce a provider-specific conversation component.
- Do not rewrite or migrate original Codex JSONL files.

## Verification

- Shared parser tests cover browser context, request extraction, file-only prompts, and ordinary XML preservation.
- Codex reader integration verifies title, questions, and normalized visible prompt behavior.
- Manifest tests verify guardian sessions are absent from top-level listings.
- Client prompt tests verify existing attachment rendering consumes the shared metadata.
- Index tests verify version 9 caches rebuild under version 10.
