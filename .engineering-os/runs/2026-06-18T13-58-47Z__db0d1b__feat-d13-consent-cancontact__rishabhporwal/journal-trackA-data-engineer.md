# Track A — Data Engineer journal — feat-d13-consent-cancontact

## 2026-06-18T18:14Z — Data Engineer — feat-d13-consent-cancontact
**Stage:** 3 · **Layer:** stream + lakehouse(OLTP SoR) · **Tier:** deterministic (0 tokens, $0/mo — fail-closed compliance gate; any model/ML is Reject)

**Delivered (Track A):**
- `db/migrations/0032_consent_record_tombstone.sql` — consent_record (4-category, append-only, PK `(brand_id,subject_hash,category,effective_at)`) + consent_tombstone (append-only, surrogate PK, category-NULL=all). RLS ENABLE+FORCE + NN-1 two-arg fail-closed policy (verbatim 0017). Append-only-by-GRANT (SELECT+INSERT only). Idempotency dedup unique indexes on source_event_id (tombstone keyed incl. COALESCE(category,'*') so one event can withdraw multiple categories). 3 migration-time assertions: NN-1, append-only-GRANT, RLS-FORCE.
- `apps/stream-worker/src/application/ProjectConsentUseCase.ts` — pure deterministic projection (consent_flags → records; withdrawn category → record + tombstone). Static `project()` for unit testing. Salt-miss = HARD CRASH (D-2).
- `apps/stream-worker/src/infrastructure/pg/ConsentRepository.ts` — GUC-scoped (brain_app) one-txn writer, ON CONFLICT DO NOTHING (idempotent), mirrors IdentityRepository.
- `apps/stream-worker/src/interfaces/consumers/ConsentSuppressorConsumer.ts` — separate group `stream-worker-consent-suppressor` on EXISTING `dev.collector.event.v1` (no new topic/deployable). D-7 commit discipline + DLQ@MAX_RETRY=5 (copy of CollectorEventConsumer/IdentityBridgeConsumer).
- `apps/stream-worker/src/main.ts` — wired consumer into construction + start sequence + graceful shutdown; reuses the identity-bridge SaltProvider (one sanctioned hasher → subject_hash == identity_link.identifier_value; join preserved).
- Read seam `packages/contracts/src/consent/suppression.ts` (`SuppressionQuery`) — pre-existing scaffold; consumer + migration align to it. Suppression is derived-by-query (no materialized table) — meets <15min DPDP SLA, strictly reversible.

**Parity/correctness:** suppression-derivation (tombstone-wins → latest consent_record state → no-row=fail-closed) verified in-test as the exact read-seam logic. **Replayable:** yes — re-consume topic → ON CONFLICT DO NOTHING → identical state; batch rebuild IS this code path.

**Verification (real Postgres, brain_app NON-INERT):**
- `npx vitest run --no-file-parallelism src/tests/consent-suppressor.e2e.test.ts` → **10 passed / 10**.
  - projection 4 records; marketing=false → tombstone + suppressed(tombstoned); never-seen subject → suppressed(no_consent, fail-closed); replay 3× → exactly 4 records + 2 tombstones (idempotent); cross-brand under brain_app → 0 rows (current_user asserted='brain_app', not 'brain'); no-GUC → 0 rows; per-brand-salt cross-brand hashes differ; subject_hash 64-hex never raw email; no UPDATE/DELETE grant.
- `pnpm typecheck` (stream-worker + contracts): clean on all new/changed files (one PRE-EXISTING unrelated cross-app import error in shopify-backfill/worker-secrets.ts on master — not introduced here).
- DB state proof: grants = {INSERT,SELECT} only on both tables; RLS enabled=true forced=true on both; 3 migration-time assertions passed on apply.
- DLQ unit test still green (no consumer-pattern regression).

**Migration number:** 0032 (next after 0031_connector_journey_stitch_map). Additive only.

**Dev-honesty boundary (handed to Track B):** consent-suppressor RECORDS state only; the DLT/NCPR seams + default-closed stubs + the can_contact() ordered engine + pending_window are Track B (@backend-developer). No fake compliance built here.

**Next:** READY-FOR-SECURITY (Track A). Track B reads the SoR via the `SuppressionQuery` seam; Track C surfaces coverage/suppression/window/gate-activity via BFF.
