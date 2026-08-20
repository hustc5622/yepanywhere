# Remote Session Reliability P0 Production Acceptance Archive

Date: 2026-08-20
Repository: `D:\PythonProjects\Python_projects_anaconda_zpb\Yepanywhere`
P0 source commit: `7b42f557b8ec9acac8df8df804679c7367bad0aa`
Production build: `0.4.29-7b42f557b8ec-20260820064528`

## Scope and decision

This archive records the P0 implementation, local merge, supported Windows production deployment, and public-path acceptance for the incident described by:

- Design: `docs/superpowers/specs/2026-08-17-remote-session-reliability-design.md`
- P0 plan: `docs/superpowers/plans/2026-08-17-remote-session-reliability-p0.md`
- P1 plan: `docs/superpowers/plans/2026-08-17-remote-session-reliability-p1.md`

Decision:

- The user-visible incident is accepted: the incident Session loads, resumes after production restart, receives an AI response, and accepts a second user message after that response.
- P0 application behavior is deployed and the running source/client/bundle identities match.
- Formal P0 Task 7 still has one manual evidence gap: a real previous-client artifact was unavailable for the stale-client single-refresh test. This gap must remain visible at the P1 release gate; it must not be silently described as completed.
- P1 Windows supervisor, loopback maintenance readiness, and transactional rollback have not started and are not claimed.

## Implementation and automated verification

P0 was implemented as reviewed commits ending at `7b42f557` and merged locally into `main`. Final independent review reported no Critical or Important findings.

Recorded automated evidence at the P0 head:

- Selected P0/regression server assertions: 12/12 passed.
- Projector/static/WebSocket/transport group: 48/48 passed.
- Focused client reliability group: 33/33 passed.
- Direct server and client TypeScript checks, lint, bundle build, and stable-prefix build passed.
- Full server suite: 1,768/1,840 passed; the 72 failures exactly matched the recorded pre-existing baseline.
- Full client suite: 461/483 passed; the 22 failures exactly matched the recorded pre-existing localStorage baseline.

No P1 production scripts, maintenance-port configuration, FRP configuration, or rollback behavior were included in P0.

## Deployment identity and production state

Deployment used the supported command `pnpm yep rebuild` after confirming no active AI turn.

Post-deployment evidence:

- Production runs on port 8022 under the Windows scheduled-task service.
- `/api/version`, `/build-info.json`, and the deployed bundle all reported build `0.4.29-7b42f557b8ec-20260820064528` and commit `7b42f557b8ec9acac8df8df804679c7367bad0aa`.
- `server.err.log` remained empty during final acceptance.
- The repository working tree was clean before this archive was added.
- `main` was local-only and ahead of `origin/main`; no push was performed.

## Incident Session acceptance

Incident identifiers are intentionally referenced from the P0 plan rather than duplicated here.

Formal production API measurement with the P0 plan's bounded-history query:

- HTTP 200.
- 100 messages preserved.
- Decoded response: 309,483 bytes.
- Gzip transfer: 68,996 bytes.
- `session.messages` absent from metadata.
- Zero `data:image` payloads.

Public-path functional acceptance after the existing FRP endpoint was restored:

1. The mobile-sized page loaded without React error #300, module import failure, ErrorBoundary, or a permanent skeleton.
2. Public WebSocket connected and remained connected for more than two minutes without a correlated server-side disconnect or socket error.
3. `P0 mobile resume acceptance` produced `session_resume_requested`, provider start, Session registration, a new turn, and an AI response.
4. After that AI response, `P0 follow-up send acceptance` produced `session_queue_requested` followed by `session_queue_accepted`, a second turn, and the visible AI response `P0 follow-up send accepted.`
5. The process returned to `idle`, queue depth returned to zero, the input cleared, and no send failure appeared.

This directly covers the original failure mode: sending another message after the AI had replied.

## Residual findings and P1 gates

### Public-path latency

Compression works, but the existing FRP path remains slow. A later broad-history measurement was approximately:

- Local: 0.62 seconds; 1,528,726 bytes identity and 304,817 bytes gzip.
- Public: 8.9 seconds; approximately 304,969 transferred bytes with `Content-Encoding: gzip`.
- Concurrent public static resources returned HTTP 200 but took roughly 6.6 to 26.5 seconds.

Inference: P0 reduced the payload substantially, while most remaining delay is outside the application boundary in the public tunnel/throughput path. P1 must not modify FRP as part of its Windows lifecycle scope.

### WebSocket subscription warnings

The public browser logged repeated `Received event for unknown subscription` warnings (69 during the final observation). They did not cause a socket failure, missed AI reply, or failed second send. Treat this as a separately triaged follow-up, not permission to expand P1 into WebSocket application changes.

### Stale-client recovery evidence

The previous production client binary had already been removed by the existing deployment swap. The only old evidence was a historical chunk name; its binary was unavailable. Verified evidence is therefore limited to:

- automated build-recovery and ErrorBoundary tests;
- current old-chunk request returning `404` with `Cache-Control: no-store`;
- current root and stable-prefix builds.

P1 Tasks 1-4 may be developed and reviewed in an isolated worktree because they do not mutate production. P1 Task 5 deployment remains blocked until the user gives fresh runtime-mutation authorization. Before that deployment, keep a tab open on the current P0 production build and use the P1 bundle switch to execute the real stale-client single-refresh acceptance required by P0/P1. Failure blocks the P1 release.

## Next phase boundary

Execute `docs/superpowers/plans/2026-08-17-remote-session-reliability-p1.md` using subagent-driven development:

- one fresh implementer at a time because Tasks 1-4 share PowerShell contracts and files;
- independent task review after every implementation task;
- one broad whole-branch review before any production mutation;
- no production rebuild, supervisor kill, controlled stop, rollback injection, merge, or push without the authorization required by the plan;
- no FRP, Session API, React Session page, static recovery, or WebSocket heartbeat changes.
