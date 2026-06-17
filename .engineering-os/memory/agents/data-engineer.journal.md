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
