# Requirement: Silver tier foundation — first Bronze→Silver mart (silver.order_state) + order-status-mix UI

| Field | Value |
|-------|-------|
| **req_id** | `feat-silver-tier-order-state` |
| **Title** | Stand up the Silver analytics tier (dbt → StarRocks): the first canonical Silver mart `silver.order_state` from the existing order/commerce truth + a stakeholder-visible order-status-mix surface read via the metric-engine |
| **Submitted by** | rishabhporwal |
| **Submitted at** | 2026-06-18 |
| **Lane** | high_stakes (data plane, multi_tenancy, money-adjacent) |
| **Roadmap** | D14 Phase 4 gating sub-track — lands the Silver tier (the single largest unbuilt foundation; unblocks Phases 4–8). See docs/data-collection-platform/13-security-privacy-and-roadmap.md |

## Why now
Phases 1–3 (collection, commerce-truth ledger, identity) are shipped; Phases 4–8 (journey →
attribution → feedback → DQ → decision-intelligence) are ALL gated on the Silver analytics tier
(StarRocks + dbt) landing. This is that foundation's smallest valuable slice: the first real
Bronze/source → Silver pipeline through dbt into StarRocks, plus a visible analytics surface that
reads from Silver — proving the path end-to-end.

## Current state (verified)
- StarRocks is UP (brainv3-starrocks-1, healthy) at :9030; schema `brain_silver` per the dbt profile.
- dbt scaffold exists but is EMPTY: `db/dbt/dbt_project.yml` (layering: staging=view → intermediate=view
  → marts=table; **dbt does ADDITIVE marts only — all non-additive math lives in packages/metric-engine,
  ADR-004**), `db/dbt/profiles/profiles.yml` (dbt-starrocks adapter, default_catalog), one placeholder
  `models/staging/_empty_model.sql`. No real models, no Silver tables yet.
- Bronze today = Postgres `bronze_events` (0016); order/commerce truth lives in Postgres
  (realized_revenue_ledger + the connector order maps). **There is no StarRocks↔Postgres bridge yet** —
  binding it is the key architecture decision.

## Deliverables (smallest valuable slice)
1. **The Bronze/source → StarRocks read path (architect binds the mechanism):** establish how dbt (running
   against StarRocks) reads the canonical order truth that lives in Postgres — e.g. a StarRocks **external
   JDBC catalog** over Postgres, or a Bronze→StarRocks materialization. Pick the smallest reversible option;
   be dev-honest about any boundary (if a real external catalog/Iceberg path is a platform follow-up, prove
   the slice with the chosen dev mechanism and say so).
2. **dbt models (staging → intermediate → marts), per the project layering:**
   - staging: 1:1 read of the order source + dedup on the natural key (view).
   - intermediate: normalize to the canonical order shape (view).
   - mart: **`silver.order_state`** — the canonical order lifecycle (placed→confirmed→shipped→delivered/
     cancelled/RTO), upsert/latest-state per `order_id`, brand-scoped, money in BIGINT minor + currency_code.
     ADDITIVE mart only (no non-additive aggregation — that stays in metric-engine).
3. **A repeatable run path:** `dbt run` wired into the repo (Makefile/script or a stream-worker/Argo trigger
   stub) so the mart is reproducible from source (replay-safe). No new deployable (I-E05).
4. **Per-brand isolation on the Silver read path:** Silver tables carry `brand_id`; reads are tenant-scoped
   (StarRocks row policy or a brand-filtered read seam), verified non-inert. The Analytics-API/metric-engine
   stays the sole read path (I-ST01) — the UI never queries StarRocks directly.
5. **Stakeholder-visible UI (MANDATORY):** an **order-status-mix / fulfillment-funnel** analytics panel
   (counts + share by lifecycle state, by date range) computed in the **metric-engine reading `silver.order_state`**
   (the new Silver read seam) — proving Silver→metric-engine→BFF→UI end-to-end. Honest empty state. Reuse
   the analytics UI (shadcn/Recharts/KpiTile).

## Constraints
- **No new deployable / topic / envelope.** Additive migrations only. dbt marts are additive; non-additive
  math in metric-engine (ADR-004). The four deployables + Argo are fixed (I-E05).
- Per-brand isolation (verify under brain_app — the dev superuser `brain` bypasses Postgres RLS; the StarRocks
  side needs its own brand-scoping proof). Money BIGINT minor units + currency_code (I-S07). Replay-safe:
  re-running dbt produces the same Silver state (idempotent), reproducible from source.
- Dev-honesty: StarRocks external-catalog/Iceberg specifics may be a platform boundary — prove the slice with
  the chosen dev mechanism and document the boundary (as the connectors did). Never fake "Silver is live."

## Non-goals (follow-on)
- Other Silver marts (settlement, shipment, marketing_spend, touchpoint) — order_state first.
- silver.touchpoint / journey (Phase 4 proper) — this slice is the enabling Silver sub-track.
- Iceberg Bronze migration + 24-mo TTL (gated, separate). Full StarRocks prod profile/HA.

## Build tracks (the architect will bind)
@data-engineer (the StarRocks read path + the dbt staging/intermediate/mart models + silver.order_state +
the run wiring + replay/idempotency) ∥ @backend-developer (the metric-engine Silver read seam over
silver.order_state + the BFF query, tenant-scoped) ∥ @frontend-web-developer (the order-status-mix UI).
Verify per-brand isolation on the Silver path + dbt-run reproducibility. Reuse the analytics UI + metric-engine.
