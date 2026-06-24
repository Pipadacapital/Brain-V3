# Brain — Medallion Architecture & Data-Foundation Audit

**Date:** 2026-06-24 · **Scope:** every PostgreSQL schema, StarRocks (Silver/Gold), Iceberg Bronze,
Neo4j, Redis, migration, canonical entity, and data flow — audited against the stated Brain medallion
principles. **No storage changes were made in this audit** (per the directive to verify first).

**Method:** live inventory of the running stack (PG 13 schemas / ~90 tables, StarRocks brain_silver 24
+ brain_gold 12, Iceberg brain_bronze) + the governing ADRs (0002 Iceberg-Bronze, 0003 Postgres-
identity-SoR). Evidence (row counts) cited inline.

---

## Executive summary

The **ingestion edge and the Silver/Gold layers are medallion-correct**: the pixel flows
Redpanda → Iceberg Bronze (`collector_events`) → StarRocks Silver (`silver_touchpoint`, 24 marts) →
StarRocks Gold (12 marts) → metric-engine → dashboards. That spine is sound.

There are **three material deviations** from the stated principles, all **pre-dating this session's
attribution work** but two of which **my recent changes extended**:

| # | Deviation | Severity | Stated principle violated |
|---|---|---|---|
| A | **Attribution data lives in PostgreSQL** (`billing.attribution_credit_ledger`, 15,585 rows) — computed by a TS job, not a lakehouse transform | **HIGH** | "PostgreSQL must NOT store … attribution data" |
| B | **Commerce/revenue & marketing event ledgers live in PostgreSQL** (`realized_revenue_ledger` 1,804, `ad_spend_ledger` 80, `tax_ledger`) | **HIGH / nuanced** | "PostgreSQL must NOT store … commerce event history, marketing events, analytical datasets" |
| C | **Identity SoR is PostgreSQL, not Neo4j** (`identity.*`, 2,664 links) — Neo4j dual-write retired by ADR-0003 | **HIGH (conscious ADR)** | "Neo4j … Identity graph … customer identity resolution" |

A, B, C are **conscious, documented designs** (ADR-0002, ADR-0003, the H2 ledger-materialization
effort), each with real engineering reasons (append-only financial integrity, RLS tenant isolation,
deterministic-first, "no Neo4j reader exists"). They are **architecture-vs-stated-principle conflicts**,
not accidental drift. Per your directive (align implementation to architecture), the recommended
direction is to move computation into the medallion — but these are **re-platform-scale** changes that
should be sequenced deliberately, not ripped out under a running billing system.

**This session's net effect on the foundation:** the pixel/ingestion work **strengthened** Bronze-first
capture; the attribution work **deepened deviation A** (it added the `data_driven` model + `payment_method`
to the PG ledgers rather than computing attribution in Silver/Gold). Honest classification of my own
changes is in §6.

---

## 1. PostgreSQL — schema-by-schema classification

PG was schema-split (Phase A) into 13 schemas. Operational schemas are **Correct**; the analytical
ledgers are the hot zone.

| Schema | Verdict | Notes |
|---|---|---|
| `iam` (users, sessions, RBAC, invites) | ✅ Correct | Operational app state. |
| `tenancy` (org, brand, config, ref_*) | ✅ Correct | Operational. `brand_keyring` = KMS DEK refs (operational). |
| `connectors` (instance, cursor, sync_run, dlq, status) | ✅ Correct (mostly) | Connector config + sync state = operational. **Except** `connector_journey_stitch_map` + `connector_webhook_raw_archive` (below). |
| `consent` (record, tombstone) | ✅ Correct | Operational consent state. |
| `pixel` (installation, status) | ✅ Correct | Operational install config. |
| `jobs` (backfill_job) | ✅ Correct | Operational job state. |
| `ai_config` (recommendation, _action, _outcome, ai_provenance) | ◑ Partially Correct | The decision-loop *action* ledger (served/accepted/dismissed) is operational. The `recommendation` rows themselves are materialized analytical signals — arguably Gold. **MEDIUM.** |
| `audit` (audit_log, decision_log, send_log, identity_audit, dq_check_result, capi_*) | ◑ Partially Correct | `audit_log` (WORM hash-chain) = operational compliance ✅. `dq_check_result` / `decision_log` are analytical telemetry — `dq_check_result` already has an Iceberg path (DB-audit "DQ→Iceberg"); the PG copy is redundant. **LOW–MEDIUM.** |
| `ml` (model_registry, prediction_log) | ◑ Partially Correct | `model_registry` = operational ML config ✅. `prediction_log` (0 rows, partitioned) = analytical event history → belongs in the lakehouse. **MEDIUM.** |
| `data_plane` (collector_spool, 6,547 rows) | ◑ Partially Correct | A durable accept-before-validate **write-ahead buffer** drained to Redpanda — transient, not a SoR. Defensible as operational ingestion durability, but it *is* event data resident in PG before Kafka. **LOW.** |
| `identity` (customer, identity_link, merge_event, alias, contact_pii, …) | ⚠ Incorrect vs stated principle | Identity SoR in PG, not Neo4j (Deviation C / ADR-0003). `contact_pii` = raw PII vault (KMS-encrypted) — operational. **HIGH (conscious).** |
| `billing` (realized_revenue_ledger, attribution_credit_ledger, ad_spend_ledger, tax_ledger, invoice*, cost_input, gmv_meter_snapshot) | ⚠ Mixed | `invoice*`, `billing_plan`, `cost_input`, `*_number_counter` = operational billing ✅. The **ledgers** are Deviations A & B. **HIGH.** |
| `public` (dev_secret, pgmigrations) | ✅ Correct | Migration bookkeeping + dev-only secret. |

---

## 2. The hot-zone findings (detail)

### Finding A — `billing.attribution_credit_ledger` in PostgreSQL  ·  Incorrect / Misplaced · **HIGH**
- **Which layer owns this?** Gold (analytical) — possibly Silver (`silver_attribution` canonical entity).
- **Operational or analytical?** Purely **analytical** — attribution does not drive Brain's invoicing.
- **Evidence:** 15,585 rows in PG `billing`. Computed by `reconcileAttribution` /
  `reconcileDataDrivenAttribution` (TS jobs) → written to PG → materialized to Iceberg
  `brain_bronze.attribution_credit` → served from `brain_gold.gold_marketing_attribution`.
- **Root cause:** attribution is implemented as an **app-tier TS write-on-event** to a PG ledger,
  rather than as a **lakehouse transform** (dbt/Spark Silver→Gold) over `silver_touchpoint` + Silver
  orders. The serving half is medallion-correct; the **write-SoR being PG** is the drift. It also lands
  in a `brain_bronze.*` namespace, but it is *derived* data — Bronze should be raw only (Finding E).
- **Recommended correction:** compute attribution in **Silver/Gold** (a `silver_attribution_credit` /
  `gold_marketing_attribution` model, or a Spark job) reading Bronze touchpoints + Silver orders; drop
  the PG ledger as the SoR. The deterministic credit math (`@brain/metric-engine`) is pure and portable
  to a Spark/dbt-Python transform. **Large** — sequence after the ledger-Iceberg flip (Finding B) since
  attribution depends on recognized revenue.

### Finding B — Revenue / marketing / tax ledgers in PostgreSQL  ·  Partially Correct / Misplaced · **HIGH (nuanced)**
- **Tables:** `realized_revenue_ledger` (1,804), `ad_spend_ledger` (80), `tax_ledger`.
- **The nuance:** `realized_revenue_ledger` is **dual-purpose** — it is *also* the basis for Brain's
  **own billing** (GMV metering → `gmv_meter_snapshot` → `invoice`). That billing dependency is
  legitimately operational and transactional, which is the real reason it's in PG.
- **Operational or analytical?** Both. The billing read is operational; revenue/ROAS analytics is not.
- **Status:** ADR-0002 + the "H2" effort already **materialize these to Iceberg** and serve Gold from
  them (`gold_revenue_ledger`, `gold_marketing_attribution`), gated behind `ledger_source` (default
  `pg`; the `iceberg` flip is blocked by a dbt-starrocks incremental-CTAS bug). So the **migration is
  in progress**.
- **Root cause:** recognition + spend are computed in the **app tier** (measurement module, ad-spend
  mapper) and written to PG; the lakehouse gets a *copy*. This creates a **dual-source** (`ledger_source`
  pg vs iceberg) — a standing drift risk the parity oracle exists to police.
- **Recommended correction:** keep the **billing-critical** ledger operationally in PG **only** to the
  extent invoicing needs it; make the **lakehouse the analytical SoR** (finish the `ledger_source=iceberg`
  flip — fix/avoid the incremental-CTAS bug by making those marts `table`). Longer term, compute
  recognition as a Silver transform over Bronze order events. **Large; partially underway.**

### Finding C — Identity SoR is PostgreSQL, not Neo4j  ·  Incorrect vs stated principle / **conscious ADR** · **HIGH**
- **Evidence:** `identity.identity_link` (2,664), `customer`, `identity_merge_event`, `brain_id_alias`,
  `shared_utility_identifier`, `merge_review_queue`. ADR-0003 (Accepted 2026-06-22) **declares PG the
  identity SoR and retires the Neo4j dual-write** because it minted *divergent* brain_ids and **no reader
  reads Neo4j** (Customer 360, marts, attribution all read PG).
- **The conflict:** your stated foundation puts the identity graph in **Neo4j**. ADR-0003 consciously
  chose PG (deterministic-first, RLS isolation, append-only — all satisfied by PG; "a graph store earns
  its place only when a reader needs traversal — none exists").
- **This needs a product/architecture decision, not a silent code change.** Either (a) ratify PG as the
  identity SoR and **amend the stated foundation** (Neo4j → optional graph projection for future
  traversal use cases), or (b) commit to Neo4j as SoR, which requires building Neo4j readers + a
  deterministic-merge parity story. **Recommendation: ratify ADR-0003** — it is the better-reasoned
  position *today* (no Neo4j reader exists; PG gives hard tenant isolation the graph dual-write lacked).
  Flag for your explicit sign-off.

### Finding D — `connector_journey_stitch_map` (389) in PG `connectors`  ·  Misplaced · **MEDIUM**
- Journey↔order↔brain_id linkage = identity/journey data. The stitch *derivation* (the new
  `journey-stitch-from-identity` job) reads PG identity + writes this PG map, which `silver_touchpoint`
  then joins. **Root cause:** the stitch is an operational connector-lane artifact, but it is really a
  **Silver journey-linkage entity**. **Correction:** model the stitch as a Silver table derived in the
  lakehouse (anon↔order via the identity graph). Low blast radius; do it with Finding A.

### Finding E — Derived ledgers materialized into the **Bronze** namespace  ·  Misplaced (layer mislabel) · **MEDIUM**
- `attribution_credit_materialize.py` / `revenue_ledger_materialize.py` land **derived** PG ledgers into
  `brain_bronze.attribution_credit` / `…revenue_ledger`. **Bronze must be raw source payloads only** ("no
  transformations, no business logic"). A computed ledger is not Bronze. **Correction:** these belong in
  a Silver (or a `brain_lakehouse_silver`) namespace, not Bronze. Naming-level fix; do it with the
  `ledger_source=iceberg` flip.

### Finding F — Canonical entities are computed app-tier → PG; Silver reads the PG ledger, not Bronze  ·  Misplaced compute / **HIGH**  *(corrected — see note)*
- **Correction to a first-pass claim:** commerce data does **NOT** bypass Bronze. The architecture has
  dedicated **Bronze bridges** (`EventBronzeBridgeConsumer` / `bronzeBridges.ts`) that sink the raw
  connector/server topics — `order.live.v1`, `shopflo.checkout_abandoned.v1`, `gokwik.rto_predict.v1`,
  `gokwik.awb_status.v1`, `shiprocket.shipment_status.v1` — to Iceberg Bronze, alongside the pixel
  `collector_events`. Ingestion is medallion-correct. *(Local `brain_bronze` shows only
  `collector_events` because the connector bridges haven't run with data in this dev env — not an arch
  gap.)*
- **The actual deviation:** the **canonical recognition / revenue / attribution entities are computed in
  the app tier** (measurement module + attribution TS jobs) and written to **PG ledgers**, and the
  **Silver marts then read those PG ledgers via the JDBC shim** — `stg_order_ledger_events` reads
  `source('oltp', 'realized_revenue_ledger')`; the attribution Gold reads `source('oltp',
  'attribution_credit_ledger')` under `ledger_source=pg`. So the raw commerce events sit in Bronze
  **unused for the canonical build**, while Silver/Gold are reconstructed from app-computed PG state.
- **Violates:** "Silver is where Brain's canonical model lives … normalization, enrichment, entity
  resolution" — the canonical recognition/attribution logic lives in the **app tier**, not Silver, and
  PG is the compute-SoR.
- **Root cause + keystone:** business-entity computation was built **application-first** (deterministic
  TS + transactional PG) before the lakehouse existed; the lakehouse was then bolted on as a *copy*
  (materialize PG → Iceberg → Gold) rather than the canonical builder. This is the structural root of
  Findings A, B, D.
- **Correction:** build the canonical Silver entities (order recognition, attribution) **from the Bronze
  commerce events that already exist** (dbt/Spark Silver transforms), and make Silver/Gold read Bronze —
  not the PG ledger. The PG ledger then shrinks to the operational billing slice. **Large; the keystone.**

### Minor — StarRocks `*__dbt_backup` tables  ·  Cleanup · **LOW**
- `gold_customer_360__dbt_backup`, `gold_revenue_ledger__dbt_backup`, `snap_*__dbt_backup`,
  `silver_*__dbt_backup` are dbt full-refresh leftovers. Harmless cruft; drop on next maintenance.

---

## 3. What IS medallion-correct (do not touch)

- **Pixel ingestion:** Redpanda → Iceberg Bronze `collector_events` → Silver `silver_touchpoint` → Gold.
  ✅ The session's pixel/WooCommerce work strengthened this.
- **StarRocks Silver (24) + Gold (12):** canonical/normalized in Silver, analytical products in Gold. ✅
- **Gold serving:** metric-engine reads Gold via `withSilverBrand`; dashboards read the BFF. ✅
- **Redis:** sessions, OAuth, feature online-store, rate limits — operational/cache, never SoR. ✅
- **`audit.audit_log`:** WORM hash-chain compliance state — operational. ✅

---

## 4. The 10 validation questions — applied to the contested items

| Q | attribution_credit_ledger (PG) | realized_revenue_ledger (PG) | identity.* (PG) |
|---|---|---|---|
| 1 Which layer owns it? | Silver/Gold | Silver/Gold (+ operational billing slice) | Identity (Neo4j per stated arch; PG per ADR-0003) |
| 2 Operational or analytical? | Analytical | Both | Identity/operational |
| 3 Canonical model? | Yes (attribution entity) | Yes (revenue entity) | Yes (identity entity) |
| 4 Source or business data? | Business (derived) | Business (derived) | Business |
| 5 Violates medallion? | **Yes** | Partially | Conflicts with stated arch |
| 6 Bypasses Bronze? | No — raw events ARE in Bronze; but Silver reads the PG ledger, not Bronze (Finding F) | Same — raw order events in Bronze; Silver reads PG ledger | n/a |
| 7 Duplicates data elsewhere? | Yes (PG + Iceberg + Gold) | Yes (PG + Iceberg + Gold) | No |
| 8 Another source of truth? | **Yes (PG write-SoR)** | **Yes (PG write-SoR)** | Yes (PG, by ADR) |
| 9 Architectural drift? | Yes | Partially (migration underway) | Conscious decision |
| 10 Strengthens/weakens foundation? | Weakens | Mixed | Conscious trade-off |

---

## 5. Recommended correction program (aligned to architecture, sequenced)

The keystone is **Finding F** — commerce data is *already* in Bronze; the work is to make Silver build
the canonical entities **from that Bronze** instead of from the PG ledger:

1. **F (keystone):** point the Silver canonical builds at the **Bronze commerce events** (which the
   bridges already land) instead of `source('oltp', …)` PG-ledger reads; move recognition into a Silver
   transform. (No new Bronze sink needed — the bridges exist.)
2. **B:** build Silver order/payment/shipment/recognition entities **from Bronze**; finish the
   `ledger_source=iceberg` flip so Gold reads the lakehouse; reduce the PG ledger to the operational
   billing slice invoicing actually needs.
3. **A + D:** recompute attribution + the journey stitch as **Silver/Gold transforms** over Bronze
   touchpoints + Silver orders (the metric-engine math is pure + portable); retire the PG attribution
   ledger and the PG stitch map as SoRs.
4. **E:** move the materialized ledgers out of the `brain_bronze` namespace into Silver (naming).
5. **C:** **get explicit sign-off** — ratify ADR-0003 (PG identity SoR; Neo4j = future graph projection)
   *or* commit to Neo4j. Recommend ratify + amend the stated foundation.
6. **Cleanup:** `ml.prediction_log` → lakehouse; redundant `dq_check_result` PG copy; drop `*__dbt_backup`.

**Do NOT** rip out the PG revenue ledger under the live billing/invoicing path without (1)+(2) landing
first — that would break GMV metering. These are reversible, sequenced migrations, not a big-bang.

---

## 6. Honest self-audit — this session's changes

| Change | Verdict |
|---|---|
| Pixel.js (multi-storefront, identity bridge, rage/dead clicks, etc.) | ✅ Correct — strengthens Bronze-first capture |
| WooCommerce installer / PixelInstaller registry | ✅ Correct — ingestion edge |
| `journey-stitch-from-identity` job | ◑ Extends Finding D (PG stitch map) — correct *given* the current design; the lakehouse-native version is the target |
| `data_driven` Markov model + `reconcileDataDrivenAttribution` | ⚠ Extends Finding A — wrote more to the PG attribution ledger. The **math** is pure/portable (good); the **placement** (PG write-SoR) inherits the deviation |
| Migration 0096 (model_id CHECK), 0097 (payment_method) | ⚠ Modify the PG ledgers (Findings A/B). Additive to an already-deviating structure; `payment_method` is correct data, wrong layer long-term |
| `gold_marketing_attribution` refresh, dbt-runner image, Argo crons | ✅ Correct — Gold serving + lakehouse tooling |
| Finalization COD/payment_method fixes | ✅ Correctness wins; same PG-ledger placement caveat as B |

**Net:** no NEW source of truth was introduced; the work extended existing PG-resident ledgers (a
pre-existing pattern) and meaningfully strengthened the pixel/Bronze edge. The attribution math is
written to be **portable** to a lakehouse transform when Findings A/F are addressed.

---

## Bottom line

The **spine is correct** — and, corrected on verification, **connector/commerce data DOES land in
Bronze** (dedicated bridges). The real deviation is that the **canonical attribution/revenue/recognition
entities are computed in the app tier and parked in PostgreSQL, and Silver/Gold read those PG ledgers
instead of building the canonical entity from the Bronze that already exists** (Finding F). Two of the
three big deviations are conscious ADRs (0002 in-progress, 0003 needs your ratification). The correction
is a sequenced re-platform (F → B → A/D → E) that repoints Silver at Bronze — not a redesign — and must
not disturb the live billing path until the lakehouse SoR is proven at parity.
