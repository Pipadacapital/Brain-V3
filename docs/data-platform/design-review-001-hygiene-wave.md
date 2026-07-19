# Design Review 001 — Hygiene Wave

**Status:** APPROVED 2026-07-19 (owner: "go 1+2" — Stages A–C + rename) — EXECUTED on this branch; prod catalog steps in §8 runbook remain post-promotion
**Author:** Data Platform Architect session, 2026-07-19
**Scope:** 24 dead objects across Iceberg, duckdb-serving, and PostgreSQL + rename/merge dispositions
**Companion ledger:** `docs/data-inventory-2026-07-19.md` (full inventory, classifications, live counts)

---

## 1. Problem

The platform carries objects that are provably dead — never-populated parity tables, a serving view that errors every epoch, a superseded archive table, an empty schema, and 13 serving views with no reader. Each one costs a little every day (tick time, log noise, apply surface, backup surface, reviewer confusion) and returns nothing. One is actively harmful: a guaranteed Catalog Error per serving epoch trains operators to ignore red log lines.

### Objects in scope, classified

| # | Object | Store | Class | Evidence (verified 2026-07-19) |
|---|---|---|---|---|
| 1–6 | `silver_collector_event_{shopify,woocommerce,ga4,shiprocket,shopflo,razorpay}_shadow` + their 6 `silver_*_normalize.py` jobs + helpers `_normalize_base.py`, `_raw_normalize_ports.py` | Iceberg Silver | DORMANT → DELETE CANDIDATE | Parity targets (`*_raw_connect` lanes) retired ADR-0016; jobs skip via `source_present()` every tick; 0 rows each; helpers consumed by these 6 jobs only |
| 7 | `mv_bronze_events_unified` | duckdb-serving | BROKEN → DELETE CANDIDATE | References retired `shopify_orders_raw_connect`; Catalog Error + skip every epoch in serving logs |
| 8–19 | 12 unread views: `mv_gold_campaign_performance`, 5× `mv_gold_measurement_*`, `mv_gold_product_costs`, `mv_silver_keyword_spend`, 4× `mv_silver_marketing_spend_by_*` | duckdb-serving | REDUNDANT → DELETE CANDIDATE | Zero readers in apps/ or packages/ (grep-verified, excl. dist/). NOTE: underlying marts are judged separately — `gold_campaign_performance` stays (ACTIVE via `semantic_campaign`); `gold_measurement_costs`/`_fees` stay (feed `gold_order_economics`) |
| 20 | `connectors.connector_webhook_raw_archive_legacy` | PostgreSQL | LEGACY → DELETE CANDIDATE | 0 rows; superseded by partitioned `connector_webhook_raw_archive`; zero code references outside migrations |
| 21 | `data_plane` schema | PostgreSQL | LEGACY → DELETE CANDIDATE | Empty since 0139/0141 drops |
| 22 | Dead raw-lane branches in `maintenance/bronze_raw_retention.py`, `erasure_raw_delete.py`, stale comment in `seed_bronze_fixture.py` | transform code | DEAD CODE | Target lanes retired ADR-0016; branches skip on absence every run |
| 23 | `_normalize_base` patch block in `run_all.py` | transform code | DEAD CODE (after #1–6) | try/except import of a deleted module |
| 24 | `brain_gold.journey_events` table name | Iceberg Gold | ACTIVE — RENAME CANDIDATE | See §7 |

**Explicitly out of scope** (their own reviews): `mv_gold_cod_rto` / `mv_gold_engagement` views and marts (Review 006, wire-or-kill — product decision pending); the 7 write-only Silver tables + 3 unconsumed measurement marts (Review 002); `public.gold_product_costs` ownership (Review 003). **Protected, never in scope:** all compliance/audit write-only tables.

## 2. Analysis

- **Recreate cost is ~zero for every object here.** Views are one SQL file; shadow tables were never populated; the legacy archive is empty; all deleted code stays in git history. Every Iceberg deletion is covered by the replay guarantee (Bronze retains the raw events).
- **Keep cost is recurring:** 6 no-op job invocations per transform tick, ~13 views applied at every serving startup and implicitly promised to consumers, one guaranteed error per serving epoch, one dead table in every backup/restore/vacuum cycle, and a mental tax on every engineer who greps into them.
- **Sequence-cascade check performed:** the live partitioned archive's `id` default uses `connector_webhook_raw_archive_part_id_seq`; the legacy table owns the separate `connector_webhook_raw_archive_id_seq`. Dropping legacy cascades only to its own sequence and RLS policy — the live archive is untouched (verified against the running DB and baseline DDL).
- **Semantic-layer check performed:** `semantic_campaign` (fixed entity, `packages/semantic-metrics` + metric-engine) reads `gold_campaign_performance` — the mart is ACTIVE; only its direct `mv_` view is unread and deletable.

## 3. Trade-offs

| Option | Gain | Cost |
|---|---|---|
| Delete (recommended) | −8 transform files, −13 view files, −1 PG table, −1 schema; clean serving logs; every surviving view is monitorable as "must work" | One-time PR + runbook step; recreating any view later is a one-file change |
| Keep and document | No change risk | All recurring costs persist; "documented dead" still rots |
| Deprecation period (mark, delete next quarter) | Extra safety window | These objects have had 0 readers/rows since creation or since ADR-0016; a window adds delay, not information |

## 4. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Out-of-repo reader of a deleted view (ad-hoc notebook, external BI) | Low — serving is not exposed publicly; app/BFF are the only sanctioned readers (doctrine) | Query fails with clear "view not found" | Views are one-file recreatable; serving logs identify the caller |
| Stale in-cluster image tick recreates a shadow table after catalog drop | Medium during rollout window | Empty orphan table reappears | Order of operations: merge + image rollout FIRST, catalog drops AFTER (runbook §6); re-check catalog post-rollout |
| Iceberg drop is destructive | — | Shadow tables hold 0 rows; nothing to lose | Use non-purge drop (metadata drop; data files — none exist — would remain until snapshot expiry) |
| PG `DROP TABLE`/`DROP SCHEMA` lock | — | AccessExclusive on an unreferenced, 0-row table: instantaneous | `IF EXISTS` idempotent; run in one short transaction |
| `run_all.py` required-jobs list breakage | — | None — silver/gold tiers are glob-discovered; none of the deleted jobs appear in `required`/`ordered` lists (verified) | — |

## 5. Alternatives considered

1. **Fix `mv_bronze_events_unified` instead of deleting** — rejected: post-ADR-0016 there is exactly one Bronze lane, so a "unified" union over one table is the lift view (`collector_events_connect_lifted`) with extra steps. Nothing reads it.
2. **Keep `_normalize_base.py` for future normalize jobs** — rejected: any future parity job would target the collector lane, not raw lanes; the base class encodes the retired pattern. Git history preserves it.
3. **Keep unread views "for the future"** — rejected: a view with no reader is untested API surface; the day a reader exists is the day the one-file view returns, reviewed against the actual query shape.

## 6. Recommended solution — four stages, one PR + one runbook

**Stage A — repo deletions** (one commit): delete the 8 silver files (#1–6 + 2 helpers), 13 view SQL files (#7–19), the `_normalize_base` patch block + `run_normalize_job` docstring mentions in `run_all.py` (#23), dead raw-lane branches in the two maintenance sweeps + stale fixture comment (#22).

**Stage B — PG migration `0142`** (same PR): SQL in §8.

**Stage C — Iceberg catalog drops** (runbook, post-rollout): drop the 6 shadow tables via PyIceberg after the new transform image is live in each environment (dev first, prod after promotion).

**Stage D — rename decision** (§7; separate commit if approved).

Branch → PR → `release` per the release-layer flow; checks run at promotion.

## 7. Renames & merges — dispositions (owner asked: apply where required, zero functionality impact)

| Candidate | Disposition | Reasoning |
|---|---|---|
| `brain_gold.journey_events` → `gold_journey_events` | **RECOMMEND — conditional** | Only mart violating the `gold_*` naming invariant; a standing footgun (already bit one inventory pass). Zero app impact: apps read `mv_journey_events_current` / `mv_gold_journey_timeline` / `semantic_journey` only — rename is contained to db/iceberg (2 jobs, 2–3 view files, snapshot job refs). Cost grows with data volume; prod journey volume is near-zero today, so the safe moment is now. **Condition:** verify prod row count is trivial before executing; same stale-image caveat as Stage C (rename after image rollout; one stale tick would recreate an empty `journey_events`, cleaned by a post-check). Rollback = rename back (metadata-only, PyIceberg `rename_table`). |
| `public.gold_product_costs` → domain schema | **DEFER to Review 003** | Touches app read paths and RLS policy; bundling app-code change into a deletion wave violates small-reversible. Review 003 owns product-cost authority end-to-end. |
| Merge `iam.email_verification` + `iam.password_reset` into one token table | **REJECTED** | Auth-flow code churn and a type-discriminator column for zero storage gain (both near-empty forever); two small clear tables beat one clever one. Never merge for aesthetics. |
| `connectors.connector_journey_stitch_map` vs `ops.silver_journey_stitch` | **FLAGGED for Review 004** | Same fact (order → stitched anon/brain_id) in two PG tables with different writers — a genuine REDUNDANT suspect, but consolidating it belongs with the identity-projection review, not a hygiene wave. |
| Shadow/legacy objects "rename to `_deprecated`" | **REJECTED** | Renaming dead objects is maintenance of the dead. Delete. |

## 8. SQL / implementation

### Migration `db/migrations/0142_drop_legacy_archive_and_data_plane.sql`

```sql
-- 0142 — hygiene: drop the superseded legacy webhook archive + the empty data_plane schema.
-- Legacy archive: 0 rows, superseded by partitioned connectors.connector_webhook_raw_archive
-- (which uses its OWN sequence connector_webhook_raw_archive_part_id_seq — verified: dropping
-- legacy cascades only to its own connector_webhook_raw_archive_id_seq + RLS policy).
-- data_plane: empty since 0139 (ingest_dedup) and 0141 (collector_spool).
-- IF EXISTS keeps both idempotent. Lock: AccessExclusive on an unreferenced 0-row table — instant.

DROP TABLE IF EXISTS connectors.connector_webhook_raw_archive_legacy;
DROP SCHEMA IF EXISTS data_plane;
```

### Rollback SQL (kept in the migration header comment)

```sql
CREATE SCHEMA IF NOT EXISTS data_plane;

CREATE TABLE connectors.connector_webhook_raw_archive_legacy (
    id bigint NOT NULL,
    brand_id uuid NOT NULL,
    source text NOT NULL,
    topic text NOT NULL,
    body_sha256 text NOT NULL,
    received_at timestamptz DEFAULT now() NOT NULL,
    correlation_id text,
    redacted_body jsonb NOT NULL
);
CREATE SEQUENCE connectors.connector_webhook_raw_archive_id_seq
    START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1
    OWNED BY connectors.connector_webhook_raw_archive_legacy.id;
ALTER TABLE ONLY connectors.connector_webhook_raw_archive_legacy
    ALTER COLUMN id SET DEFAULT nextval('connectors.connector_webhook_raw_archive_id_seq'::regclass),
    ADD CONSTRAINT connector_webhook_raw_archive_pkey PRIMARY KEY (id),
    ADD CONSTRAINT connector_webhook_raw_archive_dedup UNIQUE (brand_id, topic, body_sha256);
CREATE INDEX idx_webhook_raw_archive_brand_received
    ON connectors.connector_webhook_raw_archive_legacy (brand_id, received_at DESC);
ALTER TABLE connectors.connector_webhook_raw_archive_legacy ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY connectors.connector_webhook_raw_archive_legacy FORCE ROW LEVEL SECURITY;
CREATE POLICY connector_webhook_raw_archive_isolation
    ON connectors.connector_webhook_raw_archive_legacy TO brain_app
    USING ((brand_id = (NULLIF(current_setting('app.current_brand_id', true), ''))::uuid));
```

### Validation SQL

```sql
SELECT to_regclass('connectors.connector_webhook_raw_archive_legacy') IS NULL AS legacy_gone;
SELECT NOT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'data_plane') AS schema_gone;
-- live archive unaffected:
SELECT column_default FROM information_schema.columns
 WHERE table_schema='connectors' AND table_name='connector_webhook_raw_archive' AND column_name='id';
-- expect: nextval('connectors.connector_webhook_raw_archive_part_id_seq'::regclass)
```

### Iceberg catalog drops (Stage C runbook, per environment, AFTER image rollout)

```python
from pyiceberg.catalog import load_catalog
cat = load_catalog("rest", uri=..., warehouse=...)   # same conn params as maintenance jobs
for t in ["shopify", "woocommerce", "ga4", "shiprocket", "shopflo", "razorpay"]:
    cat.drop_table(f"brain_silver.silver_collector_event_{t}_shadow")  # metadata drop, no purge
# Stage D (if approved, prod row-count check first):
# cat.rename_table("brain_gold.journey_events", "brain_gold.gold_journey_events")
```

## 9. Validation steps (dev, then repeat semantics in prod post-promotion)

1. `tools/dev/duckdb-refresh.sh` green from current volumes; failures = 0.
2. duckdb-serving restart: `/readyz` 200; **zero** Catalog Error lines in the apply log (the events_unified error disappears); applied view count 63 → 50.
3. `tools/lint/v4-naming-guard.sh` passes; repo-wide grep for every deleted identifier returns only git history/docs.
4. Migration up on a dev copy → validation SQL above → rollback SQL → up again (idempotency proof).
5. App smoke: orders list (`mv_silver_order_state`), revenue metrics (`mv_gold_revenue_ledger`), journey timeline — unchanged responses.
6. Record transform tick wall-clock before/after (expect a small improvement; evidence for Review 002's larger claim).

## 10. Rollback strategy

- **Stages A/D (code, rename):** `git revert`; rename back via `rename_table` (metadata-only).
- **Stage B (PG):** rollback SQL above; table was empty, so restore is structural only — no data to restore.
- **Stage C (Iceberg):** non-purge drop leaves metadata/files recoverable via `register_table` until snapshot expiry; the tables hold 0 rows, so worst case is re-running DDL.

## 11. Monitoring requirements

- Serving: alert on any view-apply error at startup (now meaningful — the permanent red line is gone); track applied-view count as a gauge (expected: 50).
- Transform: tick duration and per-tier failure count (existing) — watch one week post-merge.
- PG: existing backup job unaffected; confirm next backup succeeds post-migration.
- Quarterly hygiene loop: re-run the inventory ledger against live catalogs; diff against `docs/data-inventory-2026-07-19.md`.

## 12. Future scalability

This wave shrinks surface, not capacity — its scalability value is operational: every remaining serving view is a monitorable contract, every remaining transform job does real work, and the serving error channel becomes trustworthy. It also establishes the pattern (classify → evidence → staged delete → replay guarantee) that Reviews 002–006 reuse on the heavier objects.
