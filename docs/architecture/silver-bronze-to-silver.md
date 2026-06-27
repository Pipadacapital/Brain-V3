# Bronze → Silver: the Two-Stage Silver architecture

> Status: architecture spec + honest coverage map (Brain V4). This document describes the **logical**
> two-stage shape of the Spark Bronze→Silver layer and maps every spec step to the **actual** code in
> the repo. It does **not** rebuild the ~40 `silver_*.py` jobs — those already do canonical mapping,
> event standardization, dedup, PII-hash and money-minor. The scope formalized here is the *explicit*
> Stage-1 Technical-Processing layer, the unified quarantine model, and the business-validation seam.
>
> Honesty contract: every row in the coverage tables is marked **BUILT** (exists today, grep-confirmed),
> **EXTENDED-THIS-WAVE** (formalized/consolidated in this wave), or **DEFERRED** (named, designed, not yet
> implemented). dbt is **REMOVED**; Spark is the sole compute. Iceberg is the system of record.

---

## 1. The two logical Spark stages

Bronze→Silver is one physical Spark pipeline (`db/iceberg/spark/silver/*.py`) but **two logical stages**.
The split is logical, not a new set of tables: most jobs fold both stages inline, sharing the Stage-1
primitives from `_raw_normalize.py` + `_silver_base.py`. The value of naming the stages is that Stage 1 is
**connector-agnostic and reusable**, and everything downstream of Silver (identity resolution, journey
reconstruction, attribution, decision intelligence) consumes **only** Stage-2 canonical entities — never a
half-validated raw row.

```
  Iceberg Bronze (SoR, raw)                     Iceberg Silver (canonical, business truth)
  ┌───────────────────────┐                     ┌──────────────────────────────────────────┐
  │ brain_bronze.          │   STAGE 1          │ STAGE 2                                    │
  │  collector_events_raw  │   Technical        │ Business Canonicalization                  │
  │  (+ provider raw rows) │   Processing       │                                            │
  │                        │                    │  canonical mapping ─┐                      │
  │  raw envelope/payload  │──▶ schema validate  │  event standardize  ├─▶ canonical ENTITY  │
  │  truly raw, server-    │   schema evolve     │  sessionization      │   tables:           │
  │  trusted brand_id      │   string clean      │  business validate   │   silver_customer   │
  │                        │   DQ + QUARANTINE   │  entity generation   │   silver_order_state│
  │  ▲ originals RETAINED  │   dedup (PK)        │                      │   silver_product …  │
  │  │ (replay source)     │   PII normalize     │   TRUSTED rows ─────▶ │   (the ~40 jobs)    │
  │  └─────────────────────┘   event ordering    └──────────────────────────────────────────┘
  │                            ───────────────▶                              │
  │                            "TRUSTED rows"                                 ▼
  └──────────────────────────────────────────────────────▶ silver_quarantine (stage=schema|dq|business)
```

### Stage 1 — Technical Processing → *TRUSTED rows*

Purely structural / source-shaped concerns. Takes raw Bronze (the truly-raw collector envelope plus the
per-provider raw payloads) and produces rows that are **structurally valid, deduplicated, PII-safe and
ordered** — but still source-shaped. Steps: **schema validation, schema evolution, non-PII string
cleaning, data-quality checks, quarantine, deduplication, PII normalization (hash-only), event ordering.**

Stage 1 is the **reusable** layer. The same primitives gate every connector, so a new connector only has
to supply its field map — it inherits validation, quarantine, dedup and PII-hashing for free.

Today these primitives live in:
- `db/iceberg/spark/silver/_raw_normalize.py` — the golden-vector-verified pure ports (money→minor with
  throw→quarantine, payment classification, `hash_identifier`/`hash_salted_bytes`, `normalize_email`/
  `normalize_phone_in`, `uuid_shaped`/`event_id_order_live`, `iso_ms`, status→terminal_class).
- `db/iceberg/spark/silver/_silver_base.py` — `read_bronze_events`, `prop`, `merge_on_pk` (in-batch dedup
  window then Iceberg MERGE on PK), `ensure_silver_table`, `run_job`.
- `db/iceberg/spark/silver/silver_collector_event.py` — the admission gate (R2 tenant resolve / R3 consent
  / lane split / malformed-drop / dedup) lifted from the Bronze sink into Silver.

### Stage 2 — Business Canonicalization → *Brain canonical entities*

Semantic / business concerns. Takes TRUSTED rows and produces **Brain canonical entities** — one row per
business object, with money as bigint minor units + sibling `currency_code`, identity keyed by the opaque
`brain_id`/`brain_anon_id`, and `brand_id` first. Steps: **canonical field mapping, event
standardization, sessionization, business validation, canonical entity generation.**

Stage 2 is the **~40 `silver_*.py` entity + per-connector normalizer jobs** — already built, parity-exact
against the retired dbt marts.

### Why the split

1. **Reuse across connectors.** Schema-validation, cleaning, dedup, quarantine and PII-hashing are
   identical for Shopify, WooCommerce, GA4, Razorpay, Shiprocket, GoKwik, Shopflo and ad-spend. Naming
   them as one Stage-1 layer means each connector job collapses to its field map; the technical guarantees
   are shared, not re-implemented (and re-bugged) per connector.
2. **Downstream consumes only validated canonical entities.** Identity resolution and journey/attribution
   read Stage-2 tables only. A malformed money string, an unconsented pixel hit, or a duplicate webhook is
   resolved in Stage 1 (dropped → quarantine) before any business logic sees it — so "no event loss /
   no blended money / confidence-before-decisions" are enforced at the boundary, once.
3. **Quarantine is a first-class outcome, not a crash.** A Stage-1 reject is routed to `silver_quarantine`
   with its stage, not silently dropped and not allowed to abort the batch. Bronze retains the original, so
   any reject is replayable after a fix.

---

## 2. Coverage map — 13 spec steps → actual implementation

Each step lists the concrete repo location(s) and an honest status. Paths are real and grep-confirmed.

### Stage 1 — Technical Processing

| # | Spec step | Implementation (real paths) | Status |
|---|-----------|------------------------------|--------|
| 1 | **Schema validation** | Envelope contract: `silver_collector_event.py` `COLUMNS_SQL` (event_id/brand_id/occurred_at/schema_name/schema_version NOT NULL) + malformed-drop `where(event_id & brand_id & occurred_at isNotNull)`. Per-field/value validation: the regex-guarded ports in `_raw_normalize.py` (`_DECIMAL_RE`, `_INT_RE`, `_MONEY_STRICT2_RE`, `_MAJOR_DECIMAL_RE`). | **BUILT** (distributed). Explicit unified validator + per-event-type schema registry: **DEFERRED** (proposed `_silver_technical.py::validate_envelope`). |
| 2 | **Schema evolution** | Iceberg-native column add/widen via `iceberg_base.create_iceberg_table` / `_silver_base.ensure_silver_table`. Forward-compatible envelope reconstruction `to_json(struct(*raw.columns))` in `silver_collector_event.py` tolerates new Bronze columns; `schema_version` rides every row. | **BUILT** (Iceberg-native + version-carried). |
| 3 | **Non-PII string cleaning** | `_raw_normalize.py`: `normalize_status` (lower + collapse `[_-]`/whitespace), `normalize_email` (trim+lower), trim/lower inside `hash_*`, `iso_ms`/`iso_ms_assume_utc` time canonicalization. Applied per-field in the connector normalizers. | **BUILT** for known fields. Generic whitespace/control-char sweep across all string cols: **DEFERRED** (`_silver_technical.py::clean_string`). |
| 4 | **Data-quality checks** | Money DQ at the port: `decimal_to_minor_strict`/`paisa_to_minor_string`/`micros_to_minor`/`major_decimal_to_minor` return `None` (never a float, never blended) on malformed → the job's `where`-gate excludes the row. `money_to_minor_string` raises → build wrapper catches. | **BUILT** (port-level, money). Explicit multi-rule DQ engine (null-rate, range, referential): **EXTENDED-THIS-WAVE** as the `silver_quarantine` reason taxonomy; rule-set **DEFERRED**. |
| 5 | **Quarantine** | Today: where-gate **DROP** (e.g. `silver_collector_event.py` R2/R3/malformed drops; money-`None` `where`-gate in `silver_razorpay_normalize.py`, `silver_ad_spend_normalize.py`, `silver_gokwik_normalize.py`, `silver_ga4_normalize.py`, `silver_shopflo_normalize.py`). No reject **table** yet. | **DEFERRED** → unified `silver_quarantine` (`stage = schema\|dq\|business`); see §4. Drops are correct on admission but currently unobservable/non-replayable as a set. |
| 6 | **Deduplication** | `_silver_base.merge_on_pk` (row_number window over PK, latest-by-`order_by_desc` then Iceberg MERGE). `silver_collector_event.py` dedup window on `(brand_id, event_id)`. Every entity job MERGEs on its PK (idempotent / replay-safe). | **BUILT**. |
| 7 | **PII normalization (hash-only)** | `_raw_normalize.py`: `normalize_email`, `normalize_phone_in` (+91 E.164), `hash_identifier` (`sha256(salt‖'\|\|'‖normalized)`), `hash_salted_bytes` (hex-salt, no separator). Raw PII never reaches Silver — connector mappers drop it pre-Bronze; entities are keyed by `brain_id`/hashes only. | **BUILT**. |
| 8 | **Event ordering** | Per-PK latest-wins via `merge_on_pk(order_by_desc=[ingested_at …])`. Deterministic, replay-stable `event_id` (`event_id_order_live`/`uuid_shaped`), canonical `occurred_at` (`iso_ms`). Sequence ordering: `session_seq` running-sum + `session_key` in `silver_touchpoint.py`. | **BUILT** (PK latest-wins + deterministic ids + sessionized sequence). Cross-entity global watermark ordering: partial. |

### Stage 2 — Business Canonicalization

| # | Spec step | Implementation (real paths) | Status |
|---|-----------|------------------------------|--------|
| 9 | **Canonical field mapping** | Per-connector normalizers: `silver_shopify_order_normalize.py`, `silver_woocommerce_normalize.py`, `silver_ga4_normalize.py`, `silver_razorpay_normalize.py`, `silver_shiprocket_normalize.py`, `silver_gokwik_normalize.py`, `silver_shopflo_normalize.py`, `silver_ad_spend_normalize.py` — each maps a raw provider payload onto the canonical column set using the shared ports. Multi-source unification verified: Shopify + Woo emit identical canonical order rows. | **BUILT**. |
| 10 | **Event standardization** | Canonical event names + lane policy (`SERVER_TRUSTED`/`LEDGER_ONLY`) in `silver_collector_event.py`; `classify_payment` (cod/prepaid), `classify_terminal_class` (rto/delivered/other/none, frozen authority shared with `packages/logistics-status`). | **BUILT**. |
| 11 | **Sessionization** | `silver_touchpoint.py` — 30-min-inactivity sessionization, server-re-derived + replay-stable, `session_key = murmur_hash3_32(brand_id\|brain_anon_id\|session_seq)`. `silver_sessions.py` rolls per-touch → one row per `(brand_id, brain_anon_id, session_key)`. | **BUILT**. |
| 12 | **Business validation** | Today implicit inside entity jobs: `silver_customer.py` excludes `brain_id IS NULL` (not-yet-a-known-customer) and `lifecycle_state <> 'merged'`; finalization/COD-eligibility rules live in the revenue/journey jobs. | **EXTENDED-THIS-WAVE** as a named seam (business rejects → `silver_quarantine` `stage=business`). Centralized business-rule module: **DEFERRED**. |
| 13 | **Canonical entity generation** | The entity jobs (§3): `silver_customer.py`, `silver_order_state.py`/`silver_order_line.py`, `silver_product.py`/`silver_product_variant.py`, `silver_payment.py`/`silver_settlement.py`/`silver_refund.py`/`silver_dispute.py`, `silver_campaign.py`/`silver_ad_account.py`/`silver_marketing_spend.py`, `silver_sessions.py`/`silver_touchpoint.py`, plus event-grain marts. brand_id-first, money bigint-minor + `currency_code`, MERGE-on-PK idempotent. | **BUILT**. |

**Summary:** of the 13 steps, **9 are BUILT** today (1–3 partial-but-functional, 6, 7, 8, 9, 10, 11, 13),
**2 are EXTENDED-THIS-WAVE as named seams** (4 DQ taxonomy, 12 business-validation seam), and the
**explicit unified pieces are DEFERRED**: the consolidated `_silver_technical.py` validator/cleaner
(steps 1/3) and the `silver_quarantine` table (step 5). No spec step is unaddressed — every reject is at
minimum correctly dropped on admission today; the DEFERRED work makes those rejects *observable,
classified, and replayable*.

---

## 3. Canonical entities → owning job

Seven canonical entity families. Each is owned by one primary `silver_*.py`, with sibling jobs for
sub-grains.

| Canonical entity | Owning job | Sibling / sub-grain jobs | PK / grain |
|------------------|-----------|--------------------------|------------|
| **Customer** | `silver_customer.py` | `silver_customer_identity.py`, `silver_identity_alias.py` | `(brand_id, brain_id)` |
| **Order** | `silver_order_state.py` | `silver_order_line.py`, `silver_fulfillment.py`, `silver_shipment.py`/`silver_shipment_event.py`, `silver_cod_rto.py`, `silver_checkout_signal.py` | `(brand_id, order_id)` |
| **Product** | `silver_product.py` | `silver_product_variant.py`, `silver_inventory_level.py` | `(brand_id, product_id)` |
| **Session** | `silver_sessions.py` | `silver_touchpoint.py`, `silver_journey.py` | `(brand_id, brain_anon_id, session_key)` |
| **Payment** | `silver_payment.py` | `silver_settlement.py`, `silver_refund.py`, `silver_dispute.py` | `(brand_id, payment id / settlement key)` |
| **Campaign** | `silver_campaign.py` | `silver_ad_account.py`, `silver_marketing_spend.py` | `(brand_id, campaign_id)` |
| **Event** | `silver_collector_event.py` | `silver_page_view.py`, `silver_cart_event.py`, `silver_engagement_signal.py`, `silver_form_submission.py`, `silver_search.py`, `silver_message_send.py` | `(brand_id, event_id)` |

(Identity is not a separate canonical *entity* table here — it is resolved in Neo4j [ADR-0004] and exported
into `silver_customer_identity` / `silver_identity_alias`, which the Customer entity folds in.)

---

## 4. Quarantine model (`silver_quarantine`) — DEFERRED, designed

**Goal:** make Stage-1/Stage-2 rejects observable, classified, and replayable — replacing today's silent
`where`-gate drops, *without* re-admitting bad data into the canonical entities.

**Table:** `brain_silver.silver_quarantine` (Iceberg), brand_id-first, append-only.

| column | meaning |
|--------|---------|
| `brand_id` | tenant key, first column / partition (`bucket(N, brand_id)`) |
| `stage` | reject stage enum: `schema` (Stage-1 structural), `dq` (Stage-1 value/quality), `business` (Stage-2 rule) |
| `source` | which job emitted it (e.g. `silver_collector_event`, `silver_razorpay_normalize`) |
| `bronze_event_id` | pointer back to the **retained** Bronze original (the replay handle) |
| `reason` | machine token (e.g. `money_malformed`, `tenant_unresolved`, `brand_mismatch`, `consent_absent`, `schema_missing_field`, `brain_id_null`) |
| `raw_excerpt` | minimal non-PII payload excerpt for triage (never raw email/phone) |
| `occurred_at` / `quarantined_at` | event time / reject time |

**Invariants:**
1. **Bronze retains originals.** The truly-raw `brain_bronze.collector_events_raw` (+ provider raw rows) is
   the SoR and is never mutated. Quarantine stores a *pointer + reason*, not a second copy of truth.
2. **Replayable.** Fix the mapper/rule, re-run the silver job — the previously-quarantined Bronze rows are
   re-evaluated; on success they MERGE into the canonical entity (idempotent on PK), and the quarantine row
   becomes a historical record. No event loss.
3. **Stage-classified.** `stage` tells an operator whether the fix is structural (Stage 1) or semantic
   (Stage 2), and whether it is safe to re-admit.
4. **Never blended / never crashes the batch.** A money-parse `None` or a thrown `ValueError` routes to
   quarantine (`stage=dq`) instead of coercing a float or aborting the run — the existing port semantics,
   now *recorded* instead of dropped.

**Wiring (proposed `_silver_technical.py`):** a shared `quarantine(df_rejects, stage, reason, source)`
helper that every job calls on its reject branch, mirroring how `_silver_base.merge_on_pk` is the shared
MERGE. The where-gates that currently `DROP` become `split → (admit | quarantine)`.

---

## 5. Tests — pure golden-vector parity (no Spark)

Every Stage-1 port is provable without a Spark cluster, because the ports are **pure Python**. The pattern
to mirror for any new `_silver_technical.py` port is `db/iceberg/spark/silver/_p4_golden/`:

- Golden vectors captured from the real TypeScript (`*-golden.json`, generated by `gen-*.ts`).
- A pure assertion test per connector (`test_shopify_golden.py`, `test_woocommerce-golden.py`,
  `test_ga4-golden.py`, `test_razorpay-golden.py`, `test_shiprocket-golden.py`, `test_gokwik-golden.py`,
  `test_shopflo-golden.py`, `test_ad-spend-golden.py`) importing directly from `_raw_normalize.py`.
- Run: `python3 -m pytest db/iceberg/spark/silver/_p4_golden/ -q`.

Any new technical port (validator, cleaner, quarantine-reason classifier) ships its own pure golden-vector
test in this directory — no Spark needed to prove byte-exactness.

---

## 6. Orchestration & enforcement

- **Refresh order** (`tools/dev/v4-refresh-loop.sh`): identity-export → `silver_order_state` (spine,
  resolves `brain_id`) → rest of Silver (incl. initial `silver_touchpoint`) → `gold_revenue_ledger` +
  mv views → journey-stitch → `silver_touchpoint` rebuild → rest of Gold. `pnpm dev:v4-refresh`.
- **Naming/architecture invariants** are CI-enforced by `tools/lint/v4-naming-guard.sh` (blocking gate in
  `.github/workflows/pr.yml`): no retired `brain_gold.`/`brain_silver.` DB refs, no `dbt`, no feature
  precompute, Gold/Silver reads only via `mv_*` / rest-Iceberg.
- **dbt is REMOVED.** Every job above is a Spark reimplementation; the parity baselines it was verified
  against are the now-retired dbt marts (see `docs/architecture/v4/parity-report.md`).

## 7. Open / deferred (this wave's honest backlog)

- `silver_quarantine` Iceberg table + `_silver_technical.py::quarantine` helper (step 5) — **DEFERRED**.
- Consolidated `_silver_technical.py` envelope validator + generic string cleaner (steps 1, 3) —
  **DEFERRED** (today distributed across `_raw_normalize.py` + `silver_collector_event.py`).
- Centralized business-rule module + `stage=business` quarantine reasons (step 12) — **DEFERRED**.
- Multi-rule DQ rule-set (null-rate / range / referential) feeding `stage=dq` — **DEFERRED**.

These are *named and designed*, not silently missing. The pipeline is correct today (rejects are dropped
on admission, money is never blended, PII is hash-only, MERGE is idempotent); the deferred work makes the
technical layer *explicit, observable, and replayable*.
