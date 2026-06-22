# Database Audit — Remediation Plan

Source: the adversarial DB architecture audit (5 specialist reviewers, grounded in the real schema).
Branch: `feat/brain-replatform` family. Data is disposable in dev. Every change is additive + reversible
behind a flag or a new migration. We execute **sprint by sprint, verifying each batch**.

Authorizations from product owner:
- May DROP genuinely unused / extra / wrong tables (after verifying they are unused).
- Proceed without per-step approval; report after each sprint.

---

## Sprint 1 — Critical isolation + low-risk high-value (SHIP-BLOCKERS)

| ID | Item | Files / migration | Risk |
|----|------|-------------------|------|
| C1 | RLS on `audit.audit_log`, `tenancy.brand_keyring`; restrict `data_plane.collector_spool` | new `0067_audit_security_rls_isolation.sql` | Low (keep system-writer path) |
| H5 | 8 FK covering indexes (`CREATE INDEX CONCURRENTLY`) | new `0068_fk_covering_indexes.sql` | Low |
| M5 | Refund dedup: replace `WHERE event_type <> 'refund'` carve-out with stable-key dedup | new `0069_refund_dedup_fix.sql` | Medium (money ledger) → add test |
| H1 | Google Ads per-channel ROAS: map `google_ads` (not `google`) + parity test | `attribution-channel-roas.ts` + test | Low |
| H3 | Add click IDs `msclkid/gbraid/wbraid/dclid` + full landing URL | `pixel-sdk/attribution.ts`, contracts, dbt staging, channel CASE, confidence | Low (additive) |

Verify: typecheck, affected live tests, RLS live check.

## Sprint 2 — Scale + lakehouse-as-SoR

| ID | Item | Risk |
|----|------|------|
| C4 | Flip `BRONZE_OPERATIONAL_READ_SOURCE` default → `iceberg`; retire PG bronze writer; DROP `data_plane.bronze_events` after parity bake | Medium |
| C4b | RANGE-partition append-only PG tables (ledgers, audit/send logs, dq_check_result, webhook archive) | Medium |
| H2 | Land ledger `*.live.v1` into Bronze; rebuild `gold_revenue_ledger`/`gold_marketing_attribution` from Iceberg | Medium |
| M3 | Incremental + date-partitioned dbt/StarRocks marts | Medium |
| M6 | Retention reapers: `collector_spool`, `connector_webhook_raw_archive`, `dq_check_result` | Low |

## Sprint 3 — Analytics completeness + history

| ID | Item |
|----|------|
| C3 | dbt SCD2 snapshots (`snap_order_state`, `snap_customer`, `snap_attribution_credit`) + `feature_customer_daily` Iceberg snapshot |
| — | New marts: `silver_session`, `silver_journey`, `silver_product`, `gold_funnel`, `gold_cac`, `gold_attribution_by_channel` |
| H4 | Populate `attribution_credit_ledger.campaign_id` → campaign/ad-level ROAS |
| M2 | Add checkout stage to storefront funnel; stitch `silver_checkout_signal` |
| M8 | Deterministic `line_index` disambiguator |

## Sprint 4 — CDP + AI foundation

| ID | Item |
|----|------|
| C2 | Ingest `brain_anon_id`/`device_id` into the identity graph; key attribution on resolved `brain_id` |
| H6/H7 | Identity history (`first_identified_at`), attribution-result snapshots, true Customer 360 join |
| C5/H8 | Wire feature-store consumer (or delete materialization job); product-interaction mart; ml-lifecycle |
| M7 | `recommendation_action` ledger (served/accepted/dismissed) |

## Cross-cutting hardening (fold into the sprints)
- M1: fail-closed `BRAND_PREDICATE` assertion in `silver-deps`/`runScoped`; StarRocks row policy on prod; CI lints.
- M4: reference tables for currency/timezone/metric-id enums; `connector_external_id` child table.
- L-items: `updated_at`/soft-delete convention; commit Bronze compaction cron; pixel_installation TTL cache; multi-currency cohort grouping; prod-gate `dev_secret`.

## Cleanup (delete unused/extra/wrong) — verify-before-drop
- `data_plane.bronze_events` (Sprint 2, after Iceberg flip).
- Orphaned feature-store materialization job if no consumer wired (Sprint 4 / C5).
- Verify `connector_journey_stitch_map` / `connector_razorpay_order_map` usage before any move/drop.
- GoKwik AWB rip-out (separate parked task; map already produced).
