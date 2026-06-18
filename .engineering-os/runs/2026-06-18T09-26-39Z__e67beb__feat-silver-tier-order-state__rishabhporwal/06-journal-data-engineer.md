## 2026-06-18T10:55Z — Data Engineer — feat-silver-tier-order-state (T1)
**Stage:** 3 · **Layer:** lakehouse/batch (dbt → StarRocks Silver) · **Tier:** deterministic (Tier-0, $0/mo, 0 tokens)
**Parity:** N/A for this slice — silver_order_state is the additive latest-state mart; non-additive status-mix is owned by metric-engine (T2). dbt produced ZERO non-additive aggregation (ADR-004 honored).
**Replayable:** YES — `make silver-verify` ran dbt twice; content fingerprint `-131378074397` / 10933 rows identical across runs (reproducible-from-source).

### What landed (T1)
- **Read path:** StarRocks JDBC external catalog `brain_oltp_pg` → Postgres (`db/starrocks/oltp_jdbc_catalog.sql`). Verified reading the live ledger cross-catalog. DEV BOUNDARY documented in-file (connects as superuser `brain` → RLS-bypass → cross-brand ETL read by design; prod swaps to Iceberg Bronze catalog, boundary isolated in `_sources.yml`).
- **Read-shim (honest dev boundary discovered at build):** StarRocks JDBC catalog CANNOT read Postgres `uuid` columns (`brand_id`/`brain_id` surface as UNKNOWN_TYPE; any SELECT errors). Fix = additive, reversible Postgres view `silver_order_ledger_src` casting uuid→text (`db/starrocks/oltp_pg_read_shim.sql`, `CREATE OR REPLACE VIEW`, no migration consumed). dbt source points at the view. Prod (Iceberg, native strings) drops the shim.
- **dbt models:** `staging/_sources.yml`, `staging/stg_order_ledger_events.sql` (view; 1:1 + dedup on the 0018 natural key), `intermediate/int_order_lifecycle.sql` (view; event_type→lifecycle_state + deterministic rank + is_terminal), `marts/silver_order_state.sql` (StarRocks PRIMARY KEY table, 1 row per (brand_id, order_id), terminal-wins/latest-economic-effective fold). Deleted `_empty_model.sql`.
- **Run wiring:** root `Makefile` — `silver-catalog` / `silver-run` / `silver-build` / `silver-verify`. No new deployable/topic/envelope (I-E05).

### Verification (real, against live StarRocks)
- `make silver-build`: 3 models built, mart = **10933 rows** (2 brands: 10028 + 905).
- Grain: 10933 rows = 10933 distinct (brand_id,order_id) — one row per order. ✅
- Fold: confirmed 9740 / placed 1095 (value 0, D-3) / rto 98 (terminal, negative value). is_terminal consistent. ✅
- DDL: `PRIMARY KEY(brand_id, order_id)`, DISTRIBUTED/ORDER BY brand-first, `order_value_minor BIGINT`, `currency_code VARCHAR(3)` — I-S07 met (dbt money-type assertion PASS). ✅
- **dbt test: PASS=10/10** (not_null, accepted_values, grain, money-bigint, fold-consistency).
- **Replay:** fingerprint identical across two runs → idempotent. ✅
- **Isolation non-inert (data-side proof):** brand-A predicate → 10028 A-rows, **0 B-rows**; negative control (predicate disabled) → leaks 905 B-rows ⇒ the predicate is doing the work (non-inert). `brain_analytics` user reads the mart, INSERT denied (SELECT-only read posture). NOTE: StarRocks `CREATE ROW POLICY` is enterprise-only / unsupported in the dev allin1 image (per bootstrap.sql) — engine-level row policy is the prod graduation; M1 enforcement is the metric-engine brand-filtered read seam (T2 owns that seam + its mutation test).

### Dev-boundary honesty
- dbt + StarRocks client are NOT on the host; ran via a local `.dbt-venv` (dbt-starrocks 1.12, gitignored) and `docker exec` mysql. Makefile auto-detects the venv; CI/prod use PATH `dbt`.
- The Postgres uuid→text read-shim is a real, documented dev boundary (not a fake) — it disappears under the prod Iceberg path.

**Next:** READY-FOR-SECURITY (T1 data plane). T2 (metric-engine Silver seam + isolation mutation test) ∥ T3 (UI) consume `brain_silver.silver_order_state`.
