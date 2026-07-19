# Brain — Full Data Inventory (2026-07-19, local dev stack)

Every table in every data store, with live row counts (local dev volumes), structure, purpose, and a usefulness verdict derived from the code (writers → readers).

**Stores:** PostgreSQL (operational, schema-per-domain) · Iceberg medallion `brain_bronze`/`brain_silver`/`brain_gold` (system of record, queried via DuckDB) · duckdb-serving `brain_serving.mv_*` views (:8091) · Neo4j (identity SoR) · Redis (caches).

**Verdicts:** ACTIVE = written and read on a live path · WRITE-ONLY = written but no code reader (audit/forensic by design, or dead weight) · SERVED+READ / SERVED-UNREAD = gold mart with a serving view that the app does / does not query · INTERNAL = no serving view · DORMANT/SHADOW = parity job that skips (source retired) · RETIRED = dropped/removed.

Row counts are the local dev dataset (small; prod differs). Legend: NN = NOT NULL, (U) = unique.

---

## 1. PostgreSQL (db `brain`, 68 logical tables, 13 schemas, 0 views)

### tenancy — ALL ACTIVE
| Table | Rows | Purpose |
|---|---|---|
| organization | 3 | Workspace root; onboarding status |
| brand | 4 | Tenant root & RLS anchor; per-brand config (currency, tz, recognition horizons, identity capture) |
| brand_config_history | 12 | Bi-temporal brand config change history |
| brand_identity_salt | 4 | Per-brand identifier-hash salt (KMS-wrapped) |
| brand_keyring | 4 | Brand envelope DEKs |
| subject_keyring | 0 | Per-subject DEKs for crypto-shred (RTBF) |
| ref_currency / ref_timezone | 7 / 7 | Seeded reference data for brand FKs |

- organization: id:uuid PK, name, slug (U), owner_user_id, region_code, onboarding_status/step, timestamps
- brand: id:uuid PK, organization_id, display_name, domain, status, region_code, currency_code, timezone, revenue_definition, identity_salt_ciphertext:bytea, phone_guard_threshold, suppression_window_days, cod/prepaid_recognition_horizon_days, identity_capture, consent_source, timestamps
- brand_config_history: history_id PK, brand_id, config_key, config_value, valid_from/valid_to (one-open partial unique)
- brand_identity_salt / brand_keyring / subject_keyring: brand_id (+brain_id) PK, kms_key_id, wrapped_*_b64, key_version, is_active

### iam — ALL ACTIVE
| Table | Rows | Purpose |
|---|---|---|
| app_user | 3 | Users (citext email U, password_hash, verified/status) |
| membership | 0 | Org/brand membership + role (RLS input) |
| invite | 0 | Org/brand invites (token_hash U, pending-unique) |
| email_verification | 0 | Verification tokens |
| password_reset | 0 | Reset tokens |
| user_session | 0 | Sessions (jti U, refresh rotation family_id/rotated_from) |

### connectors
| Table | Rows | Purpose | Verdict |
|---|---|---|---|
| connector_instance | 2 | Connector integrations + OAuth secret_ref, per-provider ids (razorpay/ad_account/shopflo/gokwik/shiprocket/woo), health_state, next_repull_at; U(brand,provider,account_key) | ACTIVE |
| connector_sync_status | 2 | Sync state machine per instance (state, failure counts) | ACTIVE |
| connector_cursor | 2 | Per-lane repull/backfill cursors; U(brand,instance,resource) | ACTIVE |
| connector_sync_run (partitioned) | 0 | Append-only sync-run ledger (run_type, rows_ingested, error class) | WRITE-ONLY (audit by design) |
| connector_dlq_record (partitioned) | 0 | Webhook/pipeline dead-letter forensic store (topic/partition/offset, error_class, redrive_count) | ACTIVE |
| connector_webhook_raw_archive (partitioned) | 0 | Raw webhook payload archive (redacted_body, body_sha256 dedup) | WRITE-ONLY (forensics) |
| connector_webhook_raw_archive_legacy | 0 | Non-partitioned legacy copy of the archive | LEGACY — candidate to drop |
| connector_journey_stitch_map | 0 | order→stitched anon/brain_id map (click_ids, utms) | ACTIVE |
| connector_razorpay_order_map | 0 | Razorpay payment/order ↔ Shopify order id map | ACTIVE |

### jobs / pixel — ALL ACTIVE
| Table | Rows | Purpose |
|---|---|---|
| jobs.backfill_job | 0 | Backfill job lifecycle (status, records_processed, achieved_depth_label, requested_window_ms) |
| jobs.resource_backfill_state | 0 | Per-resource backfill cursor (anchor_at/floor_at/cursor, resumable) |
| pixel.pixel_installation | 1 | Pixel install token per brand (U(brand)), auto-install provider/ref |
| pixel.pixel_status | 0 | Pixel health state (waiting_for_data/verified/error) |

### ops (batch queues + identity operational)
| Table | Rows | Purpose | Verdict |
|---|---|---|---|
| erasure_request_queue | 0 | RTBF trigger queue (0140, ADR-0015 WS4): core enqueues → stream-worker erasure-orchestrator drains (attempts, next_attempt_at, dead-at-MAX = PG DLQ) | ACTIVE |
| restitch_pending | 0 | Identity restitch dirty queue | ACTIVE |
| journey_reversion_pending | 0 | Journey reversion queue (merge-triggered) | ACTIVE |
| scoped_recompute_request | 0 | Scoped recompute queue (brain_ids, affected_marts) | ACTIVE |
| silver_customer_identity | 6 | Neo4j→PG identity snapshot export (brain_id, lifecycle_state, merged_into) | ACTIVE |
| silver_identity_link | 10 | Identity link export (identifier_type/value → brain_id, tier) | ACTIVE |
| silver_journey_stitch | 0 | Journey stitch export (order_id → stitched_anon_id/brain_id) | ACTIVE |
| silver_identity_watermark | 4 | Silver-identity batch watermark (0138) | ACTIVE (internal) |
| identity_export_state | 2 | Identity export watermark | ACTIVE (internal) |
| stitch_conflict_review | 0 | Probabilistic-stitch conflict review queue | ACTIVE |
| brand_identity_priority | 0 | Identity resolution priority config per brand | ACTIVE |
| saved_segment | 0 | Saved analytics segments | ACTIVE |
| migration_state | 1 | Boot-time data-migration idempotency markers | ACTIVE (internal) |
| ops_ml_prediction_log (partitioned) | 0 | ML inference audit log | WRITE-ONLY (audit by design) |

### audit / consent / identity
| Table | Rows | Purpose | Verdict |
|---|---|---|---|
| audit.audit_log | 0 | General hash-chained audit trail (prev_hash/entry_hash, idempotency_key U) | WRITE-ONLY (by design) |
| audit.decision_log (partitioned) | 0 | Identity decision audit | ACTIVE |
| audit.identity_audit (partitioned) | 56 | Identity change audit (feeds identity-timeline reader) | ACTIVE |
| audit.dq_check_result (partitioned) | 1,296 | DQ check results (category/target/grade/score/passing) — feeds DQ surfaces | ACTIVE |
| audit.send_log (partitioned) | 0 | Outbound send audit (channel, blocked_reason, quiet-window release) | ACTIVE |
| audit.capi_deletion_log | 0 | Meta CAPI deletion audit (RTBF passback) | WRITE-ONLY (compliance) |
| audit.capi_passback_log | 0 | CAPI conversion passback audit (value_minor, match keys, fbtrace) | WRITE-ONLY (compliance) |
| consent.consent_record | 0 | Consent state per subject/category (policy_version, event-dedup) | ACTIVE |
| consent.consent_tombstone | 0 | Consent withdrawal markers | ACTIVE |
| identity.contact_pii | 3 | Encrypted PII vault (pii_ciphertext/iv/auth_tag, per-subject key_version) | ACTIVE |
| identity.pii_erasure_log | 0 | Immutable erasure audit (vault_shredded, surrogate_brain_id) | WRITE-ONLY (compliance) |

### billing — ALL ACTIVE (all 0 rows locally; billing not exercised in dev)
billing_plan (rate_bps per brand) · cost_input (scoped cost inputs, as-of) · invoice + invoice_line (GST invoices, U(brand,period), U(entity,fy,number)) · credit_note (+ number counters for invoice/credit_note, PK(legal_entity,fy)) · gmv_meter_snapshot (sealed metered GMV per period) · tax_ledger (partitioned). All money bigint minor units + currency_code.

### ml / ai_config — ALL ACTIVE (0 rows locally)
ml.model_registry (U(brand,name,version), one-production partial unique) · ai_config.ai_provenance (AI answer provenance: metric_id/version, snapshot_id, confidence_grade, trust_tier) · ai_config.recommendation / recommendation_action / recommendation_outcome (detector recommendations, actions taken, measured outcomes).

### public
| Table | Rows | Purpose | Verdict |
|---|---|---|---|
| gold_product_costs | 0 | Operator-entered product COGS (SKU, valid_from/to no-overlap); feeds the gold mart | ACTIVE |
| dev_secret | 0 | LocalStack secret durability snapshot (dev-only; prod hard-fail) | LEGACY (dev-only, intentional) |
| _rls_demo | 0 | RLS test fixture | LEGACY (test-only) |
| pgmigrations | 14 | node-pg-migrate ledger (consolidated baseline) | ACTIVE (internal) |

**RETIRED (dropped):** `data_plane.collector_spool` (0141, ADR-0015 direct-to-log) · `data_plane.ingest_dedup` (0139). Schema `data_plane` is now empty. No orphans — every app-referenced PG table has a creating migration.

---

## 2. Iceberg — brain_bronze (1 table)

### collector_events_connect — 75 rows — ACTIVE (sole Bronze landing writer, ADR-0010/0016)
- Columns: payload:VARCHAR (verbatim envelope JSON), kafka_topic, kafka_partition:INT, kafka_offset:BIGINT, kafka_timestamp:TIMESTAMPTZ (day partition)
- Writer: Kafka Connect sink `iceberg-bronze-collector` (topics `prod.collector.event.v1`, `prod.collector.order.backfill.v1`). Readers: `silver_collector_event` keystone, `collector_events_connect_lifted` serving lift view (read operationally by core `_bronze-source.ts`, stream-worker DQ, health surfaces). Maintained by `bronze_dedup.py` (compaction-time dedup on brand_id+event_id), retention, RTBF sweeps.

**Views over Bronze (in duckdb-serving, not catalog tables):** `collector_events_connect_lifted` (JSON scalars lifted) — ACTIVE · `events_unified` — audit-only, currently **BROKEN/SKIPPED** every epoch (`mv_bronze_events_unified.sql` still references retired `shopify_orders_raw_connect` → Catalog Error; stale post-ADR-0016, needs fix or deletion).

**RETIRED:** the 9 `<lane>_raw_connect` raw-lane tables (shopify_orders, woocommerce_orders, meta_spend, google_spend, ga4_rows, shiprocket_shipments, gokwik_events, shopflo_checkout, razorpay_settlement) — retired ADR-0016 (2026-07-18), never received data; erasure/retention sweeps skip them cleanly. Legacy Spark-written `collector_events` / `events` dropped at ADR-0010 cutover.

---

## 3. Iceberg — brain_silver (48 tables)

### Keystone & entity spine — ACTIVE
| Table | Rows | Purpose |
|---|---|---|
| silver_collector_event | 64 | THE keystone: admission gate over Bronze; feeds 11+ gold jobs. Cols: event_id, brand_id, occurred_at, ingested_at, schema_name/version, event_type, event_category, correlation_id, partition_key, anonymous_id, device_id, silver_version, payload |
| silver_order_state | 34 | Canonical order-state entity (revenue spine, ~19 gold consumers + orders-list UI). Cols: order_id, brain_id(+v2), lifecycle_state, is_terminal, order_value_minor, currency_code, first_event_at, state_effective_at, max_ingested_at |
| silver_order_line | 0 | Line-item grain (sku, qty, unit/line/discount minor) |
| silver_customer | 0 | Canonical customer rollup (lifetime orders/value, watermark) |
| silver_job_watermark | 59 | Per-job incremental watermark side-table (job_name, last_ingested_at) — ACTIVE (internal) |

### Behavior / journey — ACTIVE
| Table | Rows | Purpose |
|---|---|---|
| silver_touchpoint | 0 | Session/UTM touchpoint spine (35 cols: touch_seq, session_key/seq, channel, full UTM + click-id set fbclid/gclid/ttclid/msclkid/gbraid/wbraid/dclid, page_type…) — 10 gold consumers + journey timeline view |
| silver_sessions | 0 | Sessionization rollup (bounce, converted, duration) |
| silver_journey | 0 | Reconstructed visitor journey (first/last channel, converted) |
| silver_page_view | 0 | Pageview grain (28 cols: channel, UTMs, click ids, product/collection handle) |
| silver_cart_event | 0 | Cart interactions (action, variant, value_minor, coupon) |
| silver_checkout_signal | 8 | Checkout funnel signals (signal_type, risk_flag, totals) |
| silver_session_identity | 0 | Deterministic session→brain_id stitch (matched_via[], stitch_version) |
| silver_probabilistic_stitch | 0 | Splink probabilistic stitch, quarantined tier (confidence, model_version) |
| silver_engagement_signal | 0 | Rage/dead clicks, scroll (signal_type, scroll_pct, selector) |
| silver_form_submission | 0 | Lead/form conversions |
| silver_search | 0 | Site search grain (query, zero-result) — **WRITE-ONLY** |

### Identity projections (Neo4j → Silver) — ACTIVE
| Table | Rows | Purpose |
|---|---|---|
| silver_identity_map | 6 | Bi-temporal identifier_hash→brain_id map (customer_ref BRN-, effective/system intervals, is_current) — feeds customer_360, revenue_ledger, journey_events |
| silver_customer_identity | 3 | Neo4j Customer-node projection (lifecycle_state, merged_into) |
| silver_identity_alias | 6 | IDENTIFIES-edge projection (tier, is_active) |
| silver_identity_unmerge | 0 | Unmerge ledger → journey re-versioning |

### Commerce / money / logistics — ACTIVE
| Table | Rows | Purpose |
|---|---|---|
| silver_payment | 0 | Canonical payments (status, amount_minor) |
| silver_refund | 0 | Refunds (reason_code, method, initiated/settled) |
| silver_settlement | 0 | Settlements incl. disputes (fee/tax minor, utr_hash, reconciliation_type) |
| silver_fulfillment | 0 | Fulfillment grain (tracking) |
| silver_shipment | 0 | Latest shipment state (awb hash, terminal_class, is_rto/is_delivered) |
| silver_shipment_event | 0 | Shipment transition log — consumed only in-job by silver_shipment |
| silver_return | 0 | Returns (return_class, complete flag) |
| silver_cod_rto | 12 | COD/RTO risk & outcome (predicted vs actual, prediction_correct) |
| silver_inventory_level | 0 | Stock levels per variant |

### Marketing — ACTIVE
| Table | Rows | Purpose |
|---|---|---|
| silver_marketing_spend | 0 | Per-campaign/day spend fact (70 cols: spend/impressions/clicks/conversions, video/reach/frequency…) — 5 gold consumers + 6 views |
| silver_marketing_spend_by_demographic / _by_geo / _by_hour / _by_placement | 0 each | Breakdown grains (age/gender, country/region/dma, hour, placement/device) — views exist, **no app reader yet** |
| silver_campaign | 0 | Campaign dimension (status, objective, budget) |
| silver_keyword_spend | 0 | Google keyword-grain spend — view exists, no app reader |
| silver_ad_account | 0 | Ad-account dimension — **WRITE-ONLY** |

### Write-only (built, no downstream consumer — dead-weight candidates)
silver_product (0) · silver_product_variant (0) · silver_coupon (0) · silver_dispute (0) · silver_search (0) · silver_message_send (0) · silver_ad_account (0).

### Dormant shadows (ADR-0016; skip via source_present(), will never populate)
silver_collector_event_{shopify,woocommerce,ga4,shiprocket,shopflo,razorpay}_shadow — 0 rows each — DORMANT/SHADOW. Candidates for deletion with their `*_normalize.py` jobs.

Note: the gold snapshot jobs write `snap_order_state`, `snap_identity_link`, `snap_attribution_credit` into the silver namespace (INTERNAL point-in-time snapshots; not present in local catalog until first run).

---

## 4. Iceberg — brain_gold (44 tables)

### SERVED+READ (view exists AND the app queries it) — the live product surface
| Table | Rows | Purpose |
|---|---|---|
| gold_revenue_ledger | 38 | Event-sourced revenue truth ledger (~49 app refs) — amount/fee minor, recognition_label, economic_effective_at, billing_posted_period |
| gold_customer_360 | 0 | Flagship customer record (25 cols: customer_ref, LTV/AOV, delivered/rto/cancelled/refunded, health_band, churn_score, lifecycle_stage, journey_summary) |
| journey_events | 0 | Versioned journey ledger (**table name has no gold_ prefix**; 26 cols: data_version/is_current, attribution_signals MAP, identity_confidence as-of, composite keys) |
| gold_attribution_credit | 0 | Per-touch credit ledger (model_id, weight_fraction, reversals, confidence grades) |
| gold_marketing_attribution | 0 | Channel attributed revenue |
| gold_campaign_attribution | 0 | Per-campaign attributed revenue + ROAS bps |
| gold_attribution_paths | 0 | Path grain (channel_path, stitched order/brain id) |
| gold_journey | 0 | Journey aggregation (days_to_convert, distinct channels/sessions) |
| gold_journey_paths | 0 | Top paths (path_signature, edges STRUCT[], path_rank) |
| gold_funnel | 1 | Daily funnel (sessions→product→cart→checkout→purchase) |
| gold_funnel_user | 3 | User-grain funnel (furthest_step) |
| gold_behavior | 0 | Page-type mix daily |
| gold_abandoned_cart | 1 | Cart abandonment daily (abandoned_value_minor) |
| gold_conversion_feedback | 0 | Form/payment conversion feedback |
| gold_customer_health | 0 | Health score/band per customer |
| gold_customer_segments | 0 | RFM segment rollup |
| gold_customer_scores | 0 | ML churn/RFM scores per customer |
| gold_cohorts / gold_cohort_member | 0 / 0 | Acquisition cohorts + membership |
| gold_retention | 0 | Repeat/returning rates per cohort (bps) |
| gold_repeat_latency | 0 | Time-to-second-purchase buckets |
| gold_cac | 0 | CAC by acquisition month |
| gold_executive_metrics | 6 | Exec summary (orders, realized value, terminal splits) |
| gold_revenue_analytics | 7 | Revenue by month × lifecycle_state |
| gold_utm_source | 0 | UTM source performance (LTV, repeat rate) |
| gold_product_detail | 0 | Product funnel (views→cart→purchase, returns) |
| gold_product_affinity | 0 | Co-purchase affinity (support_pct) |
| gold_ai_features | 0 | ML feature vectors (runtime-foldable) |
| gold_recommendation_features | 0 | Reco features (affinity bands, cadence) |
| gold_delivery_time | 0 | Delivery-time buckets per courier |

### SERVED-UNREAD (view exists, no app reader — candidates to wire up or prune)
gold_campaign_performance (0) · gold_cod_rto (2) · gold_engagement (0) · gold_measurement_costs / _fees / _inventory / _refunds / _settlements (0 each) · gold_product_costs (0; the app reads the PG `public.gold_product_costs` instead).

### INTERNAL (no serving view; feed other marts or ops)
gold_contribution_margin (6) — CM1/CM2 rollup · gold_order_economics (34) — per-order CM1/CM2/CM3 · gold_product_economics (7) — product margins · gold_logistics_performance (0) · gold_settlement_summary (0) · gold_journey_events_reversion — merge re-versioning pass over journey_events · snap_order_state / snap_identity_link / snap_attribution_credit — daily snapshots.

---

## 5. duckdb-serving (`brain_serving`, 63 live views)

- 38 `mv_gold_*` project the same-named gold mart; exceptions: `mv_gold_customer_list` → gold_customer_360, `mv_gold_journey_timeline` → silver_touchpoint, `mv_gold_measurement_spend` → silver_marketing_spend, `mv_journey_events_current` → journey_events (is_current filter).
- 14 `mv_silver_*` project same-named silver tables (order_state, order_line, touchpoint, collector_event, identity_map, checkout_signal, return, shipment, keyword_spend, marketing_spend + 4 breakdowns).
- 7 helper/semantic views: identity_asof, identity_current_v, customer_sessions_extended_v, semantic_order, semantic_customer, semantic_campaign, semantic_journey, semantic_product.
- ~90 `mv_metric_*` names in the metric-engine are engine-managed derived views (intentional, not files in views/).
- **16 views with no live app reader:** mv_bronze_events_unified (also broken — stale raw-lane ref), mv_gold_campaign_performance, mv_gold_cod_rto, mv_gold_engagement, 5× mv_gold_measurement_*, mv_gold_product_costs, mv_silver_keyword_spend, 4× mv_silver_marketing_spend_by_*.
- Sanity counts via API matched the marts (mv_gold_revenue_ledger=38, mv_silver_order_state=34, mv_gold_executive_metrics=6).

---

## 6. Neo4j (identity system of record, ADR-0004) — ALL ACTIVE

| Node label | Count | Properties |
|---|---|---|
| Customer | 3 | brain_id, brand_id, lifecycle_state, ai_processing_consent, resolution_consent, first_identified_at, created_at |
| Identifier | 6 | brand_id, type (email/anon_id), hash |
| MergeEvent / MergeReview / SharedUtility | 0 | Schema-defined (constraints exist), no data yet |

Relationships: `IDENTIFIES` ×6 (Identifier→Customer). Uniqueness constraints on Customer(brand_id,brain_id), Identifier(brand_id,type,hash), MergeEvent(merge_id), SharedUtility(brand,type,value); range indexes on lifecycle_state, merge-event brand+canonical/merged, review brand+status, IDENTIFIES created_at/is_active.

## 7. Redis (cache) — ALL ACTIVE, ephemeral

6 keys, all `idcache:<brand_id>:idhash:<email|anon_id>:<sha256>` (string, TTL ~6.7 days) — the ADR-0015 identifier_hash→brain_id cache for the silver-identity stage; matches the 6 Neo4j Identifier nodes exactly. Analytics-cache / dedup / OAuth-state / lock key families are TTL'd and currently expired. 1.3M used / 192M max, volatile-lru, no auth (dev).

---

## 8. Recommendations — rubric-scored

Every recommendation answers: (1) Should this exist? (2) Who owns this data? (3) Why is it stored here? (4) Could another engine own it better? (5) Can it be deleted? (6) Can it be merged? (7) Can it be simplified? (8) What operational cost does it introduce? (9) Does it improve production reliability?
Goal: fewer tables, fewer jobs, fewer views, fewer copies — over a 5-year horizon. **No new databases, tables, or indexes anywhere below.**

### Tier 1 — DELETE NOW (pure shrink, zero product risk)

**R1. The 6 `silver_collector_event_*_shadow` tables + their 6 `silver_*_normalize.py` jobs.**
1 Should exist? No — their parity target (raw `*_raw_connect` lanes) was retired by ADR-0016; they can never populate. 2 Owner: data platform (transform tier). 3 Why here: Iceberg, because they mirrored the Silver keystone for shadow parity. 4 Better engine: n/a. 5 Delete? Yes — tables, jobs, and the `source_present()` skip branches. 6 Merge: n/a. 7 Simplify: deletion is the simplification. 8 Cost today: 6 no-op job invocations every transform tick, catalog clutter, dead branches in erasure/retention sweeps. 9 Reliability: improves — smaller failure surface, faster tick, nothing depends on them.

**R2. `mv_bronze_events_unified` serving view.**
1 Should exist? No — it is *broken*: still references retired `shopify_orders_raw_connect`, throws a Catalog Error and is skipped every serving epoch. 2 Owner: serving tier. 3 Why here: pre-ADR-0016 audit union. 4 Better engine: n/a. 5 Delete? Yes (`views/mv_bronze_events_unified.sql`). 6/7 n/a. 8 Cost: one guaranteed error per epoch polluting logs, masking real view failures. 9 Reliability: improves — a permanently-red signal is worse than no signal.

**R3. `connectors.connector_webhook_raw_archive_legacy` (PG).**
1 Should exist? No — superseded by the partitioned archive. 2 Owner: connector platform. 3 Why here: pre-partitioning copy left behind. 4 n/a. 5 Delete? Yes (0 rows; one DROP migration). 6 Merge: already merged into the partitioned table. 7 n/a. 8 Cost: schema noise, backup/vacuum surface, confusion about which archive is real. 9 Reliability: neutral-positive.

**R4. `data_plane` schema (PG, empty).**
1 Should exist? No — both tables dropped (0139/0141). 5 Delete? Yes, one DROP SCHEMA migration. 8 Cost: cosmetic only. 9 Neutral — but empty schemas invite someone to put something back.

**R5. Unread serving views (12): 5× `mv_gold_measurement_*`, `mv_gold_product_costs`, `mv_silver_keyword_spend`, 4× `mv_silver_marketing_spend_by_*`, plus R2.**
1 Should exist? No — a serving view is API surface; unread surface is liability. 2 Owner: serving tier. 3 Why here: created wholesale alongside marts. 4 n/a. 5 Delete? Yes — views only; underlying tables judged separately (R6/R8/R10). Recreating a view later is a one-file change. 6/7 The serving contract shrinks to "views the app actually reads". 8 Cost: startup apply time, `/readyz` surface, implied compatibility promises. 9 Reliability: improves — every live view can be monitored as "must work".

### Tier 2 — STOP BUILDING (delete jobs + tables; Bronze replay restores them the day a consumer exists)

**R6. `gold_measurement_refunds`, `gold_measurement_settlements`, `gold_measurement_inventory` (3 marts + jobs).**
1 Should exist? Not today — no gold job, view reader, or app path consumes them (unlike `_costs`/`_fees`, which feed `gold_order_economics` — those stay). 2 Owner: measurement/economics domain. 3 Why here: built end-to-end ahead of demand. 4 Better engine: no — they are thin re-projections of `silver_refund`/`silver_settlement`/`silver_inventory_level`; the Silver tables already own this data. 5 Delete? Yes. 6 Merge: effectively merging back into their Silver sources (readers should read Silver). 7 Simplify: 3 fewer jobs per tick. 8 Cost: 3 jobs/tick, 3 tables of maintenance/compaction/RTBF sweep. 9 Reliability: improves tick time; zero data loss — deterministically rebuildable from Silver/Bronze.

**R7. 7 write-only Silver tables + jobs: `silver_product`, `silver_product_variant`, `silver_coupon`, `silver_dispute`, `silver_search`, `silver_message_send`, `silver_ad_account`.**
1 Should exist? Not as materialized tables with zero consumers. 2 Owner: canonical-entity (Silver) tier. 3 Why here: built speculatively during connector-depth waves. 4 Better engine: no — Iceberg is right *when* consumed. 5 Delete? Yes, jobs + tables; code stays in git, data replays from Bronze (core rule: replay > retention of dead marts). 6 Merge: `silver_product` overlaps `silver_order_line`-derived product facts used by `gold_product_detail` — when product analytics ships, prefer extending that path over resurrecting both product tables. 7 Simplify: −7 jobs/tick. 8 Cost: 7 jobs/tick + 7 tables of snapshot/compaction/RTBF surface — the single largest recurring dead cost in the transform tier. 9 Reliability: improves — fewer jobs that can wedge a tick.

**R8. Marketing-spend breakdown grains: `silver_marketing_spend_by_{demographic,geo,hour,placement}` + `silver_keyword_spend` (5 tables + jobs).**
1 Should exist? Not until a surface reads them — no app reader today. 2 Owner: marketing domain. 3 Why here: captured because Meta/Google emit the breakdowns. 4 Better engine: no. 5 Delete? Yes (jobs + tables + views per R5) — the raw breakdown events remain in Bronze forever, so this is deferral, not loss. 6 Merge: they cannot merge into `silver_marketing_spend` without exploding its grain — correct as separate tables *when needed*. 7 Simplify: −5 jobs/tick. 8 Cost: 5 jobs/tick; the widest Silver schemas in the tier. 9 Reliability: improves tick time and reduces Meta/Google mapper blast radius.

**R9. Fold `silver_shipment_event` into the `silver_shipment` job.**
1 Should exist as a table? No — its only consumer is the `silver_shipment` build itself. 2 Owner: logistics domain. 3 Why here: materialized intermediate. 4 n/a. 5 Delete the table; 6/7 merge it into the shipment job as a CTE/temp relation. 8 Cost saved: one table's snapshot/maintenance churn on the hottest event stream (shipment webhooks). 9 Reliability: one less commit point per tick. *Caveat: keep it if the transition log is wanted as an audit ledger — then it's a WRITE-ONLY-by-design keep, but say so in the job header.*

### Tier 3 — MERGE / SIMPLIFY (fewer copies of the same fact)

**R10. Customer-scoring triplet: `gold_customer_health` + `gold_customer_scores` vs `gold_customer_360`.**
1 Should all three exist? No — `gold_customer_360` already carries `health_band`, `churn_score`, `lifecycle_stage`. 2 Owner: customer domain. 3 Why: three waves built three overlapping per-customer scoring marts. 4 Engine: fine. 5/6 Merge: fold `customer_health` (recency/frequency/health) and `customer_scores` (RFM/churn_risk) into `customer_360`; repoint `mv_gold_customer_health`/`mv_gold_customer_scores` at projections of `customer_360` first (zero app change), then retire the marts. 7 One per-customer fold instead of three scans of the order spine. 8 Cost today: 3× the same customer scan per tick. 9 Reliability: improves — one definition of customer health instead of three that can disagree (trust surface).

**R11. Identity fact copies — Neo4j (SoR) → Redis idcache → PG `ops.silver_customer_identity`/`silver_identity_link` → Iceberg `silver_customer_identity`/`silver_identity_alias`/`silver_identity_map`. Six copies across four engines.**
1 Should exist? The *engines* yes — each owns a distinct read path (graph resolution / hot cache / operational app reads / analytical joins). 2 Owner: identity domain; Neo4j is the single system of record (ADR-0004) — everything else is projection. 3 Why each: latency and isolation (serving can't read PG; apps can't query Neo4j cheaply). 4 Better engine: no — collapsing engines would violate ADR-0015's batch-identity design. 5 Delete? Not the engines. 6 Merge *within* Iceberg: `silver_customer_identity` and `silver_identity_alias` are current-state projections derivable from bi-temporal `silver_identity_map` (`is_current = true`). Make `silver_identity_map` the sole materialized identity projection; derive the other two as views or in-job CTEs. −2 tables, −2 jobs. 7 Simplify: one export lane (Neo4j → map), not three. 8 Cost today: three projection jobs that can drift from each other. 9 Reliability: improves — drift between identity copies is a correctness bug class; fewer copies, fewer drifts. *Keep the PG pair as-is: `capi-source`, `journey-stitch-from-identity`, and `backfill-identity` read them operationally.*

**R12. `gold_product_costs` (PG `public` + Iceberg mart + serving view).**
1 Should exist? Yes twice, not three times. 2 Owner: PG `public.gold_product_costs` is the SoT — operator-entered COGS is *operational input*, correctly in PG. 3 The Iceberg mart exists so `gold_order_economics`/`gold_measurement_costs` can join it in DuckDB — a legitimate projection. 4 Engine split is correct. 5 Delete the serving view only (app reads PG; per R5). 6/7 Rename consideration only (a PG table named `gold_*` misleads — defer, renames are churn). 8 Cost: minimal. 9 Neutral. *Also move `public.gold_product_costs` → a domain schema whenever a migration touches it anyway; `public` should hold nothing but `pgmigrations`.*

**R13. Journey/path mart family: `gold_journey`, `gold_journey_paths`, `gold_attribution_paths`, `journey_events`.**
1 Should all exist? Borderline — all four are read, so no deletion now. 6 Merge direction for the 5-year horizon: `journey_events` (the versioned ledger) is the durable asset; `gold_journey` and the two path marts are aggregations of it and should eventually become projections *of the ledger* rather than independent re-scans of `silver_touchpoint`. 7 One journey source of truth, N cheap rollups. 8 Cost today: four jobs re-deriving overlapping journey facts. 9 Reliability: consolidation removes "journey numbers disagree between tabs" — a direct trust risk. *Do this opportunistically, not as a project.*

### Tier 4 — WIRE OR KILL (product decision required, then apply R5/R6 logic)

**R14. `gold_cod_rto` (+view), `gold_campaign_performance` (+view), `gold_engagement` (+view).**
1 Should exist? The data says yes (COD/RTO is core India-commerce truth; campaign perf and engagement funnels are roadmap surfaces) — but a mart no surface reads fails "no empty charts" from the other side: computed truth no one sees. 2 Owners: logistics / marketing / behavior domains. 5 Not deletable blindly — `gold_cod_rto` has live data (2 rows) and a full silver chain. Decision: give each a dashboard reader within one quarter or delete view+mart per R6. 8 Cost of limbo: jobs+views maintained with zero user value. 9 Wiring them improves trust; killing them improves speed — limbo improves nothing.

### Tier 5 — EXPLICIT KEEPS (so nobody "cleans" these)

**R15. Billing schema (10 tables, all empty).** Should exist: yes — GST invoicing is legally-shaped (number counters, credit notes, tax ledger) and schema-correct; empty only because billing hasn't launched. PG is the right engine (transactional, sequenced). Delete/merge: no. Cost: near-zero (empty partitions). Do not extend until launch.

**R16. WRITE-ONLY audit/compliance tables** (`audit.audit_log`, `capi_deletion_log`, `capi_passback_log`, `identity.pii_erasure_log`, `connectors.connector_sync_run`, `connectors.connector_webhook_raw_archive`, `ops.ops_ml_prediction_log`). Should exist: yes — forensic/compliance ledgers are written for the reader you hope never arrives (regulator, incident). PG correct (durable, transactional, per-brand RLS). Only ask: partitions already bound growth; add retention windows when prod volume warrants, not now. Reliability: these ARE the reliability story (replay/audit core rule).

**R17. PG ops queues** (`erasure_request_queue`, `restitch_pending`, `journey_reversion_pending`, `scoped_recompute_request`, `stitch_conflict_review`). Should exist: yes — ADR-0015 deliberately made PG the queue engine (no Kafka consumers in stream-worker). Best engine: yes, by ratified decision. Keep.

**R18. `mv_metric_*` (~90 engine-managed views).** Not orphans, but ungoverned growth risk: the metric-engine creates them and nothing garbage-collects. Ask the 9 questions *mechanically*: add an orphan-GC step to the engine (drop views whose metric definition no longer exists). No new storage; pure hygiene.

### Net effect if Tiers 1–3 land

- **Iceberg tables:** 93 → ~72 (−6 shadows, −3 measurement, −7 write-only silver, −5 spend grains, −1 shipment_event, −2 identity projections, and eventually −2 customer-scoring marts)
- **Transform jobs per tick:** ~−22 no-op or dead invocations → faster resident loop, smaller wedge surface
- **Serving views:** 63 → ~50, every survivor with a monitored live reader
- **PG:** −1 table, −1 schema; zero engines added, zero engines removed
- Every deletion is replayable from Bronze — nothing here violates "no event loss"; this is deferral of materialization, not loss of truth.

## Appendix — original findings list

1. **8 write-only Silver tables** built with no downstream consumer: silver_product, silver_product_variant, silver_coupon, silver_dispute, silver_search, silver_message_send, silver_ad_account (+ shipment_event is in-job only). Wire into Gold or stop building.
2. **The 5 gold_measurement_* marts + views** are built end-to-end but never read by the app; same for gold_campaign_performance, gold_cod_rto, gold_engagement views.
3. **6 dormant shadow tables + jobs** (silver_collector_event_*_shadow) can be deleted post-ADR-0016.
4. **mv_bronze_events_unified is broken** (references retired shopify_orders_raw_connect; skipped every epoch with a Catalog Error) — fix or delete.
5. **connectors.connector_webhook_raw_archive_legacy** — superseded by the partitioned table; drop candidate.
6. **gold_product_costs duplication** — app reads PG `public.gold_product_costs`, not the Iceberg mart/view.
7. WRITE-ONLY PG audit tables (audit_log, capi_*, pii_erasure_log, sync_run, ml_prediction_log) are **by design** (compliance/forensics) — keep.
