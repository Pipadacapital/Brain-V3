# Pending Stakeholder Commit — feat-shopify-live-connector

**Final review:** PASS / APPROVE (Stage 6, 2026-06-17). Awaiting Stakeholder gate (Stage 7).
**Branch:** `feat/shopify-live-connector` (base `master`). 0 blocking.

The work is already committed slice-by-slice on the feature branch (commit-per-slice, incl. the ORCH-LV-H1 DELTA fix commits 3bbdf86 + c836011). The Stakeholder action at Stage 7 is the **conscious accept + commit/merge**, not a fresh build. The final reviewer did NOT commit and did NOT advance the gate.

## Product-code surface (explicit paths — NO `git add -A`)

If a squash/verification re-stage is wanted, stage ONLY these product-code paths (do NOT sweep run-folder/state/journal artifacts):

```bash
git add \
  apps/core/package.json \
  apps/core/src/main.ts \
  apps/core/src/modules/connector/sources/storefront/shopify/application/commands/RegisterWebhooksCommand.ts \
  apps/core/src/modules/connector/sources/storefront/shopify/interfaces/webhooks/shopifyWebhookHandler.ts \
  apps/core/src/modules/connector/sources/storefront/shopify/tests/shopifyWebhookHandler.integration.test.ts \
  apps/stream-worker/package.json \
  apps/stream-worker/src/infrastructure/pg/LedgerWriter.ts \
  apps/stream-worker/src/interfaces/consumers/LiveLedgerBridgeConsumer.ts \
  apps/stream-worker/src/interfaces/consumers/LiveOrderConsumer.ts \
  apps/stream-worker/src/jobs/shopify-backfill/money-utils.ts \
  apps/stream-worker/src/jobs/shopify-backfill/order-mapper.ts \
  apps/stream-worker/src/jobs/shopify-backfill/run.ts \
  apps/stream-worker/src/jobs/shopify-backfill/uuid-utils.ts \
  apps/stream-worker/src/jobs/shopify-repull/run.ts \
  apps/stream-worker/src/jobs/shopify-repull/shopify-live-client.ts \
  apps/stream-worker/src/main.ts \
  apps/stream-worker/src/tests/live-connector.e2e.test.ts \
  apps/stream-worker/src/tests/live-ledger-wiring.e2e.test.ts \
  apps/web/components/dashboard/connection-status-card.tsx \
  apps/web/e2e/live-sync.spec.ts \
  apps/web/lib/hooks/use-dashboard.ts \
  db/migrations/0026_live_connector_security_definer_fns.sql \
  packages/shopify-mapper/package.json \
  packages/shopify-mapper/src/index.ts \
  packages/shopify-mapper/tsconfig.json \
  pnpm-lock.yaml
```

## Migrations applied on merge (additive only, I-E02)

- `db/migrations/0026_live_connector_security_definer_fns.sql` — `list_connectors_for_repull()` + `resolve_connector_by_shop_domain(text)`, both SECURITY DEFINER, search_path=public, dispatch-only, GRANT EXECUTE TO brain_app, migration-time assertion blocks. ROLLBACK = `DROP FUNCTION`. No table/policy changes; 0025 untouched.

## Residuals the Stakeholder consciously accepts (all non-blocking)

- **SEC-LV-M1 (MED, open):** re-pull `acquireRepullLock` commits the SKIP-LOCKED lock before the page loop → narrow window for a concurrent double-run. Worst case = duplicate Shopify API calls; Bronze event_id dedup + ledger ON CONFLICT DO NOTHING absorb it (no correctness/isolation/money breach). M1+ remediation (hold lock for full run, or status='syncing' pre-check).
- **SEC-LV-L1 (LOW, open):** non-null assertion on webhook `updatedAt` could pass NaN to the live event_id. Shopify always sends `updated_at` on order webhooks. One-line guard follow-up (discard with 200).
- **Dev-honesty (stated):** real Shopify webhook delivery needs public ingress (platform follow-up). Dev proves the receive path via synthetic HMAC inject() + the 35-day re-pull against live Boddactive (the dev freshness mechanism).
- **Pre-existing tsc error:** `apps/stream-worker/src/jobs/shopify-backfill/worker-secrets.ts` AwsSecretsManager cross-rootDir import — confirmed pre-existing on master, not introduced here, out of scope.

## /adopt-rule — NOT recommended this run

The wired-to-nothing pattern (consumer/recognition-writer built but not wired into the deployable) is at **occurrence #2** (ADR-BF-9 + ORCH-LV-H1). The 3-occurrence threshold (per the system-job-force-rls precedent) is not yet met → WATCH + lessons-learned filed; propose the durable rule at occurrence #3. See `pending-stakeholder-attention.md` and `lessons-learned.md`.

## Exit criterion delivered

The M1 connector path is end-to-end complete (connect → backfill → live sync). Live recognition is wired in the deployable and live-proven (ledger 19,488 → 20,285, 49 rto_reversal from real cancelled Boddactive orders). All load-bearing gates (D-6 dedup, anti-spoof, RTO-reversal, no-GUC negative control, append-only GRANT, isolation, SECURITY DEFINER fns) independently re-replicated at source by the final reviewer under the real brain_app role.
</content>
