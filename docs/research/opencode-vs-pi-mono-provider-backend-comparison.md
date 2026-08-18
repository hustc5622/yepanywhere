# OpenCode vs pi-mono for a Yep Anywhere Agnostic Provider Backend

> Historical reference: Yep Anywhere retired its OpenCode provider and bridge on 2026-08-18. Pi remains supported through provider-neutral RPC, SQLite, edit-fork, and LLM gateway modules.

Date: 2026-02-18

## Executive Summary

For Yep Anywhere's goal of a strong **agnostic provider backend** (with good persistence, model/provider switching, and flexible tool execution), **pi-mono is the better primary backend candidate** than OpenCode.

OpenCode is more mature as a standalone multi-client server, but your current Yep integration only uses a small subset of its capabilities and has already stalled. pi-mono is architecturally closer to the abstraction you want to build now: single-session runtime, strong typed event flow, direct embedding options, and explicit cross-provider normalization.

Recommended direction:
1. Make **pi-mono the primary agnostic backend path**.
2. Keep OpenCode as a secondary/fallback provider while migrating.
3. Build a thin normalization layer in Yep that can map both backends into one internal event/session model.

## Context and Current State in Yep Anywhere

Yep currently defines provider-level abstractions around one session runtime (`AgentProvider`/`AgentSession`) and registers providers in-process:
- `packages/server/src/sdk/providers/types.ts`
- `packages/server/src/sdk/providers/index.ts`

OpenCode is currently integrated as a per-session spawned server process (`opencode serve`) with limited feature exposure in Yep:
- `packages/server/src/sdk/providers/opencode.ts`

Important mismatch today:
- Yep's OpenCode adapter currently reports `supportsPermissionMode = false`, `supportsThinkingToggle = false`, `supportsSlashCommands = false`, despite OpenCode supporting much of this via server APIs and permissions endpoints.
- This confirms the integration is functionally narrow relative to OpenCode's actual backend surface.

Yep also already has OpenCode storage reading logic:
- `packages/server/src/sessions/opencode-reader.ts`

## Evaluation Criteria

This comparison is scoped to suitability as a backend for:
- Provider/model agnosticism.
- Session persistence and session browsing/continuation.
- Tool execution transparency and event mapping.
- User-supplied credentials (Anthropic/OpenAI/etc.) through a normalized backend interface.
- Low-friction integration into Yep's current provider/session architecture.

## High-Level Scorecard

| Dimension | OpenCode | pi-mono | Better Fit for Yep Agnostic Layer |
|---|---|---|---|
| Integration shape vs Yep provider API | Server-over-HTTP/SSE, process-per-session in current adapter | In-process SDK or RPC mode, session-centric | pi-mono |
| Persistence model simplicity for UI | Strong but split (SQLite + storage migration/history) | JSONL append-only tree, easy to inspect/parse | pi-mono |
| Cross-provider normalization maturity | Strong provider transforms, but mostly server-internal | Explicit transform layer + cross-provider handoff tests | pi-mono |
| Tool execution flexibility | Strong tools + plugins + permissions | Strong tools + extensions + in-process custom providers | tie (pi has edge for embedding) |
| Multi-session backend server features | Very strong | More single-session oriented | OpenCode |
| Fit with your stated target (single-session + normalized layer) | Possible but heavier | Direct fit | pi-mono |
| Migration effort from current Yep state | Lower incremental (already integrated) | Moderate (new adapter + reader) | OpenCode (short-term), pi (strategic) |

## Detailed Technical Comparison

### 1) Runtime and Integration Model

#### OpenCode
- Native architecture is a headless HTTP server with OpenAPI + SSE event bus (`opencode serve`), designed for multiple clients.
- API surface is broad (`/session`, `/provider`, `/config`, `/permission`, `/mcp`, `/event`, etc.).
- In Yep, current implementation spawns one OpenCode server per session and talks over localhost HTTP/SSE.

Strengths:
- Clear process boundary.
- Rich remote-control surface.

Costs:
- Heavier per-session lifecycle in Yep (port mgmt, process mgmt, HTTP error modes).
- You only consume a narrow fraction of OpenCode's full surface today.

#### pi-mono
- Offers two integration modes that align well with Yep:
1. Direct embedding (`createAgentSession()` in SDK path).
2. JSON RPC subprocess mode over stdin/stdout.
- Core runtime is session-first (`AgentSession`) and shared across interactive/json/rpc.

Strengths:
- You can pick IPC boundary later: start with RPC for isolation, move to in-process for lower latency and tighter control.
- Session runtime abstraction is directly compatible with Yep's `AgentSession` shape (iterator/events + queue-like prompting + abort).

Costs:
- You own more adapter logic (event/schema mapping) up front.

Verdict:
- For your target architecture, pi-mono is a cleaner substrate.

### 2) Persistence and Session Model

#### OpenCode
- Modern persistence is SQLite (`opencode.db`) with structured session/message/part/todo/permission tables.
- Also carries storage migration/history logic for older file layouts.
- Session features are rich: list/create/fork/share/revert/summarize.

Upside:
- Operationally robust backend DB model.

Downside for Yep:
- Persistence is richer but less trivial to inspect and normalize externally unless you rely fully on OpenCode APIs.
- Current Yep reader is already tailored to historical file structure assumptions.

#### pi-mono
- Sessions are JSONL files under `~/.pi/agent/sessions/...`.
- Append-only tree model (`id`/`parentId`) supports in-place branching in one file.
- Built-in migration path (v1->v2->v3), fork/continue/list/listAll, and context compaction mechanics.

Upside:
- Persistence is straightforward for UI indexing and debugging.
- Easier to build a stable Yep session reader and session browser.

Downside:
- Not a centralized DB service; concurrency semantics are file-based.

Verdict:
- For "show sessions, create sessions, pick models" with transparent storage, pi-mono is simpler and closer to your stated needs.

### 3) Provider/Model/Auth Agnosticism

#### OpenCode
- Broad built-in provider support via AI SDK adapters.
- Model metadata from models.dev with caching/refresh.
- Provider auth endpoints include OAuth/API patterns.
- Includes provider-specific message/tool transform logic.

#### pi-mono
- Broad provider matrix (subscription + API key providers) with explicit env/auth-file resolution order.
- `auth.json` + env + runtime override + fallback resolver precedence is explicit and testable.
- `ModelRegistry` supports provider overrides and custom models from `models.json`.
- Extensions can `registerProvider()` to override existing providers or add new ones, including OAuth and custom streaming.

Key differentiator for your goal:
- pi-mono has a direct extensibility API for provider registration at runtime that maps naturally to your "users can slot in Anthropic keys, choose model, and we normalize" vision.

Verdict:
- Both are strong; pi-mono is more "bring-your-own-provider-backend" friendly for your integration style.

### 4) Message and Tool Normalization

#### OpenCode
- Strong provider transform layer (tool-call ID normalization, provider-option remapping, capability handling).
- Rich event pipeline in session processor.
- Full bus events via SSE (`/event`, `global/event`) with heartbeat.

#### pi-mono
- Explicit cross-provider transformation function (`transformMessages`) for thinking/tool-call/tool-result compatibility.
- Includes cross-provider handoff tests across many providers/models (important evidence that normalization is first-class).
- Agent event model is strongly typed and granular (`message_*`, `tool_execution_*`, turn lifecycle).

For Yep normalization layer:
- pi event shapes are already close to a normalized internal envelope you can project into the UI.
- OpenCode can also map well, but your current adapter does not yet leverage its full granularity.

Verdict:
- pi-mono has better evidence of deliberate cross-provider handoff correctness for the exact problem you described.

### 5) Tool Calling Flexibility

#### OpenCode
- Strong built-in tool registry, plugin/custom tools, model-aware tool shaping.
- Permission system with ask/allow/deny and response APIs.

#### pi-mono
- Built-in tool sets and extension-wrapped tools.
- In-process tool execution and extension middleware are first-class.
- RPC mode can forward tool execution lifecycle events and extension UI requests.

Given your comment about avoiding MCP overhead:
- pi-mono is very compatible with direct in-process tool execution and extension hooks.

Verdict:
- Both are capable; pi-mono better matches the "local process, flexible tool runtime" approach.

### 6) Permission and Safety Controls

#### OpenCode
- Has explicit permission APIs and events (`/permission`, reply flow, rulesets).
- Good for out-of-band approvals when fully integrated.

#### pi-mono
- Safety/permissions are more runtime/tool policy driven through tool availability and extension hooks rather than an OpenCode-style standalone permission endpoint.

Implication for Yep:
- If you want a unified permission UX like Claude/OpenCode, you'll need a thin policy layer on top of pi tool events.

Verdict:
- OpenCode has a stronger built-in permission-service pattern; pi requires more app-level policy wiring.

## Suitability for Your Specific Backend Vision

Your target was:
- Treat backend as provider-agnostic.
- Let users use their own provider keys.
- Expose session persistence cleanly (browse/create/select model).
- Keep tool execution flexible and local-friendly.

Assessment:
- **pi-mono aligns better** with this target, especially if you want the backend to feel like a Claude-like session runtime you can embed and normalize.
- OpenCode is excellent as a standalone server product, but in Yep it currently behaves as a partially-used subsystem, and that mismatch is why progress likely felt sticky.

## Recommended Architecture for Yep

### Recommendation
Use a two-layer design:
1. **Backend Adapter Layer** (`PiAdapter`, `OpenCodeAdapter`) for lifecycle and transport.
2. **Normalized Session/Event Layer** in Yep for UI and persistence indexing.

### Phase 1 (pragmatic)
- Add new `pi` provider backend alongside `opencode`.
- Integrate via pi RPC mode first (stable process boundary, typed protocol).
- Add `PiSessionReader` for `~/.pi/agent/sessions` JSONL trees.

### Phase 2 (first-class)
- Add optional in-process pi SDK backend path (`createAgentSession`) behind a feature flag.
- Compare latency, memory, and failure behavior vs RPC.

### Phase 3 (normalization hardening)
- Promote a shared normalized event contract for all providers.
- Map:
  - pi `message_*`, `tool_execution_*`, `turn_*`
  - OpenCode `message.part.updated`, permission/session events
  into one internal UI/event envelope.

## Migration and Risk Analysis

### Main risks if you switch to pi primary
- Adapter implementation work is non-trivial (event mapping, queue semantics, interruption behavior).
- You need to define your own permission policy UX on top of pi tool events.
- In-process mode may have packaging/runtime edge cases; RPC-first mitigates this.

### Main risks if you stay OpenCode primary
- Continued underuse of OpenCode's full capability due integration complexity mismatch.
- More engineering effort spent bridging around server/process model differences.
- Persistence and normalization remain split across API and storage assumptions.

## Bottom Line

If the goal is "a great agnostic backend that Yep can treat as first-class," choose **pi-mono as the primary strategic path** and keep OpenCode as secondary compatibility.

If the goal is "minimum immediate change," continue OpenCode incrementally, but that likely preserves the same integration friction that caused the current stall.

## Source Files Reviewed

Yep Anywhere:
- `packages/server/src/sdk/providers/types.ts`
- `packages/server/src/sdk/providers/index.ts`
- `packages/server/src/sdk/providers/opencode.ts`
- `packages/server/src/sessions/opencode-reader.ts`

OpenCode (`~/code/reference/opencode`):
- `README.md`
- `packages/web/src/content/docs/server.mdx`
- `packages/opencode/src/server/server.ts`
- `packages/opencode/src/server/routes/session.ts`
- `packages/opencode/src/server/routes/permission.ts`
- `packages/opencode/src/storage/db.ts`
- `packages/opencode/src/session/session.sql.ts`
- `packages/opencode/src/session/index.ts`
- `packages/opencode/src/session/processor.ts`
- `packages/opencode/src/provider/provider.ts`
- `packages/opencode/src/provider/models.ts`
- `packages/opencode/src/provider/auth.ts`
- `packages/opencode/src/provider/transform.ts`
- `packages/opencode/src/tool/registry.ts`
- `packages/opencode/src/permission/next.ts`
- `packages/sdk/js/src/server.ts`
- `packages/sdk/js/src/client.ts`

pi-mono (`~/code/reference/pi-mono`):
- `packages/coding-agent/README.md`
- `packages/coding-agent/docs/session.md`
- `packages/coding-agent/docs/rpc.md`
- `packages/coding-agent/docs/providers.md`
- `packages/coding-agent/docs/custom-provider.md`
- `packages/coding-agent/src/core/session-manager.ts`
- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/sdk.ts`
- `packages/coding-agent/src/core/auth-storage.ts`
- `packages/coding-agent/src/core/model-registry.ts`
- `packages/coding-agent/src/core/extensions/loader.ts`
- `packages/coding-agent/src/core/extensions/types.ts`
- `packages/coding-agent/src/core/extensions/runner.ts`
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
- `packages/coding-agent/src/modes/rpc/rpc-types.ts`
- `packages/coding-agent/src/modes/rpc/rpc-client.ts`
- `packages/agent/src/types.ts`
- `packages/ai/src/types.ts`
- `packages/ai/src/models.ts`
- `packages/ai/src/env-api-keys.ts`
- `packages/ai/src/providers/transform-messages.ts`
- `packages/ai/src/providers/register-builtins.ts`
- `packages/ai/src/api-registry.ts`
- `packages/ai/test/cross-provider-handoff.test.ts`
