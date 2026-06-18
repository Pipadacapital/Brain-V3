# 14 — Retro: feat-silver-tier-order-state

| Field | Value |
|---|---|
| req_id | `feat-silver-tier-order-state` |
| Outcome | PASS (0 bounces at Stage 6) · Security PASS · QA BUILD-OK |
| Lane | high_stakes (data plane, multi_tenancy, money-adjacent, new read path, new external DB catalog) |

## What went well
- **The paradigm change was bound up-front, not discovered late.** The architecture (§4) recognized StarRocks `CREATE ROW POLICY` is enterprise-only and moved isolation to the app-seam (`withSilverBrand`) BEFORE building — so the isolation proof was designed-in, not retrofitted. The single-chokepoint `runScoped` sentinel-substitution makes the predicate unforgettable.
- **The non-inert mutation control is the standard the OS demands.** Disabling the seam predicate MUST leak brand-B; the test fails loud otherwise. No bypass-green, no inert probe. This matches the R1/M-01 lineage of falsifiable isolation proofs.
- **Dev-honesty maintained throughout.** Cross-brand JDBC ingest (superuser RLS bypass) is documented as the intended ETL-writer posture in three files; the synthetic `cod_*` source is labelled to the UI badge; the uuid→text read-shim is called out as dev/transition-only with a prod Iceberg swap path.
- **Over-engineering clean.** One mart, one seam, one route, one UI; the new metric is registered in the existing registry (Single-Primitive clean); deps real-pinned (`mysql2 ^3.22.5`).

## What to watch
- **App-layer isolation is the sole M1 enforcement on Silver.** The seam must remain the only Silver reader until prod row-policy graduation. A second, direct Silver reader would silently break the invariant — the I-ST01 sole-reader rule is load-bearing.
- **No real-port BFF wire-smoke this session.** The end-to-end path is proven by unit + isolation + type-checking, not an HTTP test. Add a wire-smoke next slice.
- **Makefile dbt path is dev-environment-sensitive.** Handled via `DBT=` override + `.dbt-venv` resolution; document the venv setup so CI/other devs don't hit a missing-dbt failure.

## Root cause / rule-proposal
None. Clean PASS, no recurring defect. The app-seam isolation model is a correct one-off response to an engine-capability boundary (enterprise-only row policy), not a repeated failure pattern — below the ≥3-distinct-prior-run auto-candidate threshold. No `rule-proposals/*` written; nothing appended to `pending-stakeholder-attention.md`.

## Follow-ups (tracked, not blocking)
1. Prod isolation graduation: apply `db/starrocks/row_policy_template.sql` on a managed StarRocks; the app-seam predicate becomes defense-in-depth.
2. Real-port BFF wire-smoke for `GET /api/v1/analytics/order-status-mix` (next slice).
3. dbt venv / absolute-dbt-path doc for CI parity.
4. The next Silver marts (settlement, shipment, marketing_spend, touchpoint) reuse this read-path + seam pattern — keep the seam the sole reader.
