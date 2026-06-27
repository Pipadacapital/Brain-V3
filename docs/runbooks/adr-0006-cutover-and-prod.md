# ADR-0006 cutover + prod runbook — Redpanda-native Bronze (Kafka Connect), raw Bronze, Silver-side gate+normalize

Covers **P5** (per-lane cutover + retiring the Spark Bronze sink) and **P6** (prod + raw-Bronze retention + the D4 Security-Reviewer sign-off that GATES the prod flip). The build + per-connector byte-exact verification is DONE (see the PR); this runbook is the operational flip.

## State at the start of cutover (all built + verified)
- **Bronze writer**: Kafka Connect Iceberg sink writing raw topic → `brain_bronze.*_raw` (P1 merged; collector lane live; per-connector configs in `infra/kafka-connect/iceberg-bronze-*.json`).
- **Gate in Silver**: `silver_collector_event` (R2/R3 + dedup over the raw collector lane) — parity-exact vs the Spark sink; the pixel lane is already cut over (`silver_touchpoint`).
- **Normalizers**: `silver_<connector>_normalize.py` for all 8 connectors, each **byte-exact-verified** against its real TS mapper via golden vectors (`_p4_golden/`). Shopify additionally proven **end-to-end** (raw→Connect→Spark→parity).
- **NOT yet flipped**: the connectors still EMIT canonical events; `silver_order_state`/spend/etc still read the canonical lane; the Spark sink (`bronze_materialize.py`) still writes `collector_events` for those canonical lanes.

## D4 — the compliance gate (BLOCKS the prod flip; Security-Reviewer sign-off)
Raw Bronze now holds **un-hashed PII** (email/phone) and, for the razorpay lane, **PCI `card.*`** fields, transiently, before the Silver gate hashes/drops them. Required before prod:
1. **Short retention** on every `*_raw` table — `db/iceberg/spark/bronze_raw_retention.py` (snapshot expiry, default 7d; tighten per region/regime). Schedule as an Argo cron.
2. **RTBF coverage** — extend the erasure tooling to DELETE a subject across the `*_raw` tables (the raw namespace), not just Silver/Gold.
3. **PCI** — confirm the razorpay raw lane stays inside the SAA-A boundary (raw `card.*` must not leave the lakehouse account; the normalizer hashes/drops it into Silver). Consider excluding `card.*` at the connector emit for razorpay.
4. **Sign-off**: Security-Reviewer signs the D4 posture change ("consent-gated before the durable layer (Silver), raw buffer expires fast"). **No prod connector is flipped until this is signed.**

## Per-lane cutover (P5) — repeat per connector, dual-run then flip
Do ONE connector at a time, lowest-risk first (the proven order: shopify → woocommerce → ad-spend → ga4 → shiprocket → gokwik → shopflo → razorpay). Each lane:

1. **Stand up the raw Connect connector**: register `infra/kafka-connect/iceberg-bronze-<lane>.json` → auto-creates `brain_bronze.<lane>_raw`.
2. **DUAL-EMIT (no disruption)**: flag-gate the connector to emit BOTH the canonical event (unchanged) AND the raw provider payload to `<lane>.raw.v1`. Nothing downstream changes yet. (Flag: `EMIT_RAW_<LANE>=1`.)
3. **Shadow-normalize + parity**: run `silver_<lane>_normalize.py` (→ shadow table) and the dual-run parity harness — KEY parity (PK anti-join, 0 missing/extra), MONEY parity (per `(brand_id, currency_code)` Σ, delta 0), IDENTITY parity (hashed PII / classifications, null-safe). For no-money lanes (shiprocket/gokwik) the analogue is the `terminal_class` multiset. **Gate: 0 deltas on live data over a soak window.**
4. **Flip**: point the lane's Silver readers at the normalized output (set `TARGET_TABLE=silver_collector_event` so the normalizer writes the live gated table, or source-scope `silver_order_state`/etc to read the normalized rows). For multi-source marts (silver_order_state/line = shopify+woo; silver_shipment_event = shiprocket+gokwik; silver_checkout_signal = shopflo+gokwik) flip BOTH legs only after BOTH pass parity, source-scoped, so no double-count.
5. **Retire the canonical emit**: turn off the canonical event emission for that lane; retire that lane's TS mapper (per the design's `mappers_to_retire` — keep load-bearing side-effects: shopify `projectOrderStitch`, razorpay MB-1 `mapPaymentWebhookToMapRow`).

## Retire the Spark Bronze sink (end of P5)
Once EVERY lane (incl. the multiplexed collector lane's order.live.v1/spend.live.v1/… server-trusted events) is on the Connect→raw→normalize path:
- Remove `bronze_materialize.py`, the `spark-bronze-sink` compose service, and its Argo cron.
- The `brain_bronze.collector_events` (Spark-sink) table becomes read-only history, then drops after a grace window.
- The checkpoint-corruption class of bug is gone with it.

## P6 — prod
- **Kafka Connect**: MSK Connect (or self-managed Connect on EKS) running the Tabular iceberg-kafka-connect plugin; the same connector configs with the Glue catalog + S3 (not the local REST+MinIO). Topic prefix = `prod` via `NODE_ENV`.
- **Catalog/FileIO**: `iceberg.catalog.type=glue` + `aws.glue.catalog-id`, S3 (no endpoint/path-style); IRSA creds (no static keys).
- **Retention cron**: `bronze_raw_retention.py` as an Argo CronWorkflow, region-tuned `RAW_RETENTION_HOURS`.
- **Salt in Spark (prod)**: the normalizers read the per-brand salt; in prod swap the dev-derived salt query for the KMS-unwrapped SoR (`get_brand_identity_salt_all()` / a secure view over `tenancy.brand_identity_salt`, migration 0109) so the hash matches what the connector used. Confirm dev-derived == prod-KMS-unwrapped for any brand that spans the cutover.
- **Rollback** (per lane, any time before retiring the canonical emit): repoint the lane's Silver readers back at `silver_collector_event`/`collector_events`, re-enable the Spark sink leg, turn the raw connector off. Reversible until the Spark sink is deleted.

## Consolidation follow-up (non-blocking)
Each connector normalizer carries a few LOCAL helper ports (Meta `major_decimal_to_minor`, Google `micros_to_minor`, Woo gmt-naive `iso`, the per-source payment classifiers, logistics-status label sets) that are duplicated byte-identically in their golden tests. Fold these into `_raw_normalize.py` (with the golden tests as the regression guard) so the shared framework owns every primitive.
