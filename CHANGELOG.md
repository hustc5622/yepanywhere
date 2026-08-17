# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this independent release line uses calendar versions in `YYYY.M.N` format.

## [Unreleased]

### Fixed
- Select the freshest canonical Codex journal instead of the first one that happens to hold the session. Provider and bridge journals are independently sequenced, and source selection returned the first source containing any event for the session — which silently preferred a stale journal. Measured on a live install, one session existed in both: the provider journal ended at 2026-08-16T05:09:30Z while the bridge journal ended at 2026-08-16T18:18:37Z, so because provider came first, every canonical projection of that session was **13.2 hours behind what had actually been recorded**, with nothing in the response or the logs to indicate it. Journals are still never merged — their sequence spaces are independent, so one is chosen whole — and ties keep the previous positional precedence, so single-journal installs behave exactly as before. Freshest wins because the overlay exists to enrich the rows the client is looking at, which are the recent ones, and because full history comes from the legacy rollout rather than from this journal. Comparison uses `receivedAtMs`, the one timestamp our own ingress sets on both the provider and the bridge path, so the ranking stays on a single clock; a journal whose events carry no usable timestamp is treated as "unknown freshness" rather than "empty" so its canonical data is never dropped. Cost: every source is now probed instead of stopping at the first hit, via a new O(1) `latestEventAtMs` on the store, so only the winning journal is replayed. That does force a cold load of journals positional precedence might have skipped, which is accepted because a mixed workload loads them all anyway. Verified against the real journals: the selector now picks the bridge journal for that session, and the same session turns out to hold 405,157 bridge events rather than the 144,029 the stale journal exposed
- Report canonical Codex journal pruning instead of losing history silently. The durable event store keeps 3 closed segments of 256 MiB each, so on a live install — measured at one rotation per ~17 h — roughly 2.9 days of history is retained and everything older is deleted. Nothing noticed: rotated events stay in the in-memory indexes for the life of the process (deliberately, so replay and per-session sequences stay continuous), so the loss only materializes after a restart, and no layer checked for it. `matchesReplaySnapshot` only compares a cached projection against the replay, so an incomplete replay validates cleanly against an equally incomplete cache, and the reducer folds a partial history without complaint. Pruning now reports which sessions each deleted segment held and how many events it took from each, described from bookkeeping captured at load time and carried across the rotation rename rather than by re-reading a 256 MiB file that is being deleted for being large. A cold load additionally reports sessions whose surviving journal no longer starts at sequence 1 — per-session sequences are dense and start at 1, so the first surviving sequence is exactly the count of deleted leading events — which is the signal a restarted process previously had no way to produce. A session whose events were removed entirely still cannot be detected, because sequence assignment restarts at 1 once nothing survives; that case makes a session vanish rather than render a truncated history, and the code says so. Verified against both production journals (provider and bridge, ~740 MB and ~700 MB): no gaps, which is the correct answer because segment pruning has not fired yet on that install — the instrumentation is in place before the first deletion rather than after it
- Stop the canonical Codex overlay from disabling itself on long sessions. `DEFAULT_MAX_REFRESH_EVENTS = 100_000` has been there since the first event-spine commit with no comment or measurement behind it, and it rejected the whole overlay on *total journal size*. Measured on a production journal (144,029 events for one session, 10,494 legacy rows) the overlay is linear at 35-47 us/event with no knee anywhere near the constant, and the two regimes differ by two orders of magnitude: a windowed request costs 139 ms while an unwindowed one costs 6.8 s. The projection cache does not close that gap because it memoizes the reduce, not the candidate build and legacy matching (warm 6.7 s vs cold 7.0 s). The ceiling now applies only to the unwindowed regime, so the windowed request the client actually makes is served canonically instead of silently falling back to legacy normalization on every single request — 692 of the 705 fallbacks in one day of logs were this session. The check also moved ahead of the generated-artifact scan, which walks every replayed event: an out-of-bounds session used to pay for that scan and have the result discarded by the next statement (25-39 ms warm, ~1 s on a cold store, per request). `CodexProjectionCache` no longer evicts the entry the current `apply` call is using: a session whose own projection exceeded `maxTotalEvents` used to evict *itself* on the way out, leaving an empty cache, so exactly the sessions that need the incremental projection were guaranteed never to have it (`cache.size === 0` and a full ~8 s cold projection on every request for that same session). Finally, the fallback log now records `outcome`, `errorName`, `errorMessage` and `journalReplayMs`: it previously reported neither the error name nor its message, so a hard event-limit rejection appeared as `budgetExceeded: false` with an unexplained duration, and a known bound now logs at debug instead of warning once per request
## [2026.8.4] - 2026-08-17

### Added
- Compress `/api/*` responses with gzip. Session payloads are dominated by server-rendered augment output — on a measured 1.72 MB pi session response, `_highlightedContentHtml` alone was 1.49 MB (73%) — and that HTML is highly redundant, so nothing was gaining from being sent verbatim over a link. Measured after the change: a pi session response 385,685 → 119,494 bytes (3.2:1) and the 188 MB Codex session's window 801,475 → 158,028 bytes (5.1:1); an earlier 1.72 MB body compressed 7.2:1, which over the throttled remote tunnel is the difference between ~112 s and ~16 s of transfer. Streaming is unaffected: `text/event-stream` is excluded from Hono's compressible-type allowlist *and* `streamSSE` sets `Transfer-Encoding`, which the middleware also skips — verified live, an SSE response still arrives as plaintext with no `Content-Encoding`. Binary downloads (APK, images) are skipped by content type. One accepted wart: Hono can only honour its size threshold when the handler declared a `Content-Length`, which `c.json()` does not, so small JSON responses are compressed too; that costs a few bytes and a little CPU on polling endpoints and was preferred over replacing well-tested middleware with a bespoke one
- Partial-read parity tests for Codex rollouts (`codex-partial-read-parity.test.ts`), gating the tail-read work: the window produced by parsing a whole rollout and the window produced by parsing only its tail must be deep-equal, including ids. The suite also pins the boundary where tail reads are unsafe — `codexRolloutSupportsTailRead` returns false for rollouts containing `thread_rolled_back` markers, because such a marker drops the user turns *preceding* it and a tail read cannot see them, so the marker silently does nothing and the window keeps history a full read discards. That is a semantic divergence no id scheme can repair, so those rollouts must be read in full

### Changed
- Throttle and serialize session-index full validations. Watcher events for every provider except Claude cannot tell which project scope owns the changed file, so `handleFileChange` marks *all* of that provider's loaded scopes dirty — and a dirty directory bypassed the existing 30 s full-validation interval entirely. With a shared backing store (OpenCode keeps one sqlite file for every project) a single write therefore queued one full store scan per scope. On a live server with 43 projects and 153 index scopes this reached **29 full validations per second at 250–800 ms each**, saturating the event loop: an unrelated session read whose own work measures ~15 ms took 3–11 s, and the same request varied between 0.02 s and 22 s. A dirty directory now still forces a full pass but no more often than `SESSION_INDEX_FULL_VALIDATION_MIN_MS` (default 5000) per scope, and at most `SESSION_INDEX_MAX_CONCURRENT_FULL_VALIDATIONS` (default 1) run at a time so scopes sharing a store cannot pile up. The service default for the floor is 0, so embedders keep the previous behaviour unless the config layer opts in. Trade-off: a newly created or externally modified session can take up to the floor to appear in list views
- Stop deep-copying canonical Codex events on every replay. `JsonlCodexEventStore.replay()` ran `structuredClone` over each envelope it returned; the client's default `view=canonical` session load replays a whole session's journal, so a session with 144k journalled events paid ~650 ms and produced ~250 MB of garbage on *every* request, and the heap grew by roughly that much per session open. No consumer mutates a replayed envelope — the overlay copies the array before sorting, and the reducer, candidate builder and artifact scan only read — so the copies bought nothing. Replay now returns shared, `readonly` references (the reference `InMemoryCodexEventStore` keeps copying, where journals are tiny and isolation is worth the allocation). Measured against the real 775 MB provider journal: warm replay 647–692 ms → 2–4 ms, and heap stays flat across repeated replays instead of climbing ~250 MB each time
- Collapse the redundant rollout reads that made opening a large Codex session slow. Opening one session fans out into `GET /projects/:p/sessions/:s`, `/metadata`, and `/agents`, and each endpoint independently read and JSON-parsed the whole rollout file; on a 188 MB / 32k-line session that burst took ~2.8 s wall clock and the concurrent copies also multiplied peak memory. A new `readSharedCodexEntries` (`packages/server/src/sessions/codex-entries-reader.ts`) coalesces reads of the same path that overlap in time, so the burst shares one read+parse. Nothing is retained after a read settles, so there is no cache to invalidate and a caller can only observe data one read older than its own request — already true when every caller read at a slightly different instant. Entries are now typed `readonly` end to end (`buildCodexBranchView`, `convertCodexEntries`, and the Codex reader helpers) so the read-only contract the sharing depends on is enforced by the compiler. Measured on the same instance: session-open burst 2.84 s → 1.00 s, single session request 2.22 s → 1.07 s
- Stop serializing the session message window twice. `GET /projects/:p/sessions/:s` returned `messages` at the top level and a byte-identical copy under `session.messages` that no client ever read; the nested copy is now omitted and `messages` was dropped from the client `Session` type (message state is owned by `useSessionMessages`). Same session as above: response 1.462 MB → 0.803 MB
- Point the `mini` mobile-shell TCP node at the new frp server (`39.106.189.88:18022`, previously `39.106.200.1:18022`) in both the client node list and the APK static shim, and treat the retired `http://39.106.200.1:18022` origin as a deprecated default so persisted app data falls back to the current endpoint instead of dialing the dead address

### Fixed
- Anchor Codex message, question, and branch ids to entry byte offsets instead of a running counter. `convertCodexEntries` derived every uuid from its position in whatever entry array it was handed, so identity depended on how much of the rollout had been parsed and on which branch was selected: the same message was `codex-15760-<ts>` after a full read and `codex-225-<ts>` after a tail read, and switching branches shifted the ids of messages in the shared prefix even though those messages had not changed. Ids are now `codex-@<byteOffset>`, which is unique (measured over a 32k-entry production rollout: zero collisions, versus 294 colliding groups for `timestamp` alone and 4 for `timestamp|type|payloadType`), stable under append, and preserved across zstd compression. Entries built without a file keep their previous positional ids, so fixtures and other providers are unaffected. `SessionIndexService` moves to version 11 so cached `userQuestions[].id` values are rebuilt; `SessionInspector.mergeQuestionItems` already deduplicates on `timestamp + text` as well as id, so the rebuild window cannot show duplicates
- Read Codex rollouts that have been compressed to `.jsonl.zst`. Codex ships a background worker (`codex-rs/rollout/src/compression.rs`) that compresses rollouts cold for 7 days and then deletes the plain file; Yep's manifest scan only matched `.jsonl` and had no zstd path anywhere, so with that worker active every Codex session older than a week would not degrade but simply vanish from Yep. Discovery now accepts both forms and prefers plain when both exist (Codex materializes a compressed rollout back to plain before appending, so during a resume the plain copy is the live one), and reads decompress transparently — the manifest header read streams through the decompressor and stops at the first newline instead of inflating the whole file. The worker is gated behind `Feature::LocalThreadStoreCompression`, verified `under development` / default-off on the installed Codex 0.147.0 via `codex features`, so this is a latent-failure fix rather than a live one. `ExternalSessionTracker` is deliberately left plain-only: a compressed rollout is by definition inactive, and Codex materializes it back to plain before any append, so live sessions always have a plain file. Node only exposes zstd in `node:zlib` from v22.15.0 while this package supports `node >=22.13.0`, so the bindings are resolved lazily rather than at import (binding them at module scope threw a `TypeError` during import of a module that `app.ts` depends on, i.e. no server start at all on 22.13/22.14), and on such a runtime compressed rollouts are skipped during discovery instead of being listed as sessions whose every read is guaranteed to fail. Root cause of the wider hazard, fixed with it: how rollout bytes are stored was knowledge spread across whichever call site happened to open a file, and `readFile(path, "utf-8")` does not fail on compressed bytes — it silently returns mojibake. `cloneCodexSession` (fork/branch) inlined exactly that read *and* is the only place Yep writes a rollout, so a compressed source would have produced a corrupt `rollout-*.jsonl` that then became a permanent manifest entry. Decoding now has a single owner (`codex-rollout-file.ts`, pinned by a test that fails if a second module reaches for the codec), the clone path decodes through it, and it validates the decoded text before writing so any storage format this build does not understand degrades to a clean error instead of a corrupt file. `CodexSessionManifestEntry` gained `compressed: boolean` because a bare `filePath: string` cannot tell a consumer that its bytes are not text. Consumers that only stat or move the bytes are safe for both forms and stay unchanged — archive/restore is a byte-level move, verified lossless for a compressed session, which matters because auto-archive fires at 7 days and Codex compresses after 7 days cold

## [2026.8.3] - 2026-08-17

### Added
- Pi coding-agent support based on the pinned `references/pi` source: native strict-LF JSONL RPC transport, generated process-local gateway providers, shared OpenCode gateway model catalog and endpoint selection, Codex-style thinking controls, streamed messages/tool results, Yep approval bridging, compaction/model switching, native session discovery and active-branch normalization, cross-session edit-fork switching/lineage, archive/search/index/watch integration, and provider-specific UI identity. Dynamically registered `openai-completions` models pin a portable request compat (no `developer` role, `store`, or `max_completion_tokens`) so generic OpenAI-compatible gateways do not reject Pi's api.openai.com-oriented defaults with a 400. The bundled extension is loaded without installing into or modifying Pi config under `~/.pi`, disables user extensions for Yep-owned processes, and removes gateway credentials from the child environment before Pi tools run; native session JSONL remains in Pi's normal session tree
- Kimi goal lifecycle display (inline read-only card): the shared `kimi-schema` now registers `goal.create`/`goal.update`/`goal.clear`/`forked` wire record schemas (mirroring `references/kimi-code` 0.36.0+ `goalOps.ts`), and `getKimiGoalTimeline` replays them into a snapshot timeline (status `active|paused|blocked|complete|cleared`, budget limits `tokenBudget/turnBudget/wallClockBudgetMs`, consumption counters `turnsUsed/tokensUsed/wallClockMs`, actor `user|model|runtime|system`, change classification `created|status|budget|progress|cleared`). The server's `convertKimiMessages` merges the snapshots into the transcript as inline `type: "kimi_goal"` messages placed by timestamp, and the client renders them with a `GoalInlineBlock` card — objective, status badge with icon/color, budget progress bars (warning at ≥80%), and final tallies on clear. Historical Kimi sessions that previously lost all goal information now show the full goal timeline
- Expanded Kimi wire schema coverage from 6 to more than 40 recognized persisted record types. Added typed validation for profile/tool/context/turn/swarm/plan/task/LLM/permission/plugin/compaction/interaction and goal lifecycle records while retaining unknown records for forward compatibility. `config.update` now follows upstream's single partial-update payload and preserves combined `modelAlias` + `profileName` records; `getKimiSubagentType` prefers authoritative `profile.bind.profileName` with a `config.update.profileName` fallback
- Kimi context compaction tracking: `kimi-reader.deriveFromWire` now parses `full_compaction.begin` + `context.apply_compaction` records into `compactCount`/`compactEvents` (timestamp, before/after tokens, reclaimed, trigger), surfaced on the session summary — matching the existing Codex compaction display
- Kimi offline session terminal status: when a Kimi process has exited (no live runtime), the last `turn.ended.reason` (`completed|cancelled|failed|blocked`) is now mapped to the session-level `lastTurnStatus`, so offline sessions show "completed / interrupted / failed" instead of a blank status
- Kimi ACP tool name precision for subagent dispatch: `inferKimiAcpToolName` now recognizes `Agent` and `AgentSwarm` by exact name and by distinctive args (`subagent_type`/`prompt`/`description` for Agent, `items`/`prompt_template` for AgentSwarm), so online subagent dispatches no longer fall back to the generic "KimiTool" label
- Subagent type visual differentiation: the `task-agent-type` badge now uses type-specific colors and icons (explore → blue + 🔍 read-only, coder → purple + ✏️ editing, agent → green, plan → amber) instead of a uniform `badge-info` text chip

- ZCode goal lifecycle (session/goal full chain): `AgentSession.getGoal`/`goalAction` (strict 0.16.1 params, shared `ZCodeSessionGoalParamsSchema`/`ZCodeSessionGoalResultSchema` contracts) → Supervisor/Process/RuntimeController wiring → `POST /api/processes/:processId/goal` (action enum validation, objective required for set/replace, 404/400/502 semantics matching the compact route) → a "Goal…" SessionMenu entry for owned ZCode sessions opening a small dialog: current goal status via `action: "show"`, objective input with Set/Replace buttons, and Pause/Resume/Clear actions; responses surface as toasts (the CLI's `startedTurn` on set/replace is normal behavior of an explicit user action; the objective text is never logged). Protocol-level finding recorded in the support doc: rewind/checkpoint and cancelBackgroundTask UIs are not feasible on CLI 0.16.1 — the app-server offers no method to enumerate checkpoints or background tasks
- ZCode P5 native advanced capabilities, aligned with other providers: subagent transcript display (the reader maps the parent `Agent` tool call to its child session through `~/.zcode/cli/agents/<parentSessionId>/agent_*/metadata.json` — whose `parentToolUseId` matches the parent's tool part callID and whose `childSessionId` matches the sqlite `subagent_child` row — and renders the child transcript through the shared agent-tree UI with descriptor/metrics); mid-session context compaction (`session/compact` full chain: `AgentSession.compact` → Process/RuntimeController → `POST /api/processes/:processId/compact` → SessionMenu "Compact context" entry, shown only for owned ZCode sessions); mid-session reasoning/thought-level switching (`session/setThoughtLevel` with fail-closed validation against the current model's advertised thought levels, `POST /api/processes/:processId/reasoning-effort`, and level chips in the model switch modal fed by the provider's model catalog, en + zh-CN copy)
- ZCode image/file attachments on outbound messages: structured uploads and pasted base64 images are now forwarded as native `session/send` `attachments` records (`{kind: "image"|"file", filename, localPath|dataBase64, mimeType, sizeBytes}`) instead of only appearing as text paths in the prompt. The wire shape matches the CLI 0.16.1 attachment normalizer (loose records validated by live probing); the key is omitted entirely when a message has no attachments so the strict params schema never sees an empty array
- ZCode branch-state view for edit-fork families (branch switcher arrows, aligned with the OpenCode experience): `buildZCodeBranchView` derives each fork's boundary without stored metadata — the child's copied prefix (fresh ids, identical text) is matched against the parent by strict same-index text comparison, and the first user message after the prefix (the edited original) anchors the sibling grouping, so the original and edited prompts render as 1/2 branch alternatives and navigate across native sessions. The zcode reader assembles the family from sqlite `parent_id` unioned with Yep's `forkParentSessionId` sidecar metadata, serves it through `LoadedSession.branchState` (including `?branchId=` selection), and normalization annotates zcode user prompts (fresh-id copied prompts resolve back to canonical options by timestamp+text). Requires no client changes — zcode message uuids already equal native message ids
- ZCode bridge v1: supervision of externally started `zcode tui` sessions plus remote tool-approval forwarding (aligned with the OpenCode bridge capability, minimal scope). A new ZCode hook plugin (`packages/server/resources/zcode-plugin/` — `.zcode-plugin/plugin.json`, `hooks/hooks.json` registering all 7 CLI hook events, and `hook-entry.mjs`) forwards hook events to the main server; `PermissionRequest` waits for a client decision through a server-side long poll comfortably below the hook's `timeoutMs`, and every failure mode (no config, timeout, server error) exits silently so the TUI falls back to its native dialog. Server: `ZCodeBridgeService` (external-session registry fed by SessionStart plus hook keepalives and a quiet-session TTL — ZCode's `Stop` is turn-level, not SessionEnd — pending-permission queue, mtime-cached shared token from `~/.zcode/yep-bridge.json`) and `POST/GET /api/zcode-bridge/*` routes — the hook endpoint authenticates with the shared token (exempt from cookie auth via a middleware skip), client endpoints use the normal client auth. Client: a lightweight approvals card on the global sessions page (5s polling, approve/deny, tool + workspace + input preview, en + zh-CN copy). `scripts/install-zcode-yep-plugin.sh` copies the plugin into `~/.zcode/plugins/yep-bridge/`, expands absolute node/hook paths, writes the shared token (mode 600), and registers the directory in `plugins.dirs` with a config backup; `--uninstall` undoes all of it
- ZCode MCP server status visibility (first provider to expose MCP listing): `mcp/list` wiring with strict shared schemas (`ZCodeMcpListParamsSchema`/`ZCodeMcpServerStatusSchema`/`ZCodeMcpListResultSchema`); a new optional `AgentProvider.listMcpServers(cwd)` that spawns a short-lived app-server purely for the query and always sends `mode: "status"` (read-only, no MCP connections are opened) and projects only the safe fields (status/transport/toolCount/updatedAt/error — raw server config never leaves the CLI); `GET /api/providers/zcode/mcp-servers?projectId=<id>` (400 missing projectId, 404 unsupported, 503 capability failures with stable `zcode_*` code, 502 protocol errors); the new-session form shows an informational ZCode MCP Servers section (name + lifecycle status + tool count + failure summary, one fetch per provider selection, en + zh-CN copy)
- ZCode historical message editing via `session/fork` (edit-fork, aligned with the OpenCode experience): editing a persisted user prompt resumes the source session, locates the edited message through `session/messages`, forks the session at the predecessor message (ZCode message targets are inclusive, so the fork excludes the edited message and everything after), closes the source, and runs the new turn on the forked session which inherits the source's mode/model/thought level (explicit overrides are re-applied via `session/setModel`/`session/setMode`). Editing fails closed with a stable error when the edited message is unknown or is the session's first message. Shared `zcode-schema` gains strict `session/messages`/`session/fork`/`session/close` contract schemas and the `zcode_first_message_edit_unsupported` error code; the supervisor re-keys the process onto the fork's native id; `SessionCommandService` forwards `resumeSessionAt`, records `forkParentSessionId` lineage, and returns it in the resume response; the ZCode SQLite reader lists interactive fork children (still hiding `subagent_child` sessions) and surfaces native `parent_id` lineage so fork families collapse in the list views; the client enables historical editing for persisted ZCode prompts and reuses the provider-agnostic fork submission/navigation path
- ZCode per-model reasoning effort ("thought level") support: the config adapter now parses each model's `reasoning` capability (`{enabled, variants, defaultVariant}`) into catalog `thoughtLevels`/`defaultThoughtLevel`, `getAvailableModels()` advertises them as `supportedReasoningEfforts`/`defaultReasoningEffort`/`supportsEffort`, and the resolved level is sent as `thoughtLevel` on `session/create`/`session/resume`. Mirrors the CLI's own guard (`resolveZCodeThoughtLevel`): a level the selected model does not advertise is dropped rather than sent, and a model with `reasoning: null` (e.g. GLM-5.2) advertises none so the picker stays hidden
- ZCode ask/edit/plan/full-access mode copy on the new-session form and session mode selector, matching ZCode's own picker wording; previously the `modeZcode*`/`newSessionZcode*` strings were unreachable because `useProviderPermissionModeConfig` had no ZCode branch
- ZCode SQLite reader, project scanner, and persisted-session normalization (P2): `ZCodeSessionReader implements ISessionReader` with read-only `~/.zcode/cli/db/db.sqlite` queries (session/message/part tables, correct sequence ordering, change detection, listSessionFiles, index scope key); `ZCodeSessionScanner` with `GROUP BY directory` project aggregation and 5s cache; enriched `convertZCodeMessages` handling text/reasoning/tool (tool_use + tool_result)/step parts; provider-resolution `createZCodeSource`/`mayHaveZCodeSessions`/`buildCandidateGroups` wiring; scanner.ts `enableZCode`/zcodeScanner merge block/`getOrCreateProject` detection; app.ts `readerFactory`/`zcodeReaderFactory`/`processSessionSourceFactory`/route deps wiring; provider-catalog `zcodePaths`/`zcodeScanner`; read-only safety (fixture hash unchanged after reads)
- ZCode provider real-time session MVP (P1, 2026-08-12 real protocol fix, real model smoke happy path verified): `ZCodeProvider implements AgentProvider` with real ZCode CLI 0.16.1 protocol contract — `session/create` sends `workspace` (not `cwd`) and result is parsed from `result.session.sessionId` (not `result.id`); `session/resume` uses `sessionId` (not `id`); `session/send` uses `content` string (not nested message object); `session/setModel` uses `model: {providerId, modelId}` (not top-level fields); `workspace/updateProviderRegistry` sends `{workspace, registry: {revision, generatedAt, providers[]}}` with `apiKey: {source: "inline", value: ...}`; protocol event converter uses real `type`/`payload`/`seq` envelope (not `event`/`params`); `interaction/requestPermission` → `onToolApproval` routing; `interaction/requestProviderRuntimeHeaders` returns real provider headers; `session/requestRuntimePreferences` returns `{nativeSearchEnhancementsEnabled, memoryEnabled}`; `ensureCliConfig()` auto-creates `~/.zcode/cli/config.json`; `session/setMode` mid-session switching; `zcodeDbPath`/`zcodeReaderFactory` passed through provider resolution deps; real model smoke verified complete happy path: create → subscribe → send → model.streaming (reasoning_delta + text_delta) → turn.completed with usage, against live CLI 0.16.1
- ZCode provider compatibility contract and infrastructure (P0, 2026-08-12 real protocol fix): shared `zcode-schema` Zod schemas aligned to real CLI 0.16.1 — no `jsonrpc` field required in request/response/notification/server-request envelopes; workspace identity (`workspacePath`/`workspaceKey`), model ref (`providerId`/`modelId`), session params (create/resume/send/setModel/setMode/subscribe), session snapshot, and event envelope (`type`/`payload`/`seq`/`sessionId`) schemas; server `zcode-protocol` transport client omits `jsonrpc` from outbound messages; CLI discovery (env → PATH → macOS app bundle) with version probe; server-only config whitelist adapter supporting real `provider` object map (singular), `models` object map, `options` (apiKey/baseURL/headers), `enabled`/`systemDisabledReason` fields; registry builder outputs real `providerId`/`modelId` structure; read-only smoke verified against real CLI 0.16.1 (workspace/readState + session/list pass without timeout)
- Expose DeepSeek V4 Pro in the Codex model-source catalog (`deepseek-codex-2026-08-13`): `deepseek-v4-pro` joins `deepseek-v4-flash` in the new-session picker and `allowedModelIds`, with the same 1M context / 384K output and official `low/high/max` reasoning tiers
- Add a model-aware Kimi thinking-mode picker, apply the selected ACP thought level before the first prompt, and preserve it across session reloads and resumes
- APK-local mobile shell connection and diagnostics panel with editable server address, retry/default recovery actions, an always-available connection shortcut, bilingual copy, and copyable app/WebView connection details
- Process-level `CodexProjectionCache` with LRU/event-count waterlines and incremental projection replay; warm projections apply only events newer than the cached sequence instead of cold-reducing the full history
- Size-based rotation for the canonical Codex event journals: when the active `events.jsonl` reaches `YEP_CODEX_EVENT_STORE_ROTATE_BYTES` (default 256 MiB) the next append renames it to a timestamped segment (`events.{yyyyMMddHHmmssSSS}.jsonl`) and prunes closed segments beyond `YEP_CODEX_EVENT_STORE_KEEP_SEGMENTS` (default 3). Cold loads transparently aggregate retained segments in chronological order, per-session sequences stay continuous across segment boundaries, and rotations are logged via `codex_event_store_rotated`. Applies to both the provider journal and the 4510 bridge journal, bounding their disk growth (previously ~190 MB/day, unbounded)
- Cache-aware canonical source selection that validates projection prefixes after journal replacement while long-lived JSONL stores refresh only appended file bytes
- Soft time budget (`budgetMs`/`startedMs`) on the canonical overlay with `CodexOverlayBudgetExceededError`; the route catches budget expiry at overlay checkpoints and falls back to legacy normalization
- Structured diagnostic logging on the canonical overlay path: journal replay duration, overlay duration, total duration, cache hit/miss, event count, projected message count, and fallback outcome
- Synthetic benchmark script `scripts/bench-codex-overlay.ts` covering 100/1k/2k/5k/10k/20k event scales with cold reduce, warm apply, overlay, budget exceeded, and RSS/heap delta measurements
- Codex goal UI: the "Goal…" SessionMenu entry and `GoalModal` dialog are now available for owned Codex sessions (previously ZCode-only). The provider adapts the neutral goal actions to native `thread/goal/*` controls: replace clears the previous goal before setting a new active objective, pause writes a non-active status, resume writes `active` (which may make an idle Codex goal runtime start an automatic continuation), clear distinguishes an actual removal from an already-empty goal, and show formats objective, status, token budget/usage, and elapsed time in a TUI-style summary. Goal RPC completion alone does not prove whether a turn started; full automatic-turn supervision and new-session Goal-first remain tracked in `docs/project/2026-08-14-codex-goal-support-plan.md`
- Codex sub-agent transcript access: the session manifest indexes sub-agent sessions by `parent_thread_id` and retains their path/nickname/role/depth metadata. `CodexSessionReader` links durable paginated `item_completed` SpawnAgent items to child rollout files using the real call id, supports nested sub-agent parents, validates project/session lineage, normalizes child transcripts, and derives failed/interrupted/completed lifecycle from terminal events (including `task_complete.error`). The Session Inspector recognizes native sub-agent activity/collaboration items and links each child thread to its session page
- Codex native ThreadItem rendering (plan, sub-agent activity, collaboration): the canonical transcript view now turns `codex_native_item` system messages into dedicated proposed-plan, checklist, goal, and sub-agent blocks with English and Simplified Chinese copy. V2 `subAgentActivity` and V1 `collabAgentToolCall` payloads preserve current lowercase activity kinds and status-only agent states; unknown ThreadItem types render a compact escaped label instead of vanishing. Existing `compact_boundary`/`warning`/`turn_aborted` system rendering is unchanged
- Codex canonical goal and plan state: `thread/goal/updated` and `thread/goal/cleared` now reduce into the latest per-thread goal snapshot and project a current `threadGoal` item that remains visible outside the recent-item window until cleared. `turn/plan/updated` retains its full explanation/checklist payload and original event sequence, preventing a later turn event from duplicating or relocating the rendered plan row

### Changed
- Move the current Codex Goal snapshot out of the chronological transcript and into Session Inspector, where it is derived from the authoritative `thread/goal/updated` objective rather than any user prompt; plan and goal state cards now stay available in the right-side session outline without being pinned beside the newest message
- Retire the Claude Code SSH channel from the active provider catalog, new-session flow, and provider settings, and stop provider refreshes from probing the remote Claude CLI; historical Claude session metadata and transcript rendering remain compatible
- Install deployment bundle runtime dependencies directly from `https://registry.npmmirror.com/` by default, ignoring inherited proxy settings and preferring the local npm cache; `YEP_DEPLOY_NPM_REGISTRY` can override the registry when needed, and deployment logs now show the selected network path
- Render Feishu-origin user prompts as compact channel messages instead of exposing raw context/attachment manifests: internal refs, hashes and operator IDs are hidden, generated image placeholders collapse into named preview chips, downloaded files become actionable links, and safe HTTP(S) document links in the message body open directly
- Harden the managed DeepSeek Codex provider for transient upstream overloads with eight HTTP/SSE retries, a ten-minute stream idle window, explicitly disabled OpenAI authentication/WebSocket inheritance, and a visible automatic-retry notice
- Gate the canonical Codex overlay behind an explicit `view=canonical` query. The transcript client opts in because it renders canonical native items; other Session GET consumers retain the lower-cost legacy normalization path, and the overlay keeps its projection budget/fallback safeguards for long journals
- Rewrite the canonical Codex event reducer as a linear batch builder that clones the initial projection once and uses `Set`-based dedupe indexes, eliminating per-event `structuredClone` of the entire state and O(N) array `includes` that made batch replay approach quadratic complexity
- Pre-build semantic duplicate and legacy item-id indexes in the canonical session overlay so candidate matching no longer rescans the full message list per candidate
- Fast-path `insertByTimestamp` by checking the tail element first, turning the common time-ordered append case from O(N²) into O(N)
- `JsonlCodexEventStore` now tracks file size/mtime and only reads the appended tail on subsequent replays, avoiding a full-file `readFile` when a long journal has only grown
- JSONL source factories now share a single `JsonlCodexEventStore` instance per file path so the incremental file refresh works across requests
- Window canonical candidate construction by a recent-event lower bound when the caller only needs the tail, avoiding Message construction for old projection items while still replaying complete state
- Update the built-in mobile shell `mini` node to its current connection endpoint

### Fixed
- Prevent wide code and diff results from making the APK transcript itself horizontally pannable; horizontal scrolling now stays inside the renderer that owns it, so a right swipe cannot drag the mobile message viewport out of bounds
- Keep the APK shell from covering session search, outline, and info actions with its persistent connection pill: custom endpoint recovery and diagnostics now open from Settings → Local Access (and still appear automatically on connection failure). Synchronize the edge-to-edge safe-area background plus Android status/navigation bar icon contrast with the embedded client's selected `light`, `dark`, `verydark`, or resolved `auto` theme
- Let Codex bridge MCP startup progress settle when `cf` uses a light or clear per-thread profile: Codex 0.147 derives the TUI's expected startup set from the unprofiled local config, while app-server emits status only for profile-enabled servers, leaving the header stuck on the last real MCP (often `feishu-mcp`). After a successful thread start/resume/fork, the bridge now sends terminal UI-accounting events for client-expected servers disabled by the selected profile; this neither enables those servers nor adds tools, and synthetic events stay out of bridge diagnostics
- Prevent provider transcript rows from multiplying across reconnects: Codex live lifecycle items and persisted rollout messages now reconcile by their native turn/item identity instead of text-and-time heuristics alone, while ZCode suppresses replayed event sequences, consumes the real strict `message.upserted` payload, and assigns stable identities to reasoning and tool rows
- Preserve Kimi's active permission mode when approving an `ExitPlanMode` review, so a YOLO session no longer falls back to manual approval before implementation or passes that downgraded mode to subagents
- Prevent Kimi ACP sessions from silently dropping later items in a batched `AskUserQuestion`: the host now tells Kimi to ask one question per call, retry any omitted question separately, and never infer a Recommended default; persisted and live Kimi JSON answer results are also normalized so transcripts show the real answered count and selected option instead of `0 answered`
- Keep each transcript Thinking disclosure independent, so expanding or collapsing one reasoning block no longer changes every reasoning block in the current session or nested subagent transcript
- Deduplicate Codex code-mode plan progress between the transcript and Session Inspector, keep native-only turn-plan snapshots available in the inspector, and suppress canonical reasoning/command/message placeholders that only repeated normalized transcript activity as empty label cards
- Normalize Kimi `TodoList` progress consistently across live ACP updates and persisted wire replay: structured writes now collapse into the Session Inspector plan, read-only queries remain visible tool rows, and the duplicate ACP `plan` notification no longer appears as fake reasoning that vanishes after refresh
- Show the context-usage indicator on first entry into a session instead of only after navigating away and back: both bridge-owned and stdio app-server Codex sessions now consume `thread/tokenUsage/updated` as it arrives (using fresh input tokens normally and the compacted total when post-compaction input is zero); the stdio provider projects live `system/turn_usage` messages instead of waiting for `turn/completed`, while the bridge persists usage and carries it on session summaries and `session-updated` events (including the sidecar poll diff). The Session GET extracts both live and completed Codex usage with the SDK-reported context window, and the client applies early live messages and metadata events even around its initial load, retaining a delayed metadata retry only as a fallback
- Reset the APK mobile shell to the destination server's project list when switching endpoints instead of carrying over the previous server's project/session route and surfacing `Project not found`; same-endpoint retries still preserve the current page
- Keep long-running `/goal` workflow sessions in the regular session list and sidebar instead of classifying them as one-off slash-command sessions
- Keep ZCode's shared SQLite store intact when archiving one session by toggling only that project-scoped row's `time_archived`, and require the configured project directory for every ZCode summary/content/stats lookup so a guessed session ID cannot cross project boundaries. Compatibility credentials are now carried into the in-memory provider registry, malformed non-string runtime headers fail closed, MCP status errors are credential-redacted, and the hook installer explicitly enforces `0600` on both bridge and CLI config files
- Refuse Codex bridge status endpoints on unrelated hosts before attaching the desktop bearer token; wildcard bridge listeners are rewritten to the configured control host, while loopback aliases remain interoperable
- Prevent ZCode provider discovery and model/MCP queries from copying credential-bearing `v2/config.json` data into `~/.zcode/cli/config.json`: bootstrap creation now occurs only when a managed session starts, writes only the selected composite model with atomic `0600` permissions, preserves existing content while tightening its mode, and keeps all query paths read-only. Keep external sessions registered across turn-level `Stop` hooks until their quiet-session TTL expires, and distinguish interactive edit forks from `subagent_child` rows so fork updates remain live while internal transcripts stay out of user indexes. The shared ZCode request contracts now mirror the CLI's strict schemas at top-level and nested workspace/model/registry boundaries so extra keys fail tests before reaching the app-server
- Restore ZCode live assistant streaming: the real CLI 0.16.1 `model.streaming` payloads carry chunks in `delta` (not `text`/`reasoning`), identify messages with `assistantMessageId` (not `messageId`), flush `tool_input_delta.delta` as a full accumulated snapshot (not an increment), and send the parsed `input` object on `tool_call` — the converter read the legacy fixture spellings, so live assistant text and reasoning were silently dropped and streamed tool inputs could be corrupted. The converter now reads the real fields (legacy spellings kept as fallbacks), the fake app-server emits the real shape, and new converter tests lock the contract. Verified by an authorized live-model smoke: registry apply → session/create → streamed marker text → turn.completed with usage → file attachment round-trip (model echoed the attached file's content) → exclusive edit-fork (child omits the replaced prompt) → mcp/list
- Preserve the last retryable Codex provider cause when automatic retries end in an unclassified error, and restore provider retry/failure messages after refresh through a method-indexed lightweight journal overlay without re-enabling the expensive canonical item projection
- Prevent adjacent Feishu merge-forward material and its instruction from producing duplicate replies by batching at durable ingress before slow normalization, while preserving one provider turn per reply card when inputs miss the batching window
- Unblock ZCode session creation: the real CLI 0.16.1 validates `workspace/updateProviderRegistry` with a strict schema that requires each `registry.providers[]` entry to carry a non-empty `models` array of bare `{modelId}` entries and rejects `name` keys at both the provider and the model level, but the registry builder emitted `name` and omitted `models` for providers without catalogued models, so every update failed with `-32602 Invalid params — registry.providers.0.models: expected array, received undefined; Unrecognized key: "name"` and no ZCode session could start. The builder and shared schemas now match the probed live contract (providers with zero models are skipped entirely), verified end-to-end against the live CLI 0.16.1 with the machine's real config (registry `status: "applied"`, model catalog populated)
- Resolve Codex session reasoning effort against the selected model source's advertised tiers: DeepSeek uses its official `low/high/max` set and compatibility mapping (`medium`/`xhigh` → `high`), with unknown higher tiers clamped to `max` and other unknown values falling back to the model default (`high`); OpenAI keeps the full tier set. This applies on new sessions, resume, edit-fork, queued messages, and stale effort values read back from a previous turn
- Use the 4520-managed OpenCode server's connected model catalog for Yep's picker and turn execution, including treating a successful empty provider list as authoritative instead of falling back to another process's CLI catalog; hide models from providers unavailable to that runtime, and remap stale provider-qualified session selections to the sole connected provider exposing the same model ID. This prevents failures such as `ProviderModelNotFoundError: Model not found: deepseek/deepseek-v4-pro` when the executable route is `ohmyrouter/deepseek-v4-pro`
- Stop offering ZCode's `auto` permission mode: ZCode CLI 0.16.1 denies every tool call in that mode (`mode.auto.unimplemented`, "Auto mode is reserved but not implemented yet") and its own picker exposes only build/edit/plan/yolo. Because Yep's canonical `DEFAULT_PERMISSION_MODE` is `auto`, advertising it made it the implicit default for new ZCode sessions and blocked every tool. The provider now advertises `default`/`acceptEdits`/`plan`/`bypassPermissions` only, and `YEP_TO_ZCODE_MODE_MAP.auto` degrades to `build` so sessions persisted before the withdrawal still run
- Stop sending `model` and `mode` on ZCode `session/resume`: the real params schema is `.strict()` and accepts neither key, so every resume that carried a selected model or permission mode failed with `-32602 Invalid params`. Both are now applied after the session exists via `session/setModel`/`session/setMode`. The test fixture now enforces the real CLI's strict param allowlists so this class of contract violation fails in CI instead of only against the live CLI
- Stop advertising a ZCode thinking toggle the provider could not apply: `supportsThinkingToggle` was `true` while nothing read `options.thinking` or called `session/setThoughtLevel`, so the control was a no-op. ZCode's reasoning control is a named per-model thought level and is now surfaced through `supportedReasoningEfforts` instead
- Normalize ZCode `turn.completed` usage into canonical token fields (`input_tokens`, `output_tokens`, `reasoning_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`) instead of passing the raw provider object straight through, so ZCode sessions report token usage in the UI. Accepts the AI-SDK camelCase, Anthropic, and OpenAI spellings the CLI itself reads, and falls back to `cacheStats.cacheReadTokens` when the usage object omits cache accounting
- Keep a ZCode model in the catalog when its `reasoning` capability has an unexpected shape, instead of letting the malformed field drop the whole model
- Rejoin 4510-owned Codex sessions through the resident bridge WebSocket instead of spawning a competing stdio app-server, including active-turn steering and a typed bridge error; route resumed direct OpenCode TUI sessions through a 4520/plugin command channel so prompts, permission changes, and aborts execute in the original process instead of silently switching to 4521
- Surface Kimi ACP refusals and prompt failures as visible session errors, and preserve persisted `turn.ended` provider errors such as `provider.filtered` after transcript reloads
- Make LaunchAgent log-size detection portable across BSD and GNU `stat` by discarding partial output from a failed probe before falling back
- Restore Kimi CLI 0.34 session discovery by normalizing v2 `state.json` metadata (`cwd` and numeric timestamps), watching Kimi session files, invalidating summary/search indexes, and accepting the current ACP `usage_update` notification shape
- Make local 8022/4510/4520 deployment cutovers safe and deterministic: serialize CLI/UI deploys, wait for embedded active work, reject conflicting dev auxiliary ports before shutdown, reload bridge LaunchAgents from the promoted runtime, preserve the real previous bundle on duplicate syncs, and persist detached job exit results across the 8022 restart
- Restore uploaded-image preview modals without re-exposing server-local paths by projecting managed attachments to validated, authenticated API URLs in live and persisted session messages
- Keep the Reports page pointed at the repository-adjacent `research_tasks` directory after LaunchAgent runtime isolation by persisting an absolute `YEP_REPORTS_DIR`, reloading updated server plists at the coordinated restart point, and retaining a repository-root fallback
- Keep the APK recovery panel visible until the embedded Yep Anywhere client sends its real ready signal, and migrate the retired `43.226.60.75:61874` default instead of letting persisted app data override the current endpoint
- Keep canonical transcript export and Feishu/Lark projection on their original canonical journal paths so they are unaffected by the normal Session GET capability gate
- Preserve in-progress agent, plan, and reasoning stream content when the canonical item-start snapshot still contains empty placeholder fields
- Load the canonical Codex event journal in bounded chunks instead of a single `readFile`: once `events.jsonl` grew past the runtime's maximum string length (~512 MiB) every cold store load threw `RangeError: Cannot create a string longer than 0x1fffffe8 characters`, which surfaced as new Codex sessions failing immediately after `thread/start` (`API error: 500`). A failed cold load also no longer poisons the store for the process lifetime — the next caller retries instead of rethrowing the cached rejection
- Show live Kimi subagent activity while a foreground `Agent`/`AgentSwarm` call is still running, instead of pinning the card to "waiting for first activity" until it finishes: Kimi's ACP adapter never streams child events, and the child's id only traveled inside the parent tool result, so the client could not locate the on-disk transcript beforehand. The reader now maps explicit `resume`/`resume_agent_ids` back to their existing child directories and assigns new pending spawns provisional ids from the remaining `agents/<id>/` directories in call order, bounded by each call's declared item count. The client keeps partially discovered swarms unresolved, retries briefly for directory-creation lag, re-reads mappings when later child wire files appear, and replaces provisional ids with result-backed identities once children complete

### Security
- Restrict deploy env files, LaunchAgent plists/logs, and deployment job state to private permissions, and rotate oversized LaunchAgent logs during installation

## [2026.8.2] - 2026-08-10

### Changed
- Restore the pre-canonical session rendering and navigation experience while retaining the self-hosted Feishu/Lark channel backend, durable interactions, and safe deployment runtime
- Run every OpenCode SQLite read on a dedicated worker thread with a query deadline, a soft budget, and structured `durationMs`/timeout diagnostics, so a slow scan of a multi-gigabyte `opencode.db` can no longer stall the API thread, WebSocket traffic, or heartbeat timers
- Create `yep_`-prefixed `time_updated` helper indexes on `opencode.db` at startup, guarded by an upstream-schema check and disabled by `OPENCODE_DB_ENSURE_INDEXES=false`, turning incremental change scans from full table scans into covering-index range searches

### Fixed
- Load `.env.deploy.local` in `scripts/install-launchagents.sh` so a standalone LaunchAgent reinstall no longer rebuilds the plist without the session-title, OpenCode model, and FCM credentials that `scripts/deploy.sh` already supplies
- Stop resolving single-session OpenCode stats through a whole-database aggregation; the freshness check for one session no longer costs a full `message`/`part` scan, which dominated session listing and search latency
- Drop the per-refresh `SUM(LENGTH(data))` over every OpenCode message and part, replacing the session-index change token with row counts that need no payload reads (forces one re-index of OpenCode sessions after upgrade)
- Bound the OpenCode change-monitor replay window inside each `UNION` branch; it previously aggregated `session`, `message` and `part` in full on every drained poll
- Replace the OpenCode replay fingerprint's full-row `SELECT *` with an aggregate digest, and batch the reader's per-message part lookups into grouped queries, removing the N+1 reads behind session detail and project listings
- Fix an out-of-scope `base` reference that made an OpenCode subagent-listing test throw, and load `node:sqlite` through `process.getBuiltinModule` in tests so the OpenCode SQLite suites actually execute under Vitest instead of silently skipping

## [2026.8.1] - 2026-08-09

### Added
- Check in a complete Codex app-server 0.147.0 stable/experimental protocol baseline with deterministic schema manifests and explicit coverage guards
- Add a durable, redacted Codex event spine with replay, diagnostics, canonical transcripts, and shadow-by-default bridge/provider ingress
- Centralize pending approvals and questions behind a durable at-most-once CAS interaction authority, with authenticated Codex sidecar claims and lifecycle recovery
- Harden resident provider ownership with atomic worker admission, restart-safe terminal replay, fail-closed message queues, stable Codex turn controls, and redacted bridge diagnostics
- Add a provider-neutral session application layer with source-preserving Codex forks, lineage, structured Skills input, native controls, and authenticated canonical transcript export
- Add bounded attachment extraction and generated-artifact materialization with opaque references, exact-event provenance, retention, and verified downloads
- Add an inert-by-default self-hosted Feishu/Lark channel with isolated accounts, durable inbox/outbox, CardKit replies, broker-backed interactions, commands, diagnostics, and read-only migration preflight
- Add typed client rendering for native Codex activity, Skills, subagents, fork lineage, canonical interactions, artifacts, transcript export, and Feishu account settings
- Expose the pinned Codex protocol identity and bounded fingerprint-only compatibility diagnostics through the version API

### Changed
- Align `.nvmrc` and `.node-version` on Node 22.22.2, verify the repository-pinned pnpm through Corepack, and keep deploy entry points independent of incidental global toolchains
- Run macOS LaunchAgents from an atomically promoted repository-external runtime bundle while retaining one verified previous bundle for rollback

### Fixed
- Keep JSON and other non-media OpenCode uploads on the tool-readable local-path flow instead of forwarding unsupported MIME types as native model attachments
- Preserve image/PDF input for Anthropic OpenCode models that use the legacy `attachment: true` capability by emitting the `modalities` declaration required by current OpenCode

### Security
- Keep Feishu/Lark app secrets write-only and exclude message content, answers, provider tool input, raw identities, credentials, and private paths from durable projections and diagnostics
- Bind generated artifacts and channel callbacks to exact event, actor, scope, generation, digest, and workspace provenance before exposing downloads or external actions

## [2026.8.0] - 2026-08-06

> Backfilled summary covering the ~278 commits between `v0.4.28` and the start of
> the independent fork release line. The `0.4.29` recorded in `package.json`
> during this period was an intermediate working version that was never formally
> released, so it has no section of its own. Entries below are a thematic
> summary rather than a per-commit reconstruction. See
> `docs/project/versioning.md` for the release model.

### Added
- Multi-provider sessions: OpenCode, Codex and Kimi CLI (over ACP) alongside Claude, with provider-neutral session branches
- Per-session model source selection, provider-prefixed model grouping, and model reasoning variants
- SSH remote executors, relay host picker, remote terminal, and remote Claude project support
- Device bridge: app-server bridge sidecar, session inspector, and bridge turn health indicators
- Global conversation search and in-session message search
- Subagent sessions, transcripts, and swarm details rendered inline
- Multimodal image input, native file part uploads, and inline comments with image assets
- Context window breakdown modal backed by a persisted window cache
- Actionable approve/deny directly on pending-input notifications
- Interactive deploy flow and a dev hot-reload deploy action
- Browsable project path picker and project-filtered session shortcuts
- Sidebar session bulk actions, project activity, and git status summaries
- Codex account usage display on the new-session form
- Independent fork release line: builds carry a release channel and no longer offer upstream releases as updates
- Mobile shell preset for the home node

### Changed
- Version numbers are calendar-based (`YYYY.M.N`), replacing SemVer; they can no longer be confused with an upstream release
- Device bridge binaries are fetched from this repository rather than upstream's releases, and can be redirected with `YEP_BRIDGE_REPO`
- Approvals are driven through native ACP session modes, with provider-specific permission modes surfaced in the new session form
- The selected permission mode is remembered per session, survives provider restarts, and can be changed while a session is idle
- Session state machine and rewind accuracy realigned with upstream part coverage
- Transcript rendering reworked: live exec output, MCP cells, warnings, markdown details blocks, web tool outputs, and the AskUserQuestion UI
- Change signals are pushed rather than polled, removing polling latency
- Session message list is virtualized; git status, session stats, summaries and deterministic text rendering are now cached
- WebSocket frames are compressed
- Desktop layout widened with collapsible side panels

### Fixed
- Session titles are retried, backfilled, and preserved across boilerplate events
- OpenCode provider startup hardened; spurious change events no longer emitted
- Codex MCP profile compatibility across different launch environments
- Codex sessions no longer fail to start when the local MCP configuration does not match Yep's expected server list
- Anthropic-compatible gateways no longer reject tool calls over schemas Bedrock cannot accept
- Codex model source and live messages preserved across resume and snapshot refresh
- Server LaunchAgent restarts after crashes

### Removed
- Desktop auto-updater, which pointed at upstream's update service and verified against upstream's signing key — upstream builds could install over this fork, and this fork can never sign an update of its own

## [0.4.28] - 2026-04-16

### Changed
- Upgrade claude-agent-sdk to 0.2.111 (adds Opus 4.7 support)

## [0.4.27] - 2026-04-16

### Fixed
- Preserve provider on session restarts

## [0.4.26] - 2026-04-13

### Fixed
- Prefer persisted provider for session resume and agents

## [0.4.25] - 2026-04-13

### Added
- Core workspace setup script

### Fixed
- Fix clearing empty server settings
- Keep idle Claude sessions owned while alive
- Fix Codex sessions not appearing in All Sessions on Windows
- Fix Windows spawn ENOENT and EINVAL in scripts
- Fix notification read-state persistence on restart
- Fix Windows project path deduplication

## [0.4.24] - 2026-04-05

### Added
- Lifecycle webhook support
- ToolSearch schema validation
- Claude metadata session entry handling
- Relay host upsert on auto-resume for reliable reconnect

### Changed
- Update claude-agent-sdk to 0.2.90
- Update Claude model selection options
- Move persist-remote-sessions toggle to Remote Access settings
- Align Codex session schema with upstream types

### Fixed
- Avoid new-session remounts on project refresh
- Allow local image access to managed uploads
- Fix relay host ID race condition during session refresh
- Fix modal title overflow on long names

## [0.4.20] - 2026-04-02

### Added
- Local media preview modal for file paths in markdown
- Prefer recent project for new sessions

## [0.4.19] - 2026-03-29

### Added
- Centralized cross-provider session listing
- Session summary caching for Gemini and Codex providers
- Safe HOME guards for dev and test entrypoints

### Fixed
- Fix streaming edit patch filenames
- Improve PTY and Codex PTY tool rendering
- Fix mixed-provider session resolution and titles
- Preserve Claude sibling ordering on reload
- Stabilize session replay and queued prompt rendering
- Detect Codex CLI from desktop app sandbox-bin location

## [0.4.18] - 2026-03-27

### Added
- New session defaults: save preferred provider, model, and permission mode
- Local image viewing for Codex imageView events
- Scoped session indexing for shared providers

### Fixed
- Resolve allowed image paths for macOS /tmp symlink
- Deduplicate sessions on Windows caused by mixed-slash cwds
- Improve provider process handling

## [0.4.17] - 2026-03-22

### Fixed
- Widen tool_result content type for broader SDK compatibility
- Stabilize Claude persisted session rendering
- Guard localStorage calls in i18n module
- Prevent false unread notifications from late JSONL writes
- Exclude progress messages from DAG to prevent dead branches

## [0.4.16] - 2026-03-21

### Added
- Client-side i18n with lazy-loaded locale bundles (English, Chinese, Spanish, French, German, Japanese)
- Language selector in Appearance settings

## [0.4.15] - 2026-03-19

### Fixed
- Pin @biomejs/biome to 1.9.4 to fix CI (pnpm resolved ^1.9.4 to breaking 2.x)

## [0.4.14] - 2026-03-19

### Added
- Provider filtering and voice input toggle via environment variables
- Dynamic model list and Claude profile support
- Age filter and bulk archive for filtered sessions
- Approval panel truncation with view-details modal for large tool calls

### Changed
- Update Claude Agent SDK to 0.2.77

### Fixed
- Prevent NODE_ENV=production from leaking into Claude Code child processes (#41)

## [0.4.13] - 2026-03-15

### Changed
- Update Claude Agent SDK to 0.2.76 with runtime context window detection
- Support SDK 0.2.76+ Agent tool format and subagents directory
- Version-aware device bridge updates
- Restore iOS simulator home button

## [0.4.12] - 2026-03-13

### Added
- iOS simulator device bridge support with HID input
- Improved iOS simulator bridge preflight error messages

### Changed
- Reduce routine update checks

## [0.4.11] - 2026-03-12

### Added
- Relay telemetry and stats dashboard
- Relay server compatibility reporting
- Fetch version and bridge version from update server instead of npm registry/hardcoding

### Fixed
- Fix inbox race condition
- Prevent Enter key from triggering send during IME composition
- Relax relay resume proof skew tolerance

## [0.4.10] - 2026-03-10

### Added
- `/model` slash command for mid-session model switching
- Codex correlation debug logging

### Codex
- Improve replay deduplication
- Preserve timestamps on stream messages
- Improve session reconnect merging

### Fixed
- Fix Codex session titles on agents page
- Fix Codex session cloning in mixed projects
- Fix Codex session clone visibility
- Fix Codex session discovery defaults
- Reduce Codex debug logging overhead

## [0.4.9] - 2026-03-06

### Added
- ModelInfoService for accurate context window lookups
- PDF file previews in Read tool renderer
- Server timestamps to streamed SDK messages for replay dedup
- Stream vs persisted render parity harness
- Slash commands attached to session REST response

### Codex
- Keep pending Bash rows collapsed
- Improve image previews and Bash row summaries
- Normalize tool rendering (heredoc writes, bash, edit patches) across stream and JSONL
- Surface rate limit exhaustion as error messages
- Treat rate-limit updates as telemetry only
- Log Codex messages to sdk-raw

### Fixed
- Filter replayed stream messages using persisted timestamp watermark
- Fix getResultSummary crash for PDF Read results
- Fix live Codex edit patch previews for file changes
- Persist provider to session metadata for correct resume
- Detect claude-ollama sessions from model name in JSONL
- Skip Ollama detection ping when URL is explicitly configured

## [0.4.8] - 2026-03-03

### Added
- Android device bridge with WebRTC streaming and MediaCodec capture
- ChromeOS device transport and streaming with host aliases
- Ollama local model provider with customizable system prompt
- Adaptive bitrate and quality controls for device streaming
- Immersive keyboard mode for Android device input
- On-demand download for device bridge sidecar binary
- CI pipeline for device bridge sidecar binaries
- Emulator streaming E2E tests and validation scripts

### Fixed
- Fix Windows session spawning across all providers
- Fix session resume losing provider for non-Claude models
- Fix crash when tool result content is an array instead of string
- Stabilize Android stream startup and soak reliability
- Fix keyboard input mapping for emulator and Android streams
- Fix WebRTC video stream stalling after a few seconds
- Fix sidecar crash on WebSocket disconnect
- Fix emulator bridge cascading restart loop

### Changed
- Rename Emulator to Devices in sidebar and routes
- Refactor bridge to unified device interface with Android and ChromeOS transports

## [0.4.7] - 2026-03-01

### Added
- Draft badge in session sidebar, list, and inbox

### Fixed
- Fix Codex sessions not appearing due to truncated first-line read (#23)
- Fix duplicate message display when queuing deferred messages
- Fix stale detection killing busy processes and orphaning CLI sessions

## [0.4.6] - 2026-02-27

### Added
- Configurable tab size setting for code and diff display
- Codex scanner diagnostics for troubleshooting session discovery

### Fixed
- Fix Windows session discovery
- Fix Gemini session discovery for newer CLI versions
- Fix Codex/Gemini session discovery when ~/.claude/projects is missing

### Changed
- Update Gemini model list for v0.30.0 CLI
- Optimize Gemini session loading with generalized session index
- Extract shared JSONL/BOM utilities to reduce duplication

## [0.4.5] - 2026-02-25

### Added
- Session cloning support for Codex sessions
- Show session creation date in Session Info panel

### Fixed
- Fix Codex sessions failing with 'minimal' reasoning effort
- Fix broken image paths in README

## [0.4.4] - 2026-02-25

### Added
- 3-way thinking toggle: off / auto / on (model decides when to think in auto mode)

### Fixed
- Fix thinking "on" mode for Opus 4.6+ and wait for CLI exit on abort
- Reconnect session stream after thinking-mode process restart
- Fix context usage percentage being too low after compaction
- Fix DAG not bridging across compaction boundaries with broken logicalParentUuid
- Fix source control page issues

## [0.4.3] - 2026-02-23

### Added
- Source Control page with git working tree status
- File diff viewer: click any file to see syntax-highlighted diff with full context toggle and markdown preview
- Session sharing via Cloudflare Worker + R2

### Fixed
- Fix denied subagent showing spinner instead of error state
- Fix remote client redirect loop on git-status page
- Fix DAG selecting stale pre-compaction branch over post-compaction one

## [0.4.2] - 2026-02-22

### Added
- HTTPS self-signed cert support (`--https-self-signed` flag and `HTTPS_SELF_SIGNED` env var)
- Codex shell tool rendering for grep/read workflows

### Fixed
- Fix HTTP LAN access: randomUUID fallback for insecure contexts and non-secure cookie handling
- Lazy-load tssrp6a to fix crash on HTTP LAN access (insecure context)
- Auth disable now clears credentials and simplifies enable flow

### Changed
- File logging and SDK message logging default to off (opt-in)
- Replace `LOG_TO_CONSOLE` with `LOG_PRETTY` for clearer semantics

## [0.4.1] - 2026-02-22

### Added
- Session cache with phased optimizations: cached scanner results, batched stats, cached stats endpoint with invalidation
- Cross-process locking and atomic writes for session index files
- Improved pending tool render and settings copy

### Fixed
- Fix localhost websocket auth policy when remote access is enabled
- Fix send racing ahead of in-flight file uploads

## [0.4.0] - 2026-02-22

### Security
- Harden markdown rendering against XSS
- Harden SSH host handling for remote executors
- Harden auth enable flow and add secure recovery path
- Patch vulnerable dependencies (bn.js)
- Enforce 0600 permissions on sensitive data files
- Add SRP handshake rate limiting and timeout guards
- Harden session resume replay defenses for untrusted relays
- Harden relay replay protection for SRP sessions

### Added
- Tauri 2 desktop app scaffold with setup wizard
- Tauri 2 mobile app scaffold with Android support
- Global agent instructions setting for cross-project context
- Permission rules for session bash command filtering
- Legacy relay protocol compatibility for old servers

### Fixed
- Guard SecureConnection send when WebSocket global is unavailable
- Stop reconnect loop on intentional remote disconnect
- Fix stale reconnect race and reduce reconnect noise
- Fix localhost cookie-auth websocket regression
- Fix WebSocket SRP auth-state coupling and regressions
- Fix server crash when spawning sessions with foreign project paths
- Fix streamed Codex Edit patch augmentation parity
- Fix Linux AppImage builds (patchelf corruption, native deps, signing)

### Changed
- Default remote sessions to memory with dev persistence toggle
- Refactor websocket transport into auth, routing, and handler modules
- Improve server update modal copy and layout
- Remove browser control module

## [0.3.2] - 2025-02-18

### Changed
- Update README with current Codex support status (full diffs, approvals, streaming)

## [0.3.1] - 2025-02-18

### Fixed
- Fix Codex provider labeling (CLI, not Desktop)

## [0.3.0] - 2025-02-18

### Added
- Codex CLI integration with app-server approvals and protocol workflow
- Codex session launch metadata, originator override, and steering improvements
- Focused session-watch subscriptions for session pages
- Server-side highlighted diff HTML for parsed raw patches
- Browser control module for headless browser automation

### Fixed
- Relay navigation dropping machine name from URL
- Codex Bash error inference for exit code output
- Codex persisted apply_patch diff rendering
- Codex session context and stream reliability

### Changed
- Collapse injected session setup prompts in transcript
- Normalize update_plan and write_stdin tool events
- Improve Codex persisted session rendering parity
- Show Codex provider errors in session UI

## [0.2.9] - 2025-02-15

### Fixed
- `--open` flag now opens the Windows browser when running under WSL

## [0.2.8] - 2025-02-15

### Added
- `--open` CLI flag to open the dashboard in the default browser on startup

## [0.2.7] - 2025-02-13

### Fixed
- Fix relay connect URL dropping username query parameter during redirect

## [0.2.6] - 2025-02-09

### Fixed
- Fix page crash on LAN IPs due to eager tssrp6a loading
- Fall back to any project for new sessions; replace postinstall symlink with import rewriting

## [0.2.5] - 2025-02-09

### Fixed
- Windows support: fix project directory detection for Windows drive-letter encoded paths (e.g. `c--Users-kaa-project`)
- Windows support: fix session index path encoding for backslash separators

## [0.2.4] - 2025-02-09

### Fixed
- Windows support: replace Unix `which` with `where` for CLI detection
- Windows support: accept Windows absolute paths (e.g. `C:\Users\...`) in project validation
- Windows support: fix path traversal guard and project directory encoding for backslash paths
- Windows support: use `os.homedir()` instead of `process.env.HOME` for tilde expansion
- Windows support: fix path separator handling in codex/gemini directory resolution
- Windows support: show PowerShell install command instead of curl/bash

## [0.2.2] - 2025-02-03

### Added
- Relay connection status bar
- Website release process with tag-based deployment

### Fixed
- Sibling tool branches in conversation tree

### Changed
- Simplify Claude, Codex, and Gemini auth to CLI detection only
- Update claude-agent-sdk to 0.2.29

## [0.2.1] - 2025-01-31

### Added
- CLI setup commands for headless auth configuration
- Relay `/online/:username` endpoint for status checks
- Multi-host support for remote access
- Switch host button to sidebar
- WebSocket keepalive ping/pong to RelayClientService
- Host offline modal and tool approval click protection
- Error boundary for graceful error handling
- Terminate option to session menu

### Fixed
- Host picker navigation and relay routes session resumption
- Relay login to set currentHostId before connecting
- DAG branch selection to prefer conversation over progress messages
- Session status event field name and auto-retry on dead process
- Sidebar overlay auto-close logic
- SRP auth hanging on unexpected messages
- Relay reconnection error messages for unreachable server
- Mobile reconnection showing stale session status
- Dual sidebar rendering on viewport resize
- Skip API calls on login page to prevent 401 popups
- Various relay host routing and disconnect handling fixes

### Changed
- Update claude-agent-sdk to 0.2.19
- Rename session status to ownership and clarify agent activity

## [0.1.10] - 2025-01-23

### Fixed
- Handle 401 auth errors in SSE connections
- Fix session stream reconnection on mobile wake
- Fix relay reconnection to actually reconnect WebSocket

### Added
- Connection diagnostics and detailed reconnect logging
- Show event stream connection status in session info modal
