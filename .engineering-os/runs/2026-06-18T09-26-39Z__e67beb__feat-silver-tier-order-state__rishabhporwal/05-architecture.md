# 05 — Architecture Plan: feat-silver-tier-order-state

| Field | Value |
|---|---|
| req_id | `feat-silver-tier-order-state` |
| Stage | 2 — Architecture (binding) |
| Lane | high_stakes (data plane, multi_tenancy, money-adjacent) |
| Paradigm | **Tier-0 deterministic** — dbt SQL marts + TypeScript metric-engine aggregation. ZERO model/ML calls. $0/mo, 0 tokens/day. Justification: order lifecycle is a deterministic latest-state fold over an append-only ledger; status-mix is a deterministic GROUP BY. A model call here would be a cost-routing violation. |
| Tracks | T1 @data-engineer (read path + dbt models + run wiring) ∥ T2 @backend-developer (metric-engine Silver seam + BFF) ∥ T3 @frontend-web-developer (order-status-mix UI) |
| Single-Primitive | **clean** — extends the ONE metric-engine (`packages/metric-engine`), the ONE analytics module (`apps/core/.../modules/analytics`), the ONE BFF (`bff.routes.ts`), the ONE dbt project, the ONE StarRocks bootstrap. No new deployable / topic / envelope (I-E05). New read seam (StarRocks pool) is additive to `EngineDeps`. |

---

## 1. The StarRocks↔Postgres read mechanism (THE key decision)

### Decision: StarRocks **JDBC external catalog over Postgres** (`brain_oltp_pg`)

dbt runs against StarRocks (`dbt-starrocks`, `default_catalog`, schema `brain_silver`). The canonical order truth lives in Postgres (`realized_revenue_ledger` + connector order maps), NOT in `bronze_events` and NOT in Iceberg. dbt reads it through a **StarRocks JDBC external catalog** pointed at `brainv3-postgres-1`. Staging models `SELECT ... FROM brain_oltp_pg.public.realized_revenue_ledger`; the mart is a native `brain_silver` PRIMARY KEY (upsert) table written by dbt.

**Why this over the alternatives:**

| Option | Verdict | Reason |
|---|---|---|
| **JDBC external catalog over Postgres** | ✅ **CHOSEN** | Smallest + most reversible. Native StarRocks 3.3.2 feature (JDBC PG supported since v3.0). Zero new deployable, zero sync job, zero new topic. dbt reads live Postgres truth directly; replay = re-run dbt (no copy to drift). Reversible: `DROP CATALOG brain_oltp_pg` removes it cleanly. |
| Bronze→StarRocks sync job (Routine Load / batch copy) | ❌ rejected | Requires a new running process (a deployable or an Argo job) to copy/refresh — violates "no new deployable" intent and adds a freshness-drift surface. Order truth is not yet in `bronze_events`, so there is no Bronze stream to Routine-Load from anyway. |
| Iceberg external catalog (`brain_bronze_local`, exists) | ❌ rejected for THIS slice | The Iceberg catalog (Nessie+MinIO, `db/starrocks/external_iceberg_catalog.sql`) targets **Bronze-on-Iceberg**, which order truth has NOT been migrated to (M1 Bronze = Postgres; Iceberg Bronze is a gated Phase-3 storage flip per doc-13 §13.5). Using it would require first landing the Iceberg Bronze migration — out of scope and larger. |

### Dev boundary (stated honestly — do NOT fake "Silver is live")

> **DEV BOUNDARY — the JDBC catalog reads Postgres as the connecting Postgres user.** In dev that user is superuser `brain`, which **BYPASSES Postgres RLS** (MEMORY: dev-db-superuser-masks-rls). Therefore the JDBC-sourced **staging** read is *cross-brand by construction* in dev — it is a bulk ingest of all brands' order rows into Silver, NOT a tenant-scoped read. **This is correct and intended:** dbt builds Silver for *all* brands (it is the ETL writer, exactly like the stream-worker writes the ledger cross-brand under a privileged role). Per-brand isolation is NOT enforced at the dbt/staging layer; it is enforced at the **Silver READ path** (metric-engine seam, §5) which is the I-ST01 sole reader. The plan's isolation proof (§4) targets that read path, not the JDBC ingest.

> **DEV BOUNDARY — JDBC catalog requires the Postgres JDBC driver JAR on the StarRocks FE/BE.** `driver_url` points at the Maven `postgresql-42.7.4.jar`; the allin1 dev container downloads it on first catalog use. If the dev box has no outbound network, the JAR must be volume-mounted. T1 documents the actual mechanism used and the offline fallback.

> ASSUMPTION: `brainv3-postgres-1` is reachable from the `brainv3-starrocks-1` container on the shared docker network at host `postgres:5432`, db `brain`. T1 verifies and records the exact `jdbc_uri` used.

> **PROD SWAP (documented intent, NOT this slice):** in prod the read path graduates to the Iceberg Bronze catalog (`brain_bronze_prod`, Glue+S3) once the Phase-3 Iceberg Bronze flip lands; the dbt staging `source()` swaps from the JDBC catalog to the Iceberg catalog with no mart/intermediate change (the boundary is isolated in `_sources.yml` + the one staging model). This is the ADR-002 one-way `Iceberg → dbt → StarRocks → Analytics API` end-state; the JDBC catalog is the M1 dev/transition mechanism.

---

## 2. dbt models (staging → intermediate → mart)

Layering per `dbt_project.yml`: staging=view, intermediate=view, marts=table. **dbt does ADDITIVE marts ONLY** — the mart is a latest-state fold (a deterministic projection of source rows), NOT a non-additive aggregation. Order-status-mix (COUNT/share) is NON-additive → lives in metric-engine (§5), NOT dbt (ADR-004).

### Source of order lifecycle truth (grounded)
Order lifecycle status is **not a column** anywhere — it is encoded in the `realized_revenue_ledger.event_type` discriminator (`db/migrations/0018_realized_revenue_ledger.sql:66-78` + the `cod_*` types added in `0030`). The canonical lifecycle is derived deterministically from the ledger event stream per `order_id`:

| Ledger `event_type` | Lifecycle contribution | Terminal? |
|---|---|---|
| `provisional_recognition` | `placed` | no |
| `finalization` | `confirmed` | no |
| `cod_delivery_confirmed` | `delivered` | yes |
| `cancellation` | `cancelled` | yes |
| `rto_reversal` / `cod_rto_clawback` | `rto` | yes |
| `refund` / `chargeback` | `refunded` | yes (post-delivery) |

State precedence (deterministic, no model): terminal states win; among terminals the latest `economic_effective_at` wins; non-terminal max-rank wins otherwise. This is a pure ordering — replay-stable.

### Model list

| Model | Path | Materialization | Grain | Purpose |
|---|---|---|---|---|
| `_sources.yml` | `db/dbt/models/staging/_sources.yml` | — | — | Declares the JDBC-catalog source `brain_oltp_pg.public.realized_revenue_ledger`. **The dev-boundary swap point** (JDBC→Iceberg in prod). |
| `stg_order_ledger_events` | `db/dbt/models/staging/stg_order_ledger_events.sql` | **view** | 1 row per ledger event | 1:1 read of lifecycle-relevant `event_type` rows + **dedup** on the natural key `(brand_id, order_id, event_type, occurred_at::date)` (mirrors the 0018 dedup index) via `QUALIFY row_number()`. Casts money to `BIGINT` minor, keeps `currency_code`. NO business math. |
| `int_order_lifecycle` | `db/dbt/models/intermediate/int_order_lifecycle.sql` | **view** | 1 row per ledger event, ranked | Normalizes each event to a canonical `lifecycle_state` (the map above) + a deterministic `state_rank` + `is_terminal`. Carries `brand_id`, `order_id`, `brain_id`, `amount_minor` (signed), `currency_code`, `economic_effective_at`. |
| `silver_order_state` | `db/dbt/models/marts/silver_order_state.sql` | **table** (StarRocks PRIMARY KEY) | **1 row per `(brand_id, order_id)`** | The mart. Latest-state-per-order upsert: pick the winning lifecycle row per order (terminal-wins, then latest `economic_effective_at`, then `state_rank`). Brand-scoped (`brand_id` is the first key col). Money = `order_value_minor BIGINT` + `currency_code`. Additive: a re-run re-derives the same rows (idempotent). |

> ASSUMPTION: `order_value_minor` on the mart = the signed sum of the order's recognized ledger rows (the realized order value), NOT a raw "placed GMV". T2/T1 confirm against `realized_gmv_as_of` semantics; if a placed-value is wanted it comes from the `provisional_recognition` row's `amount_minor`. Stated explicitly so the number is honest.

### `silver.order_state` grain & keys (binding)
- **Grain:** one row per order. **PK:** `(brand_id, order_id)` — tenant-first, StarRocks PRIMARY KEY table (upsert/latest-per-order_id, `enable_persistent_index=true`).
- **Distribution/order:** `DISTRIBUTED BY HASH(brand_id, order_id)`, `ORDER BY (brand_id, order_id)` — per `db/starrocks/ddl/silver_template.sql`.
- **Columns:** `brand_id VARCHAR(36)`, `order_id VARCHAR`, `brain_id VARCHAR(36) NULL`, `lifecycle_state VARCHAR` (placed|confirmed|delivered|cancelled|rto|refunded), `is_terminal BOOLEAN`, `order_value_minor BIGINT`, `currency_code CHAR(3)`, `first_event_at DATETIME`, `state_effective_at DATETIME`, `updated_at DATETIME`.
- **Money invariant (I-S07):** `order_value_minor` is BIGINT minor units, always paired with `currency_code`. NO float/NUMERIC. A dbt assertion (`tests/`) checks the mart column type is `bigint`.
- **Replay-safe:** the fold is a pure function of source rows + deterministic ordering → re-running dbt yields byte-identical state (reproducible from source).

---

## 3. Repeatable dbt-run wiring (replay-safe, no new deployable)

- **`Makefile`** (repo root, new) targets:
  - `silver-catalog` → applies `db/starrocks/oltp_jdbc_catalog.sql` via `mysql -h $STARROCKS_HOST -P 9030 -u root` (idempotent `CREATE EXTERNAL CATALOG IF NOT EXISTS`).
  - `silver-run` → `cd db/dbt && DBT_PROFILES_DIR=profiles dbt run --select staging.stg_order_ledger_events+ ` then `dbt test`. Replayable; re-run = same state.
  - `silver-build` → `silver-catalog` then `silver-run` (full from-scratch reproduce).
- **`db/dbt/profiles/profiles.yml`** — unchanged (already `dbt-starrocks`, `brain_silver`, `default_catalog`). The JDBC catalog is referenced via dbt `source()` (cross-catalog `SELECT FROM brain_oltp_pg....`), so the *target* stays `default_catalog`/`brain_silver`. No profile edit needed.
- **No new deployable / topic / Argo app** (I-E05). The Makefile is a developer/CI invocation; a prod schedule later reuses an existing Argo cron (documented intent, not this slice).
- **Replay/idempotency test:** `db/dbt/tests/assert_order_state_replay.sql` (or a make `silver-verify` that runs `dbt run` twice and diffs `COUNT(*)` + a checksum) proves the second run produces identical rows.

---

## 4. Per-brand isolation on the Silver read — and how to PROVE it non-inert

### The honest mechanism: **brand-filtered read seam** (NOT a StarRocks row policy)

> **PLATFORM BOUNDARY (verified in repo):** StarRocks `CREATE ROW POLICY` is an **enterprise/managed-only** feature; the dev `starrocks/allin1-ubuntu:3.3.2` image does **NOT** support it (`db/starrocks/bootstrap.sql:54-72`, `tools/isolation-fuzz/src/starrocks.test.ts` header). Engine-level row policy CANNOT be proven in dev. The M1 dev isolation guarantee is therefore an **application-injected brand predicate** in the metric-engine Silver seam (the sole reader, I-ST01), enforced by an analytics user with SELECT-only and proven non-inert by a negative-control test.

**The seam (T2):** every Silver read in the metric-engine goes through one helper `withSilverBrand(srPool, brandId, fn)` that:
1. `SET @brain_current_brand_id = '<brandId>'` (session var, matching the row_policy_template convention), AND
2. **always** appends `AND brand_id = ?` (parameterized to `brandId`) to every Silver query — predicate injection at the single seam, never per-call.

This is the StarRocks analogue of `withBrandTxn` (`packages/metric-engine/src/deps.ts`). It is the ONLY place Silver SQL is issued, so the predicate cannot be forgotten by a caller.

### PROVING it non-inert (the anti-inert gate — this is the part that matters)

A predicate the test itself injects proves nothing (the exact bypass-green trap `tools/isolation-fuzz/src/starrocks.test.ts` documents). The proof is **two contrasting raw queries** against `silver.order_state` seeded with brand-A and brand-B rows:

- **Positive:** through `withSilverBrand(brandA)` → returns only brand-A orders (>0), zero brand-B.
- **Negative control (non-inert proof):** the seam, asked for brand-A, issues a query whose result must **exclude** brand-B rows *because the seam injected the predicate* — and a **mutation test**: a sibling test runs the SAME logical read with the predicate-injection **disabled** (a test-only flag on the seam) and asserts it NOW returns brand-B rows. If disabling the seam's filter does NOT leak, the seam was inert (the filter wasn't doing the work) → test FAILS LOUD. This makes the guard's effectiveness observable, the way the R1/M-01 fix demands.
- **Engine-policy gap documented:** the test prints the same FAIL-LOUD note already established — engine-level row policy is the prod graduation step; until a managed StarRocks cluster applies `CREATE ROW POLICY` (`db/starrocks/row_policy_template.sql` template), the seam predicate is the enforcement and the mutation test is its proof.

Test file: `tools/isolation-fuzz/src/silver-order-state.test.ts` (new, extends the existing isolation-fuzz layer-b harness).

> ASSUMPTION: the metric-engine connects to StarRocks as `brain_analytics` (SELECT-only, per `bootstrap.sql:51`), NOT `root`. T2 wires the analytics-user credentials into the Silver pool; reading as a non-DDL user is part of the isolation posture even though row policy is unavailable in dev.

---

## 5. The metric-engine Silver read seam + BFF query (T2)

**order-status-mix is a NON-additive aggregation (COUNT + share by lifecycle_state)** → it lives in the **metric-engine**, NOT dbt (ADR-004 / I-E03). dbt only produced the additive `silver.order_state` mart; the engine does the GROUP BY.

### New Silver read seam in `packages/metric-engine`
- **`packages/metric-engine/src/silver-deps.ts`** (new) — `SilverDeps { srPool }` (a `mysql2/promise` pool to StarRocks :9030 as `brain_analytics`) + `withSilverBrand(srPool, brandId, fn)` (the §4 seam: session var + injected predicate). Mirrors `deps.ts`/`withBrandTxn`.
- **`packages/metric-engine/src/order-status-mix.ts`** (new) — `computeOrderStatusMix(brandId, { srPool }, { from, to })`. Reads `silver.order_state` through `withSilverBrand`, returns `{ hasData, currencyCode, total, byState: [{ lifecycle_state, count: bigint, sharePct: string|null, valueMinor: bigint }] }`. Integer-only share math (reuse the `ratePct` pattern from `cod-mix.ts:59`). NO float. Honest `hasData=false` when the brand has zero Silver rows.
- **`packages/metric-engine/src/order-status-mix.test.ts`** (new) — unit test on the fold (seeded rows → expected counts/shares).
- **`packages/metric-engine/src/index.ts`** — add the two exports (extend the existing re-export block, lines 52-58 pattern).
- **`packages/metric-engine/package.json`** — add `mysql2` to deps (the StarRocks driver; already used by isolation-fuzz). Pin: **resolve latest-stable `mysql2` (3.x)** at build time — do not invent a version.

### Analytics module query wrapper (the I-ST01 sole read path)
- **`apps/core/src/modules/analytics/internal/application/queries/get-order-status-mix.ts`** (new) — thin wrapper around `computeOrderStatusMix` (mirrors `get-cod-rto-rates.ts`). Serializes bigint→string, shapes `state: 'no_data' | 'has_data'`. Passes through a `data_source` (the JDBC-sourced Silver is REAL-shape from real ledger rows, but the ledger's `cod_*` rows are synthetic in dev → label `synthetic` when the underlying source is synthetic, consistent with `cod-mix`).
- **`apps/core/src/modules/analytics/index.ts`** — add `getOrderStatusMix` + types to the public surface (extend the existing export block).

### BFF query (the route)
- **`apps/core/src/modules/frontend-api/internal/bff.routes.ts`** — add `GET /api/v1/analytics/order-status-mix?from=&to=` (mirror the cod-mix route, `bff.routes.ts:1733-1748`): `bffProtectedPreHandler`, brand from session (D-1, NEVER body), honest no_data when `!auth.brandId`, 503 when StarRocks pool absent, call `getOrderStatusMix(auth.brandId, { srPool }, range)`, return `{ request_id, data }`. Import added to the top-of-file analytics import (line 56).
- **StarRocks pool wiring:** `bff.routes.ts` currently holds `rawPool` (pg). Add a `srPool` (mysql2) constructed in the core bootstrap/composition root and threaded into the route registrar — the SAME injection pattern as `rawPool`. The route stays Postgres-free for its own logic; the Silver read goes through the engine seam only.

> Note (ADR-002 honesty): this is the FIRST StarRocks call in `bff.routes.ts` (the file header line 19 says "ZERO StarRocks/OLAP calls"). That header reflected pre-Silver state. The call is still **indirect** — the route calls the analytics use-case which calls the engine seam; the route itself issues no SQL. T2 updates the header comment to "Silver reads go through the metric-engine seam (ADR-002 sole read path); the route issues no OLAP SQL directly."

---

## 6. The order-status-mix UI (T3) — stakeholder-visible (MANDATORY)

Reuse the analytics UI primitives (shadcn Card / KpiTile / Recharts / SyntheticBadge / ErrorCard / Skeleton) exactly as `cod-rto-content.tsx` does.

- **`apps/web/app/(dashboard)/analytics/order-status/page.tsx`** (new) — server shell (mirror `cod-rto/page.tsx`).
- **`apps/web/app/(dashboard)/analytics/order-status/order-status-content.tsx`** (new) — client surface: KpiTiles (total orders, terminal %, delivered count) + a **status-mix bar/donut** (counts + share by lifecycle_state) over a date range. Honest empty state → `EmptyConnectCard` linking `/settings/connectors`. `SyntheticBadge` when `data_source==='synthetic'`. Money via `formatMoneyDisplay` (no `/100`).
- **`apps/web/components/analytics/order-status-mix-chart.tsx`** (new) — Recharts chart with SR-table fallback + `role=img` (a11y parity with `rto-pincode-chart.tsx`).
- **`apps/web/lib/hooks/use-analytics.ts`** — add `useOrderStatusMix()` (mirror `useCodMix`).
- **`apps/web/lib/api/types.ts`** — add `AnalyticsOrderStatusMixResponse` discriminated-union type.
- **`apps/web/e2e/analytics-order-status.spec.ts`** (new) — Playwright: empty state, has-data render, a11y, synthetic badge presence.

---

## 7. Additive migration(s)

**None required on Postgres.** The slice reads existing Postgres tables (`realized_revenue_ledger` + connector maps) and writes only to StarRocks `brain_silver` (managed by dbt, not node-pg-migrate). So **no `0031_*.sql`**.

> The next free Postgres migration number is **0031** (last is `0030_gokwik_shopflo_connectors.sql`) — reserved, not used by this slice. StarRocks DDL for the mart is owned by dbt's `marts` materialization (table created on first `dbt run`); the JDBC-catalog DDL is `db/starrocks/oltp_jdbc_catalog.sql` (new, idempotent, wired into `make silver-catalog`).

---

## 8. The 3 tracks — exact file targets

### T1 — @data-engineer (StarRocks read path + dbt models + run wiring + replay)
**Acceptance contract (REQUIRED pass-1):** JDBC catalog created idempotently + dev-boundary documented in-file; staging dedups on the 0018 natural key; mart grain is exactly `(brand_id, order_id)` PRIMARY KEY upsert; money is BIGINT minor + `currency_code` (dbt type-assert); `make silver-build` reproduces from source; **replay test proves a 2nd `dbt run` yields identical rows**.
- `db/starrocks/oltp_jdbc_catalog.sql` (new — `CREATE EXTERNAL CATALOG brain_oltp_pg` JDBC→Postgres; dev-boundary comment block; `driver_url` pinned to **resolve latest-stable `postgresql` 42.x JDBC jar**).
- `db/dbt/models/staging/_sources.yml` (new — JDBC source decl; the prod-swap boundary).
- `db/dbt/models/staging/stg_order_ledger_events.sql` (new — 1:1 + dedup view).
- `db/dbt/models/intermediate/int_order_lifecycle.sql` (new — normalize + rank view).
- `db/dbt/models/marts/silver_order_state.sql` (new — the mart table, PK upsert, brand-scoped).
- `db/dbt/models/marts/_silver_order_state.yml` (new — dbt tests: unique `(brand_id,order_id)`, not_null keys, `order_value_minor` is bigint, accepted_values on `lifecycle_state`).
- `db/dbt/tests/assert_order_state_replay.sql` (new — replay/idempotency assertion).
- `Makefile` (new — `silver-catalog` / `silver-run` / `silver-build` / `silver-verify`).
- Delete `db/dbt/models/staging/_empty_model.sql` (placeholder).

### T2 — @backend-developer (metric-engine Silver seam + analytics wrapper + BFF + isolation proof)
**Acceptance contract (REQUIRED pass-1):** Silver seam is the ONLY place Silver SQL is issued; predicate injected at the seam (not per-call); reads as `brain_analytics` SELECT-only; **isolation non-inert mutation test passes** (disabling the seam filter MUST leak → proves the guard works); order-status-mix is integer-only share math (no float); honest `no_data`; brand from session.
- `packages/metric-engine/src/silver-deps.ts` (new — `SilverDeps` + `withSilverBrand`).
- `packages/metric-engine/src/order-status-mix.ts` (new — `computeOrderStatusMix`).
- `packages/metric-engine/src/order-status-mix.test.ts` (new — unit).
- `packages/metric-engine/src/index.ts` (edit — add exports).
- `packages/metric-engine/package.json` (edit — add `mysql2`, resolve latest-stable 3.x).
- `apps/core/src/modules/analytics/internal/application/queries/get-order-status-mix.ts` (new — query wrapper).
- `apps/core/src/modules/analytics/index.ts` (edit — public export).
- `apps/core/src/modules/frontend-api/internal/bff.routes.ts` (edit — `GET /api/v1/analytics/order-status-mix` + `srPool` wiring + header note).
- core composition root (bootstrap that builds `rawPool`) (edit — build + inject `srPool` mysql2 pool to StarRocks as `brain_analytics`).
- `tools/isolation-fuzz/src/silver-order-state.test.ts` (new — positive + non-inert mutation negative-control on `silver.order_state`).

### T3 — @frontend-web-developer (order-status-mix UI)
**Acceptance contract (REQUIRED pass-1):** reads ONLY via the BFF endpoint (never StarRocks/SQL); honest empty + skeleton + error(request_id) states; money via `formatMoneyDisplay` (no `/100`/`parseFloat`); SyntheticBadge driven by BFF `data_source` (not hardcoded); chart has SR-table + `role=img` a11y; counts + share by lifecycle_state over a date range.
- `apps/web/app/(dashboard)/analytics/order-status/page.tsx` (new — shell).
- `apps/web/app/(dashboard)/analytics/order-status/order-status-content.tsx` (new — surface).
- `apps/web/components/analytics/order-status-mix-chart.tsx` (new — Recharts + a11y).
- `apps/web/lib/hooks/use-analytics.ts` (edit — `useOrderStatusMix`).
- `apps/web/lib/api/types.ts` (edit — `AnalyticsOrderStatusMixResponse`).
- `apps/web/e2e/analytics-order-status.spec.ts` (new — empty/has-data/a11y/badge).

---

## 9. Reversibility, cost, alternatives
- **Reversible:** `DROP CATALOG brain_oltp_pg` + drop the dbt models + drop the StarRocks mart removes the entire read path; no Postgres schema change to roll back; no new deployable to decommission.
- **Cost:** $0/mo incremental, 0 tokens/day (Tier-0 deterministic; dbt + SQL + TS only). StarRocks/Postgres already running.
- **Alternative considered + rejected:** Bronze→StarRocks sync job (§1) — rejected for adding a running process + drift surface. Iceberg catalog — rejected as gated on the Phase-3 Bronze-Iceberg flip.
- **Anti-blind check:** no per-connector fork (one mart folds all order sources via the ledger); no model call where deterministic SQL works; no offset pagination; isolation NOT assumed (explicit non-inert mutation proof); region via existing brand/currency, no new RegionAdapter need.

## 10. Self-check
- [x] No new deployable/topic/envelope (I-E05). [x] Additive only (no destructive migration; no Postgres migration at all). [x] dbt additive mart; non-additive math in metric-engine (ADR-004). [x] Money BIGINT minor + currency (I-S07). [x] I-ST01 sole read path (UI→BFF→engine seam→StarRocks; UI never queries StarRocks). [x] Replay-safe + reproducible-from-source. [x] Isolation proven non-inert (mutation test), platform boundary stated honestly. [x] Stakeholder-visible UI. [x] Single-Primitive clean. [x] Over-engineering: PASS (one mart, one seam, one route, one UI; no speculative marts).

---
**Sources (read-path verification):**
- [StarRocks JDBC catalog (PostgreSQL, v3.0+)](https://docs.starrocks.io/docs/data_source/catalog/jdbc_catalog/)
- [StarRocks CREATE EXTERNAL CATALOG](https://docs.starrocks.io/docs/sql-reference/sql-statements/Catalog/CREATE_EXTERNAL_CATALOG/)
