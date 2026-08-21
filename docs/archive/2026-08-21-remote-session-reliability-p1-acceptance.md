# Remote Session Reliability P1 Production Acceptance Archive

Date: 2026-08-21
Repository: `D:\PythonProjects\Python_projects_anaconda_zpb\Yepanywhere`
Branch: `codex/p1-remote-session-reliability`
P1 source commit: `4b3a6fd0f4657fe2450bf45c19fbceddc8964eac`
Production build: `0.4.29-4b3a6fd0f465-20260821063547`

## Scope and decision

This archive records the reviewed P1 implementation, supported Windows production deployment, and authorized runtime recovery acceptance for:

- Design: `docs/superpowers/specs/2026-08-17-remote-session-reliability-design.md`
- Plan: `docs/superpowers/plans/2026-08-17-remote-session-reliability-p1.md`
- P0 archive: `docs/archive/2026-08-20-remote-session-reliability-p0-acceptance.md`

Decision:

- P1 automated and executable production acceptance passed: v2 process identity, five-state orchestration, verified adoption, loopback maintenance readiness, transactional deployment, rollback, unexpected-supervisor recovery, and durable controlled stop are deployed and healthy.
- The preserved stale-client Session retained its pathname, query, and hash, loaded the new bundle without an ErrorBoundary, and completed a real provider turn.
- The literal physical-phone/4G stale-client check remains manual because this environment cannot operate that device/network boundary. The in-app browser and public endpoint checks must not be relabeled as physical-phone evidence.
- P1 does not change FRP, Session API, React Session UI, static-resource recovery, WebSocket heartbeat, macOS lifecycle behavior, authentication, or user data.
- No push, remote PR, publication, or merge to `main` was performed.

Gate 0 ruling preserved from the execution ledger:

> Ruling: 允许在隔离 worktree 中实施和审查 P1 Tasks 1–4，因为它们不改变当前生产；P1 Task 5 的部署与发布结论继续被真实 stale-client 验收阻塞。Task 5 部署前必须保留一个加载当前 P0 build 的页面，利用 P1 bundle 切换完成 pathname/query/hash 保留、最多一次自动刷新、重复失败进入 ErrorBoundary 的实测。若无法完成，P1 不得发布或宣称完成。成本：P1 代码开发会在 P0 手工证据尚未闭合时先行，但生产发布门槛不降低。

## Implementation and reviews

The final reviewed tree is `8644eb3a0b7f05659d220d72abb8149dba99940a`. Whole-branch review finished CLEAN with no Critical, Important, or Minor finding.

The four implementation commits are:

1. `0cf3f838300aee9fe38090265931c71743da3699 feat: add verified production process manifests`
2. `422f396c4c1587cb5b76bbcbec982183f37889a6 fix: classify degraded production service states`
3. `2b39511f21d16198057a96d5a1385766b9cec728 fix: adopt verified production process groups`
4. `4b3a6fd0f4657fe2450bf45c19fbceddc8964eac fix: roll back failed production deployments`

The implementation adds:

- atomic production manifest v2 with strict process-generation identity;
- `healthy`, `degraded-adoptable`, `verified-stale`, `unknown-conflict`, and `stopped` inspection states;
- retained-handle cleanup and fail-closed unknown-port behavior;
- a resident Windows watchdog that restarts and adopts a verified inner supervisor without periodic-trigger resurrection after an explicit stop;
- loopback-only `ServerPort + 1` maintenance readiness;
- deployment idle gating, delayed transaction commit, failed-bundle isolation, and verified automatic rollback.

## Automated verification

Final recorded evidence:

- P1 release gate: 123/123 assertions passed across five files:
  - Windows production reliability: 72/72
  - Windows service scripts: 35/35
  - deploy verifier: 7/7
  - CLI entry: 6/6
  - bundle output: 3/3
- Full server: 1,846/1,916 passed; the 70 failures were all recorded baseline names, with no added failure names and two pre-existing setup-admin-password failures removed.
- Full client: 461/483 passed; the exact same 22 recorded localStorage baseline failures remained.
- P0 critical server: 86/89; only the same three recorded resume timeouts.
- P0 critical client: 33/33.
- Lint: 817 files passed.
- Shared build and direct server/client TypeScript checks passed.
- Six Windows PowerShell 5.1 parsers and Node syntax passed.
- Root `pnpm typecheck` exited zero but selected no recursive projects; the direct package checks are the substantive type evidence.

The accepted baseline-failure sets were compared by assertion name rather than count. No unrelated failing test was edited to make P1 green.

## Deployment identity and final production state

Deployment used the supported transactional command `pnpm yep rebuild` after the idle gate passed.

Final state:

- Source commit: `4b3a6fd0f4657fe2450bf45c19fbceddc8964eac`
- Runtime and manifest build: `0.4.29-4b3a6fd0f465-20260821063547`
- Manifest version: 2
- Windows task: `YepAnywhereServer`, Running, one login trigger, autostart enabled
- Task action: Windows PowerShell running `scripts\watch-yepanywhere.ps1` with persistent `C:\Users\ZhuanZ\.yep-anywhere\service-config.json`
- Final supervisor after fault injection: PID 23588, instance `3ecd85cd-320c-4529-a4d1-ea8bf5879e6e`
- Server: PID 29640, owning loopback listeners 8022 and 8023
- Codex bridge: PID 22852, loopback listener 4510
- Claude bridge: PID 29216, loopback listener 4520
- Workers: `activeWorkers=0`, `queueLength=0`, `hasActiveWork=false`
- Production bundle directories: only `dist\npm-package`; no active staging, rollback, or failed bundle directory

`pnpm yep status` reported `healthy`, the maintenance endpoint returned `status=ok`, and runtime/manifest/bundle build identities matched.

## Stale-client and incident Session acceptance

The same already-open incident Session page transitioned to the final bundle asset while preserving its exact pathname, `?p1-stale=acceptance`, and `#p1-stale`.

Observed browser result:

- document reached `readyState=complete` and remained visible;
- no permanent skeleton, ErrorBoundary, React #300, or module-script failure;
- the page remained usable for more than two minutes and survived supervisor adoption plus a later controlled production restart;
- `P1 deployment regression acceptance` was sent at `2026-08-21T04:34:19.461Z`;
- `P1 deployment regression accepted.` completed at `2026-08-21T04:34:22.490Z`.

The durable provider-turn evidence is in:

`C:\Users\ZhuanZ\.codex\sessions\2026\08\17\rollout-2026-08-17T07-34-46-01a00ced-6cbb-7253-ac80-6d9b2dacbe5f.jsonl`, lines 896-899.

The public main endpoint at `http://123.56.106.49:1024/api/version` returned the final build. A physical phone on 4G must still repeat the stale-client refresh, send, and two-minute connection observation before that literal manual boundary is called closed.

## Unexpected supervisor recovery

Before termination, the supervisor was bound by manifest/process/CIM start time, executable path, exact command line, role, watchdog parent, and retained process handle. The task and child processes were not killed.

Authoritative 90-second run:

- Old supervisor PID: 37612
- New supervisor PID: 23588
- Old instance: `4197561f-470c-420a-ae95-9d1fcd5037c1`
- New instance: `3ecd85cd-320c-4529-a4d1-ea8bf5879e6e`
- Server PID before/after: 29640 / 29640
- Availability: 90/90 successful samples; `FailedSamples=0`
- Build remained `0.4.29-4b3a6fd0f465-20260821063547`
- Final task state: Running; service status: healthy

An earlier diagnostic loop reached the API for all 90 samples but read `buildId` one level too high. It was discarded as authoritative evidence and replaced by the corrected full run above.

## Controlled stop and maintenance boundary

`pnpm yep stop-prod` stopped the watchdog first and completed verified process-group cleanup.

- 70/70 samples observed Task state Ready.
- 70/70 samples observed no 8022 or 8023 listener.
- No restart violation occurred.
- `pnpm yep start-prod` restored healthy production with the same build and enabled autostart.

Maintenance exposure:

- `127.0.0.1:8023` was the only maintenance listener.
- Local `/health` returned `status=ok`.
- Public `http://123.56.106.49:8023/health` failed with HTTP 502; the maintenance service was not directly reachable.
- No FRP configuration was added or changed.

## Isolated rollback failure injection

The real PowerShell transaction harness ran only against temporary directories. It independently covered:

1. new service start failure;
2. new build/verification failure;
3. maintenance smoke failure.

All cases restored and verified the previous bundle, preserved the failed new directory, and did not touch the live production directory or user data. The reliability file passed 72/72. The real Scheduled Task export hash remained unchanged before and after the harness:

`037469e60c1590ab893c352d3323cf9894feb408906e1f5ebef974e09d02c27e`

Live production rollback failure injection remained intentionally excluded by the plan.

## Residual boundary

One acceptance boundary remains manual: operate a physical phone on 4G/public access and repeat the stale-client pathname/query/hash, at-most-one-refresh, send, and two-minute connection checks. This does not invalidate the completed Windows lifecycle acceptance, but it blocks describing the literal phone/4G line item as automated or complete.

An ignored diagnostic bundle remains only in the isolated worktree at `dist\p1-diagnostic-4f236ba691fd48638c5d969e67d9dfa8` because recursive automated deletion was policy-blocked. It is not a production `npm-package*` directory and was never deployed.

No merge, push, remote PR, or publication is part of this archive commit.
