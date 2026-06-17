# Data Engineer — Journal

> Append-only. See /Users/rishabhporwal/.claude/plugins/cache/engineering-os/engineering-os/2.3.1/docs/role-empowerment-model.md for entry shape.

## 2026-06-15T07:19:27Z — system — bootstrap
**Action:** Journal initialized by /eos-init on 2026-06-15T07:19:27Z.

## 2026-06-15T00:00:00Z — Data Engineer — context-sync/2026-06-15-datamodel-v1.5
**Stage:** context-sync · **Layer:** batch+lakehouse+stream · **Tier:** deterministic
**Parity:** N/A (context-sync, no build) · **Replayable:** N/A · **Verification:** doc-08 §36/§37 absorbed; delta map written to .engineering-os/context-sync/2026-06-15-datamodel-v1.5/data-engineer-assessment.md · **Next:** M1 data-platform build — 10 net-new Silver tables, envelope extension (10 fields), tax_regime/region/reporting_currency on all taxable rows, 5 reserved domains blocked from Phase 1

## 2026-06-17T12:17:00Z — Data Engineer — feat-connector-backfill
**Stage:** 3 · **Layer:** stream+batch+lakehouse · **Tier:** deterministic
**Parity:** PASS vs registry (provisional_recognition dedup key matches revenue-finalization.ts; same schema; same ON CONFLICT) · **Replayable:** yes (same ProcessEventUseCase code path; idempotent on event_id; no separate backfill codebase) · **Verification:** `pnpm exec vitest run src/tests/backfill.e2e.test.ts` → 29/29 PASS; `pnpm exec vitest run src/tests/bronze.e2e.test.ts` → 4/4 PASS (both under brain_app, RLS enforced) · **Next:** READY-FOR-SECURITY

Commits (branch feat/connector-backfill):
- 3f60647 A0: freeze contracts — order.backfill.v1.ts + connector.backfill.api.v1.ts (unblocks Track B+C)
- 70c6dc8 A1: migration 0022_backfill_job (FORCE RLS, NN-1, no DELETE grant) + PgBackfillJobRepository + Redpanda topic decl
- 0742fb7 A2: shopify-backfill worker — uuid-utils, money-utils, shopify-paged-client, order-mapper, worker-secrets, run.ts state machine (ADR-BF-1..15)
- b309eba A3: BackfillOrderConsumer + LedgerWriter + main.ts wire (ADR-BF-7..9) — missing Bronze→ledger wire
- 8a4c082 A4: live integration tests (29 assertions across T1-T10)
- 591b066 fix: RedisDedupAdapter.connect() + fixture brands for trigger satisfaction — 29/29 green

Isolation: separate Redpanda topic {env}.collector.order.backfill.v1 (1 partition) + consumer group stream-worker-backfill; live lane structurally unaffected.
ADR-BF-9 ledger wire: LedgerWriter in stream-worker/infrastructure/pg (no cross-package import from @brain/core).
Security: no raw PII in events/Bronze/logs; no token in logs; brand_id always from caller; NN-1 two-arg GUC throughout; 0006 untouched; no DELETE on backfill_job; no new deployable.

## 2026-06-17T21:05:00Z — Data Engineer — feat-shopify-live-connector
**Stage:** 3 · **Layer:** stream+batch+lakehouse · **Tier:** deterministic (Tier-0, $0 model spend)
**Parity:** PASS vs registry (provisional_recognition + rto_reversal schema match revenue-finalization.ts; same ON CONFLICT key; LedgerWriter shared write path) · **Replayable:** yes (same code path for live + backfill; idempotent on event_id; no separate backfill codebase; LedgerWriter ON CONFLICT DO NOTHING) · **Verification:** `npx vitest run apps/stream-worker/src/tests/live-connector.e2e.test.ts` → 16/16 PASS; `npx vitest run apps/stream-worker/src/tests/` → 115/115 PASS (all stream-worker tests, zero regressions) · **Next:** READY-FOR-SECURITY

Commits (branch feat/shopify-live-connector):
- 7cdbc81 A0: freeze @brain/shopify-mapper — uuidV5FromOrderLive (D-6), uuidV5FromOrderBackfill, mapOrderToEvent; backfill shims re-point
- 43ab45b A1: migration 0026 — list_connectors_for_repull() + resolve_connector_by_shop_domain() SECURITY DEFINER fns (D-4/7)
- 25d0af6 A2: 35-day re-pull job (shopify-live-client.ts + run.ts) — SECURITY DEFINER enumeration, SKIP LOCKED overlap-lock, resource=orders.repull cursor, live lane emission (D-7/9/10/11)
- db123af A3: LedgerWriter.writeReversal() + LiveOrderConsumer routing — provisional vs rto_reversal branch on cancelled_at (D-13, ADR-LV-11)
- 90f409c A4: live connector e2e tests — 16/16 GREEN (T1 Bronze write, T2 D-6 dedup namespace, T3 per-state dedup, T4 RTO reversal, T5 cursor, T6 SKIP LOCKED, T7 no-GUC FORCE RLS, T8 cross-brand isolation)

Key security properties held:
- brand_id NEVER from env/Shopify/header — always from list_connectors_for_repull() SECURITY DEFINER result
- GUC set (set_config) AFTER enumerate, before any brand-scoped read/write
- NO raw PII in events/Bronze/logs (customer.phone/email never propagated)
- NO token in logs (I-S09 — accessToken only used in Authorization header)
- Append-only ledger: brain_app has SELECT+INSERT only; rto_reversal is a new negative row, sale rows untouched
- Migration 0026: three assertion DO blocks per fn (SECURITY DEFINER=true, search_path=public, brain_app EXECUTE)
- All Bronze/ledger reads in tests wrapped in BEGIN+set_config GUC+COMMIT (FORCE RLS)

## 2026-06-17T22:15:00Z — Data Engineer — feat-shopify-live-connector (ORCH-LV-H1 fix, r1 bounce)
**Stage:** 3 · **Layer:** stream · **Tier:** deterministic (tier-0, $0 model spend)
**Parity:** PASS vs registry (provisional_recognition + rto_reversal schema unchanged; same LedgerWriter write path) · **Replayable:** yes (idempotent ON CONFLICT DO NOTHING; same code path as backfill) · **Verification:** `cd apps/stream-worker && pnpm vitest run` → 119/119 PASS (11 files: 115 existing + 4 new wiring tests, zero regressions) · **Next:** READY-FOR-SECURITY

ORCH-LV-H1 root cause: LiveOrderConsumer existed and was unit-tested (T4 called routeLiveOrderToLedger directly) but was never subscribed to the Kafka topic in main.ts. 903 order.live.v1 events hit Bronze; ledger stayed flat.

Fix committed in two slices (branch feat/shopify-live-connector, NEVER master):
- 3bbdf86: Added LiveLedgerBridgeConsumer (consumer group live-ledger-bridge, env LIVE_LEDGER_CONSUMER_GROUP_ID). Same live topic as CollectorEventConsumer + IdentityBridgeConsumer; independent offset; filters order.live.v1; routes provisional_recognition / rto_reversal. No Bronze double-write. Brand GUC set inside LedgerWriter (E-4). MAX_RETRY=5 DLQ (D-7). Wired in main.ts: start + shutdown hook + liveLedgerWriter.end().
- c836011: live-ledger-wiring.e2e.test.ts — TW1 (sale → provisional_recognition polled via Kafka), TW2 (cancellation → rto_reversal negative), TW3 (page.viewed → no ledger write), TW4 (same event twice → 1 row). Un-wire proof: comment `await consumer.start()` → TW1/TW2 poll timeouts → RED. This test would have caught ORCH-LV-H1.

Guardrails: no Bronze double-write; brand GUC before every ledger write; no raw PII/token in logs; idempotent; NEVER touched 60d543dc-*; git add ONLY apps/stream-worker paths; NEVER committed to master.

## 2026-06-17T17:02:09Z — Data Engineer — chore-connector-lifecycle-regression
**Stage:** 3 · **Layer:** stream (pipeline tests, no data plane change) · **Tier:** deterministic (tier-0, $0 model spend)
**Parity:** PASS vs registry (no metric definition touched) · **Replayable:** yes (tests only) · **Verification:** `pnpm vitest run <4 test files>` → 33 PASS / 1 SKIP (ADR-R3 it.skip) / 0 FAIL · **Next:** READY-FOR-SECURITY

Branch: chore/connector-lifecycle-regression. Commits:
- 2772982: A0 freeze fixtures + assertBrainApp (shared UUID constants, buildFakeStore, seedTestBrand, etc.)
- bba4716: A1 shopify-pagination — since_id=0 fix (9 assertions, revert-RED on ?? null)
- 4203726: A2 worker-guc — NIL-uuid positive + empty-string 22P02 revert-RED + cross-brand isolation
- 42864ce: A3 sync-status-currency — completion UPDATE pins state=connected + trg_ledger_currency trigger
- 15b249a: A4 dev-secret round-trip + core prod-hard-fail + ADR-R3 it.skip discovered gap

Fixtures path: apps/stream-worker/src/tests/helpers/connector-lifecycle-fixtures.ts
Isolation: all DB assertions under BRAIN_APP_DATABASE_URL (brain_app, NOBYPASSRLS); assertBrainApp() at every isolation block; file-private brand UUIDs (a2/a3/a4 prefixes) avoid parallel conflicts; no touch of 60d543dc.
ADR-R3 discovered gap: WorkerLocalSecretsManager has no NODE_ENV=production guard (worker-secrets.ts:69). it.skip surfaced — NOT fixed (D-9). Surface as separate requirement.
No product code change (D-9). Tests pin 8 defect classes with non-inert revert-RED assertions.

## 2026-06-17T13:20:00Z — Data Engineer — feat-connector-backfill (BOUNCE r1)
**Stage:** 3 (re-entry) · **Layer:** stream+batch · **Tier:** deterministic
**Parity:** PASS vs registry (unchanged) · **Replayable:** yes · **Verification:** `pnpm exec vitest run` → 67/67 PASS (5 files; +6 new tests T11+T12) · **Next:** READY-FOR-SECURITY

SEC-BF-H1 fix: migration 0023_backfill_job_enumeration.sql — SECURITY DEFINER fn list_queued_backfill_jobs() (owner: brain, search_path=public pinned, GRANT EXECUTE to brain_app). run.ts findQueuedJob() now calls the fn (no GUC at enumeration time); loadConnectorInstance() sets GUC before connector_instance+brand query. brand_id authority: fn result only, never env/Shopify. Comment at ~:211 corrected (was "superuser pool" — false; now accurately describes brain_app + SECURITY DEFINER fn). DB proof: brain_app direct query without GUC → 0 rows; fn via brain_app → 1 row returned.

QA-BF-B2 fix: T11 (findQueuedJob direct path under fixed fn — negative control + positive proof); T12 (past-dated LedgerWriter provisional → runRevenueFinalization() invoked → finalizedCount===1, event_type=finalization, amount_minor=250000 preserved, idempotent on second run). All under brain_app, not superuser.

Deferred (no change): SEC-BF-M2 (LedgerWriter drift), SEC-BF-L1 (dual PgBackfillJobRepository).

Commits:
- 2f244d2: fix(backfill): SEC-BF-H1+M1 — SECURITY DEFINER enumeration fn fixes worker inert-in-prod bug
- d35cedb: test(backfill): QA-BF-B1+B2 — T11 findQueuedJob fix proof + T12 past-dated→realized end-to-end

## 2026-06-15T12:00:00Z — Data Engineer — M1-database-and-migration-plan
**Stage:** 3 · **Layer:** batch+lakehouse · **Tier:** deterministic
**Parity:** N/A (plan artifact) · **Replayable:** yes (Bronze SoR; same dbt path for live+backfill; no separate backfill codebase) · **Verification:** plan grounded in doc 08 §3/§4/§5/§6/§7/§11/§13/§36/§37, doc 10 §6/§7/§8, doc 11 §1, STACK.md ADR-001/002, Sprint-0 baselines (0001_init.sql, bronze_table.sql, bootstrap.sql, silver_template.sql); written to docs/plans/M1-database-and-migration-plan.md · **Next:** READY-FOR-SECURITY
