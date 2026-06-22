# Database Audit — Remediation Plan

Source: the adversarial DB architecture audit (5 specialist reviewers, grounded in the real schema).
Branch: `feat/brain-replatform` family. Data is disposable in dev. Every change is additive + reversible
behind a flag or a new migration. We execute **sprint by sprint, verifying each batch**.

Authorizations from product owner:
- May DROP genuinely unused / extra / wrong tables (after verifying they are unused).
- Proceed without per-step approval; report after each sprint.

---

## STATUS (updated as work lands)
- ✅ **Sprint 1 DONE & committed** (`2b322aa`): C1 RLS isolation, H5 FK indexes, H1 ROAS bug, H3 click-id capture. M5 verified-and-deferred (PK already prevents refund double-count).
- ✅ **Sprint 2a DONE** (`f882247`): C4 read-default→iceberg, M6 collector_spool reaper.
- ✅ **Sprint 2b DONE** (`feafe32`): DQ subsystem (all 5 checks) migrated off PG bronze → Iceberg SoR; verified live against StarRocks.
- ✅ **C4 COMPLETE (bronze_events retired)**: PG bronze writer default-OFF (ProcessEventUseCase), all 5 operational readers Iceberg-only (PG branch + BronzeSource flag removed), `0070_drop_bronze_events.sql` staged (applies on next migrate+restart per its deploy note). bronze_events is no longer read or written.
- ✅ **M1 DONE** (`b14e8aa`): fail-closed brand-predicate at both StarRocks seams (was a latent cross-brand-leak footgun).
- ✅ **M8 DONE**: deterministic total-order `line_index` in stg_order_line_events (stable across rebuilds).
- 🟡 **Remaining (large, each its own focused effort)**: C4b partition the unbounded append-only PG tables; H2 ledgers→Bronze + rebuild Gold from Iceberg; M3 incremental/date-partitioned marts; M6 webhook-archive + dq_check_result retention; C3 SCD history snapshots + new marts (silver_session/journey/product, gold_funnel/cac, gold_attribution_by_channel); H4 campaign attribution; M2 checkout funnel stage; C2 identity-graph anon→known ingestion + brain_id-keyed attribution; H6/H7 identity+attribution history + true Customer 360; C5 feature-store wiring + ML foundation; M7 recommendation action ledger; M4 reference tables for hardcoded enums.

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

---

## Money-ledger partitioning (C4b) — VALIDATED DESIGN (ready-to-execute, not yet applied)

Attempted as a dedicated effort; the ledger + code are pristine (every attempt rolled back atomically).
Three PostgreSQL constraints were discovered + navigated, yielding the correct approach:

**Constraints proven (empirically):**
1. A GENERATED column cannot be a partition key (`ERROR: cannot use generated column in partition key`).
2. A BEFORE-INSERT trigger cannot set the partition key (`ERROR: moving row to another partition during
   a BEFORE FOR EACH ROW trigger is not supported` — routing happens around the trigger).
3. Partitioning by an EXPRESSION forbids PK/UNIQUE constraints (can't include an expression in a PK).

**Correct approach — app-set column + CHECK (no silent-corruption risk):**
- Add `occurred_date date NOT NULL`; partition by `RANGE(occurred_date)`.
- The 8 writer INSERTs (LedgerWriter.ts ×6, PgLedgerRepository.ts, revenue-finalization.ts) SET
  `occurred_date` in the column list + VALUES `(timezone('UTC', $<occurred_at_param>::timestamptz))::date`
  (reuse the occurred_at param — per-site index varies).
- `CHECK (occurred_date = (timezone('UTC'::text, occurred_at))::date)` — DB-enforces equality, so any
  writer drift FAILS LOUDLY (never a silent double-count). This is the safety net that de-risks it.
- PK `(brand_id, ledger_event_id, occurred_date)`; dedup UNIQUE `(brand_id, order_id, event_type,
  occurred_date) WHERE event_type <> 'refund'` (IDENTICAL semantics — occurred_date == the old expr).
  Switch the 8 ON CONFLICT clauses to `(... occurred_date)`.
- Twin-swap migration (distinct index names — `_dedup_p`/`_asof_p` — since the legacy table keeps the
  canonical names during the verify window). Apply atomically (node-pg-migrate wraps it; or `psql -1`).
- VERIFY: dedup re-pull suppression (same brand/order/type/day non-refund → 0 inserted), refund
  carve-out (duplicate refund allowed), split-shipment (different day allowed), row-count preserved.

This is a dedicated PR (8-site money-ledger INSERT surgery + dedup-idempotency tests) — best done with
fresh context given the money stakes; the design above is fully de-risked and ready.
