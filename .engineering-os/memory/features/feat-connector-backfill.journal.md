# Feature Journal — feat-connector-backfill

## 2026-06-17T11:50:00Z — Architect (Stage 2) — BINDING PLAN → GO
**Artifact:** 03-architecture-plan.md · **Paradigm:** tier-0 deterministic $0/mo · **Decision:** GO for builders
**Migration:** 0022_backfill_job (additive; FORCE RLS two-arg; brain_app SELECT/INSERT/UPDATE no DELETE). **Topic:** {env}.collector.order.backfill.v1 (1 partition cap) group=stream-worker-backfill.
**Backfill order event = a CollectorEventV1 envelope** (event_name=order.backfill.v1, order fields in properties) → existing ProcessEventUseCase writes Bronze + existing identity bridge resolves, UNCHANGED. event_id = uuidV5FromSha256(brand_id, shopify_order_id) (bronze event_id is UUID). occurred_at = processed_at (D-6) → existing revenue-finalization finalizes past-horizon orders, NO new code (ADR-BF-10). Missing wire built: OrderEventConsumer→provisional ledger (ADR-BF-9, scaffolded but never wired). PII hashed AT worker, hashes-only emitted (ADR-BF-5/D-10). Worker reads its own cross-process secrets seam (ADR-BF-11).
**Tracks:** A@data-engineer(lead: 0022+worker+lane+ledger-wire+live tests) ∥ B@backend-developer(trigger 501→202, 409 RECONNECT_REQUIRED/BACKFILL_ALREADY_RUNNING, overlap-lock FOR UPDATE SKIP LOCKED, audit, GET jobs) ∥ C@frontend-web-developer(progress UX, "Gross Revenue (ex-fees)" label+tooltip, e2e).
**Frozen first:** A0 commits order.backfill.v1 + connector.backfill.api.v1 contracts → unblocks B & C parallel. COMMIT-PER-SLICE (Stage-8 agent died on infra socket timeout this run). Branch feat/connector-backfill off master HEAD.
**Next:** @data-engineer (A0) → @backend-developer + @frontend-web-developer — Stage 3.

## 2026-06-17T14:00:00Z — Security Reviewer — Stage 4 BOUNCE
{"ts":"2026-06-17T14:00:00Z","actor":"security-reviewer","type":"review","req_id":"feat-connector-backfill","stage":4,"verdict":"BOUNCE","blocking":1,"finding":"SEC-BF-H1: run.ts:219,228,247 findQueuedJob+loadConnectorInstance use brain_app pool without GUC — FORCE RLS fail-closed returns 0 rows always — worker non-functional in prod — fix: SECURITY DEFINER enumeration function"}

## 2026-06-17T15:30:00Z — Security Reviewer — Stage 4 DELTA r1 PASS
{"ts":"2026-06-17T15:30:00Z","actor":"security-reviewer","type":"review","req_id":"feat-connector-backfill","stage":4,"verdict":"PASS","mode":"DELTA","blocking":0,"resolved":["SEC-BF-H1","SEC-BF-M1"],"deferred":["SEC-BF-M2","SEC-BF-L1"]}
