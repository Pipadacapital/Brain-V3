# Pending Stakeholder Commit — feat-connector-backfill

**Final review:** PASS / APPROVE (Stage 6, 2026-06-17). Awaiting Stakeholder gate (Stage 7).
**Branch:** `feat/connector-backfill` (base `master`). 0 blocking.

The work is already committed slice-by-slice on the feature branch (commit-per-slice). The Stakeholder action at Stage-7 is the **conscious accept + commit/merge**, not a fresh build. The final-reviewer did NOT commit and did NOT advance the gate.

## Product-code surface (explicit paths — NO `git add -A`)

If a squash/verification re-stage is wanted, stage ONLY these product-code paths (do NOT sweep run-folder/state/journal artifacts):

```bash
git add \
  apps/core/src/main.ts \
  apps/core/src/modules/connector/backfill/infrastructure/PgBackfillJobRepository.ts \
  apps/core/src/modules/connector/backfill/tests/backfill-trigger.live.test.ts \
  apps/stream-worker/src/infrastructure/pg/BackfillJobRepository.ts \
  apps/stream-worker/src/infrastructure/pg/LedgerWriter.ts \
  apps/stream-worker/src/infrastructure/redis/RedisDedupAdapter.ts \
  apps/stream-worker/src/interfaces/consumers/BackfillOrderConsumer.ts \
  apps/stream-worker/src/jobs/shopify-backfill/money-utils.ts \
  apps/stream-worker/src/jobs/shopify-backfill/order-mapper.ts \
  apps/stream-worker/src/jobs/shopify-backfill/run.ts \
  apps/stream-worker/src/jobs/shopify-backfill/shopify-paged-client.ts \
  apps/stream-worker/src/jobs/shopify-backfill/uuid-utils.ts \
  apps/stream-worker/src/jobs/shopify-backfill/worker-secrets.ts \
  apps/stream-worker/src/main.ts \
  apps/stream-worker/src/tests/backfill.e2e.test.ts \
  apps/stream-worker/src/tests/bronze.e2e.test.ts \
  apps/web/components/connectors/backfill-control.tsx \
  apps/web/components/connectors/connectors-list.tsx \
  apps/web/components/dashboard/realized-revenue-card.tsx \
  apps/web/e2e/backfill.spec.ts \
  apps/web/lib/api/client.ts \
  apps/web/lib/hooks/use-backfill.ts \
  apps/web/next.config.js \
  db/migrations/0022_backfill_job.sql \
  db/migrations/0023_backfill_job_enumeration.sql \
  infra/redpanda/topics.yml \
  packages/contracts/src/api/connector.backfill.api.v1.ts \
  packages/contracts/src/events/order.backfill.v1.ts \
  packages/contracts/src/index.ts \
  pnpm-lock.yaml
```

## Migrations applied on merge (additive only, I-E02)

- `db/migrations/0022_backfill_job.sql` (backfill_job table, FORCE RLS, no-DELETE grant)
- `db/migrations/0023_backfill_job_enumeration.sql` (`list_queued_backfill_jobs()` SECURITY DEFINER enumeration fn)

## Residual the Stakeholder consciously accepts (all non-blocking)

- **SEC-BF-M2 (MED, open):** dual `LedgerWriter` may drift — aligned today (byte-identical ON-CONFLICT key), post-M1 shared `@brain/ledger-writer` package.
- **SEC-BF-L1 (LOW, open):** dual `PgBackfillJobRepository` (intentional split, I-E05) — post-M1 shared package.
- **Dev-token reachability (tracked validation follow-up):** a real live Boddactive dev backfill needs the OAuth token reachable by the stream-worker process (ADR-BF-11). The SLICE (fixtures + proven finalization path) is complete; this is the Stage-validation step, not a merge blocker.

## /adopt-rule recommended

3rd occurrence of the system-job-under-FORCE-RLS pattern — proposal at `.engineering-os/rule-proposals/system-job-force-rls-enumeration.md`. Act: `/adopt-rule system-job-force-rls-enumeration`.

## Exit criterion delivered

First real third-party data path through the M1 spine: worker-runs (non-inert), payoff-proven (past-dated → finalization → realized GMV, real code executed), PII-stripped, brand-isolated, two-lane. All five load-bearing gates independently replicated at source by the final reviewer.
