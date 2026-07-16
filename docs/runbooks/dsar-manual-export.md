# Runbook — Manual DSAR export (`customers/data_request`)

Audit trail: **AUD-OPS-043**. The Shopify `customers/data_request` webhook is registered and
**ack-only** (`RegisterWebhooksCommand.ts` — "data export request (48h SLA; ack only)";
`ShopifyWebhookStrategy` fast-acks with no side effect). That satisfies Shopify app review,
but fulfilment is entirely on the operator: when a request arrives, a human runs THIS runbook.
Accepted posture at current merchant scale; an export job is the future automation.

**Clock:** treat the repo's stated **48h SLA** as the deadline from webhook receipt. Shopify
DSAR responses go **to the merchant** (the data controller), who forwards to the customer —
never directly to the end customer.

## 0. Record the request

Capture from the webhook payload (core logs / merchant email): `shop_domain`, `customer.email`
and/or `customer.phone`, `orders_requested` (if scoped), timestamp. Note the matching Brain
`brand_id` (the brand connected to that shop). Log receipt + completion in the brand's audit
trail — the WORM audit bucket is the durable home.

## 1. Resolve the subject (identifiers first)

Brain stores **no raw email/phone downstream** (NO-RAW-PII invariant) — the subject is
addressed by the **per-brand-salted SHA-256** of the normalized email/phone (the same 64-hex
`identifier_hash` the identity flow writes; scheme:
`apps/stream-worker/src/domain/identity/extract-identifiers.ts` `buildIdentifiers`, salt from
`tenancy.brand_identity_salt` via `get_brand_identity_salt(<brand_id>)` — migration 0109;
brain_app cannot read the salt table directly, use the function). Compute the hash(es) with a
one-off script that mirrors `buildIdentifiers` (normalize exactly as it does — do NOT hand-roll
a different normalization; a mismatched scheme silently finds nothing).

Then resolve the graph identity (Neo4j, the identity SoR — ADR-0004): look up the identifier
node by `(brand_id, identifier_hash)` → its canonical **`brain_id`** + all linked
identifiers/aliases + anon/device ids. If no node exists, the export may legitimately be
"no data held" — still verify Bronze (§2.3) before answering that.

## 2. Collect — per store, brand-scoped ALWAYS (`brand_id` first in every query)

1. **PG `contact_pii` vault (raw PII, KMS envelope):** the authorized read path for
   `(brand_id, brain_id)` — name/email/phone as held. If the envelope was already
   crypto-shredded (`pii_erasure_log.vault_shredded`), record "erased on <date>" instead.
2. **PG `ops` schema:** consent records, `pii_erasure_log` entries, ML
   inference log rows for the `brain_id`, identity/journey export rows.
3. **Iceberg Bronze (via duckdb-serving `POST /v1/query`, port-forward per `GO-LIVE.md` step 11
   — note DuckDB's function is `json_extract_string`):** the SAME predicates the RTBF job uses
   (`db/iceberg/duckdb/maintenance/erasure_raw_delete.py` — keep the two in lockstep):
   - `iceberg.brain_bronze.collector_events_connect` — payload-path predicates, brand first:
     ```sql
     SELECT payload FROM iceberg.brain_bronze.collector_events_connect
     WHERE json_extract_scalar(payload,'$.brand_id') = '<brand_id>'
       AND ( json_extract_scalar(payload,'$.properties.hashed_customer_email')  = '<hash>'
          OR json_extract_scalar(payload,'$.properties.customer_email_hash')    = '<hash>'
          OR json_extract_scalar(payload,'$.properties.hashed_customer_phone')  = '<phone_hash>'
          OR json_extract_scalar(payload,'$.properties.customer_phone_hash')    = '<phone_hash>'
          OR json_extract_scalar(payload,'$.pre_hashed_identifiers.hashed_customer_email') = '<hash>'
          OR json_extract_scalar(payload,'$.pre_hashed_identifiers.hashed_customer_phone') = '<phone_hash>'
          OR json_extract_scalar(payload,'$.properties.brain_anon_id') IN (<anon_ids>)
          OR json_extract_scalar(payload,'$.properties.device_id')     IN (<device_ids>) )
     ```
   - Raw lanes with lifted identifier columns (`RAW_TABLE_IDENTIFIER_COLS`):
     `shopify_orders_raw_connect` / `woocommerce_orders_raw_connect`
     (`identifier_hash`/`email_hash`), `ga4_rows_raw_connect` (`identifier_hash`/`client_id`),
     `shiprocket_shipments_raw_connect`, `gokwik_events_raw_connect`,
     `shopflo_checkout_raw_connect`, `razorpay_settlement_raw_connect` (`identifier_hash`) —
     `WHERE brand_id='<brand_id>' AND identifier_hash='<hash>'`. Note these lanes carry a
     **7-day row TTL** — usually empty for older subjects (that's an answer, not a failure).
   - Spend lanes (`meta/google_spend_raw_connect`) hold **no per-subject data** — skip.
4. **Silver/Gold (derived view of the same subject):** by `brain_id` through the serving
   views — `mv_silver_order_state`, journey/touchpoint marts, `customer_360` — each
   `WHERE brand_id='<brand_id>'`. Money stays bigint minor units + `currency_code` in the
   export; label it as such.

## 3. Package + deliver

One archive per request: `request.json` (metadata, scope, timestamps), `identity.json`
(brain_id, identifier hashes, alias intervals — NOT the salt), `pii.json` (vault contents or
erasure attestation), `events/` (Bronze rows), `derived/` (Silver/Gold rows), `README` naming
generation date + stores queried. Deliver to the **merchant** over an authenticated channel
(never email attachments of raw PII); do not retain the local working copy after delivery —
record completion (who, when, what scope) in the audit trail.

## Boundaries

- A DSAR **access** request erases nothing. If it arrives with (or is followed by)
  `customers/redact`, the RTBF chain (`EraseSubjectUseCase` → `bronze-raw-erasure`) handles
  erasure — export FIRST if both are pending.
- Kafka broker copies are **not** queried for export: Kafka is a transient transport
  (`docs/ops/rtbf-kafka-transport-policy.md`); everything it carried lands in Bronze, which §2
  covers.
- If the subject spans brands, repeat per `brand_id` — never join across tenants in one query.
