# M1 Database & Migration Plan — Brain (Spine Milestone)

**Author:** Data Engineer
**Date:** 2026-06-15
**Milestone:** M1 — Spine (one reconciling realized-revenue number end-to-end)
**Status:** PLAN (not built; no migrations run; no dbt models created)
**Sources cited:** doc 08 (authoritative schema), doc 10 §6/§7/§8, doc 11 §1/§8, STACK.md, db/migrations/0001_init.sql, db/iceberg/bronze_table.sql, db/starrocks/bootstrap.sql + ddl/silver_template.sql

---

## 1. Plain-Language Overview — Four Data Stores

Brain's data plane is four stores with a strict one-way flow and a single rule: **`brand_id` is the tenant key at every layer**.

```
Events → Iceberg Bronze (S3) → dbt → StarRocks Silver → StarRocks Gold → Analytics API
                                        ↑
                          PostgreSQL (control plane — sits beside the flow)
                                        ↓
                               Redis (cache — no schema)
```

### PostgreSQL (OLTP control plane)
The transactional System of Record for everything that needs read-modify-write with strong consistency: organisations, brands, users, roles, sessions, connector configuration, the identity graph (`brain_id`, `identity_link`, `brain_id_alias`), the realized-revenue ledger (the M1 star, financial SoR), the metric registry, cost inputs, FX rates, consent records, the PII vault (`contact_pii`), the per-brand keyring, and the hash-chained audit log. Runs on AWS RDS Postgres 16 Multi-AZ + PITR (RPO ≤ 5 min).

**Isolation:** Row-Level Security is a Postgres kernel property. Every brand-scoped table enables RLS with the two-arg predicate (NN-1): `brand_id = current_setting('app.current_brand_id', TRUE)::uuid`. The app connects as the non-owner role `brain_app` (no `BYPASSRLS`, no DDL, no ownership). Middleware sets the GUC per request and asserts non-null before any query — a missing GUC returns NULL which makes the predicate false for every row (zero rows, not an error).

### Iceberg Bronze on S3/MinIO
The immutable raw-event lakehouse and replay System of Record. Append-only (MERGE on `(brand_id, event_id)` for idempotency). Every event lands here first; Silver/Gold are derived from it. Retained 24 months. Per-brand S3 prefix (`bronze/brand=<id>/...`) + per-brand KMS data key (envelope-wrapped under a small CMK set) = physical and cryptographic isolation.

**Isolation:** per-brand S3 prefix + KMS DEK per brand. Partition spec `bucket(16, brand_id) + days(occurred_at)` ensures tenant-scoped scan pruning and per-brand erasure-aware compaction.

### StarRocks Silver + Gold (analytics serving — derived, rebuildable)
The derived serving layer, built by dbt-on-StarRocks over Bronze. Silver = normalized PK-upsert tables (mutable order lifecycle, one canonical row per entity). Gold = append-only ledger mirrors + metric-ready marts. Not a System of Record — fully rebuildable from Bronze plus the Postgres ledger.

**Isolation:** per-brand row policies (`CREATE ROW POLICY ... USING (brand_id = SESSION_VALUE('brain_current_brand_id'))`) applied to every Silver and Gold table. Tables distributed `BY HASH(brand_id, <high-card key>)` — brand-first. The Analytics API is the sole reader (one isolation surface to fuzz).

### Redis (cache — no schema)
Hot reads, session state, rate-limit counters, MCP-key revocation denylist. NOT schema'd here. Tenant isolation via the single `tenant-context.brandKey()` helper which builds keys as `brand_id + metric_id + metric_version + filters_hash + grain + as_of`. Raw key construction is lint-banned. Cross-brand cache hits are forbidden.

---

## 2. Current State — Sprint-0 Baseline

| Store | What Exists | Status | Notes |
|---|---|---|---|
| **Postgres** | `0001_init.sql`: `brain_app` role, `audit_log`, `brand_keyring`, `_rls_demo` (RLS proof) | **Authored — NOT applied to dev Postgres** | Migration #0001 is the only file in `db/migrations/`; it has never been run via `pnpm migrate` because that command does not yet exist (M1 Sprint-task) |
| **Postgres** | All business tables (`organization`, `brand`, `app_user`, `connector_instance`, `identity_link`, `realized_revenue_ledger`, etc.) | **Not created** | Doc 05 §9: "full business tables ship in M1" |
| **Iceberg Bronze** | `brain_bronze.collector_events` table DDL + `bronze_spec.json` | **Table authored; MinIO `brain-bronze`/`brain-audit` buckets exist but empty** | Partition spec and schema evolution policy fixed at creation; never evolved |
| **StarRocks** | `brain_silver` + `brain_gold` databases; `brain_silver.isolation_test` table; `brain_analytics` user; `brain_bronze_local` external catalog | **Applied in dev** | Only the `isolation_test` stub exists; all business Silver/Gold tables are stubs only (`silver_template.sql` prints a message, no tables created) |
| **StarRocks** | Row policies on `isolation_test` | **Template exists; enterprise-only — not applied in local open-source dev** | Must be applied on managed/production cluster at M1 |
| **dbt** | `dbt_project.yml` skeleton; `models/staging/_empty_model.sql` stub; `tests/_dq_stubs.yml` | **Skeleton only — no real models** | Layering declared: staging (view) → intermediate (view) → marts (table) |
| **Redis** | Cluster exists | **No schema — documented tenant-key convention** | — |

---

## 3. M1 Target Schema — Per Store

Scope is the **Spine**: realized-revenue number end-to-end (collector → Bronze → Silver → ledger → metric engine → Analytics API → web shell). Everything listed is either NEW for M1 or extends a Sprint-0 stub.

### 3.1 PostgreSQL — Control Plane

All tables listed below are NEW for M1 unless marked as exists (Sprint-0).

#### Workspace & Access (migration 0002)

| Table | Purpose | Key Columns | PK | Isolation |
|---|---|---|---|---|
| `organization` | Tenant root — no RLS (one row per org, not brand-scoped) | `org_id UUID`, `legal_name TEXT`, `billing_country CHAR(2)`, `region TEXT CHECK IN ('IN','GCC')`, `status TEXT` | `org_id` | No RLS — org is above the brand tenant boundary |
| `brand` | The tenant leaf — every brand-scoped query pins here | `brand_id UUID`, `org_id FK`, `display_name TEXT`, `slug TEXT`, `base_currency CHAR(3)`, `timezone TEXT`, `region TEXT`, `tax_regime TEXT` (see §36 — `GST_IN | VAT_AE_5 | VAT_SA_15`), `kms_key_arn TEXT`, `identity_salt_ciphertext BYTEA`, `revenue_definition TEXT DEFAULT 'realized'`, `status TEXT` | `brand_id` | RLS: `brand_id = current_setting('app.current_brand_id', TRUE)::uuid` OR `org_id = current_setting('app.current_org_id', TRUE)::uuid` (owner rollup) |
| `app_user` | Authenticated users across the org | `user_id UUID`, `org_id FK`, `email CITEXT`, `idp_subject TEXT`, `display_name TEXT`, `status TEXT`, `mfa_enrolled BOOL` | `user_id` | No brand-scoped RLS — org-scoped; access gated by membership |
| `role` | RBAC role definitions (4 fixed) | `role_id UUID`, `role_code TEXT UNIQUE CHECK IN ('owner','brand_admin','manager','analyst')`, `level SMALLINT`, `display_name TEXT` | `role_id` | Global (no RLS) |
| `permission` | Permission registry | `permission_id TEXT`, `description TEXT` | `permission_id` | Global |
| `role_permission` | Role–permission mapping | `role_id FK`, `permission_id FK` | `(role_id, permission_id)` | Global |
| `membership` | User–brand–role binding | `membership_id UUID`, `org_id FK`, `brand_id UUID FK NULL`, `user_id FK`, `role_id FK`, `status TEXT`, `granted_by FK` | `membership_id` | RLS on brand_id where brand_id IS NOT NULL |
| `invite` | Pending invite tokens | `invite_id UUID`, `org_id FK`, `brand_id FK NULL`, `email CITEXT`, `role_id FK`, `token_hash TEXT UNIQUE`, `status TEXT`, `expires_at TIMESTAMPTZ` | `invite_id` | RLS where brand_id IS NOT NULL |
| `session` | Auth sessions (JWTs not stored; revocation denylist in Redis) | `session_id UUID`, `user_id FK`, `refresh_token_hash TEXT UNIQUE`, `device_label TEXT`, `ip INET`, `issued_at TIMESTAMPTZ`, `expires_at TIMESTAMPTZ`, `revoked_at TIMESTAMPTZ` | `session_id` | No RLS — user-scoped, not brand-scoped |

Money convention: `base_currency CHAR(3)` on `brand`; all money columns elsewhere are `*_minor BIGINT` + `currency_code CHAR(3)` (never a float).

#### Connector & Cursor (migration 0003)

| Table | Purpose | Key Columns | PK | Isolation |
|---|---|---|---|---|
| `connector_instance` | Per-brand connector config (Shopify, Meta, etc.) | `connector_id UUID`, `brand_id FK`, `connector_type TEXT`, `category TEXT CHECK IN ('ads','storefront','marketplace','payments','logistics','accounting','messaging','reviews')` (§36 Delta 2), `provider_type TEXT`, `region TEXT`, `oauth_token_ciphertext BYTEA`, `secret_ref TEXT`, `health_state TEXT`, `rec_eligibility TEXT`, `last_success_at TIMESTAMPTZ`, `freshness_lag_seconds BIGINT`, `settlement_capable BOOL` | `connector_id`; UNIQUE `(brand_id, connector_type, display_name)` | RLS on `brand_id` (NN-1 two-arg) |
| `sync_cursor` | Per-connector stream cursors for incremental sync and backfill lanes | `connector_id FK`, `brand_id`, `stream TEXT`, `cursor_value TEXT`, `lane TEXT CHECK IN ('live','backfill')`, `late_repull_until TIMESTAMPTZ`, `updated_at TIMESTAMPTZ` | `(connector_id, stream, lane)` | RLS on `brand_id` |

#### Identity (migration 0004)

These tables are the identity graph — the highest-correctness section (doc 08 §6). History is never rewritten; merges re-point via bitemporal alias.

| Table | Purpose | Key Columns | PK | Isolation |
|---|---|---|---|---|
| `customer` | The resolved customer node (canonical `brain_id`) | `brand_id`, `brain_id UUID`, `anonymous_id TEXT`, `merged_into UUID NULL`, `lifecycle_state TEXT CHECK IN ('anonymous','active','merged','split','erased')`, `ai_processing_consent BOOL`, `resolution_consent BOOL` | `(brand_id, brain_id)` | RLS on `brand_id` (NN-1) |
| `identity_link` | Hashed identifiers linked to a `brain_id` — append-only, no raw PII | `brand_id`, `link_id UUID`, `brain_id FK`, `identifier_type TEXT` (email, phone, storefront_customer_id, auth_user_id, fp_cookie, device_id, ip, ua, brain_anon_id, etc.), `identifier_value TEXT` (sha256 hash only — never raw), `tier TEXT CHECK IN ('strong','strong_on_link','medium','weak')`, `is_active BOOL` | `(brand_id, link_id)`; UNIQUE PARTIAL `(brand_id, identifier_type, identifier_value)` WHERE `is_active AND tier IN ('strong','strong_on_link')` | RLS on `brand_id`; INSERT+SELECT only for `brain_app` (append-only) |
| `brain_id_alias` | Bitemporal merge re-pointer — history never rewritten | `brand_id`, `alias_id UUID`, `observed_brain_id UUID`, `canonical_brain_id UUID`, `valid_from TIMESTAMPTZ`, `valid_to TIMESTAMPTZ NULL`, `rule_version TEXT`, `merge_id UUID` | `(brand_id, alias_id)`; UNIQUE PARTIAL `(brand_id, observed_brain_id)` WHERE `valid_to IS NULL` | RLS on `brand_id` |
| `identity_merge_event` | Immutable merge audit record | `merge_id UUID`, `brand_id`, `canonical_brain_id`, `merged_brain_id`, `rule_version`, `identifier_combo TEXT[]`, `confidence TEXT`, `identity_snapshot_id UUID`, `committed_by`, `committed_at TIMESTAMPTZ` | `merge_id` | RLS on `brand_id`; INSERT+SELECT only |
| `merge_rule` | Configurable merge rules (versioned) | `rule_id`, `version INT`, `brand_id NULL` (NULL = global default), `identifier_combo TEXT[]`, `action TEXT CHECK IN ('merge','review','never')`, `guard TEXT`, `precedence INT`, `effective_from`, `effective_to` | `(rule_id, version)` | No brand RLS (global rules have `brand_id=NULL`) |
| `merge_review_queue` | Conflicts requiring human review | `brand_id`, `review_id UUID`, `brain_id_a UUID`, `brain_id_b UUID`, `trigger_reason TEXT`, `evidence JSONB` (hashed evidence — no PII), `status TEXT CHECK IN ('pending','merged','rejected','expired')` | `(brand_id, review_id)` | RLS on `brand_id` |
| `shared_utility_identifier` | COD/kiosk/courier phones suppressed from merge | `brand_id`, `identifier_type TEXT`, `identifier_value TEXT`, `profile_count INT`, `flagged_at TIMESTAMPTZ`, `reason TEXT` | `(brand_id, identifier_type, identifier_value)` | RLS on `brand_id` |
| `consent_record` | Per-brain-id consent history — append-only | `brand_id`, `brain_id`, `category TEXT CHECK IN ('analytics','marketing','personalization','ai_processing')`, `state TEXT CHECK IN ('granted','withdrawn','never')`, `source TEXT`, `consent_snapshot_id UUID`, `effective_at TIMESTAMPTZ` | `(brand_id, brain_id, category, effective_at)` | RLS on `brand_id`; INSERT+SELECT only |
| `contact_pii` | KMS-encrypted PII vault — vault-only, never in marts | `brand_id`, `brain_id`, `pii_type TEXT`, `pii_ciphertext BYTEA`, `kms_key_id TEXT`, `identifier_hash TEXT` | `(brand_id, brain_id, pii_type)` | RLS: additionally requires `app.role = 'send_service'`; most tight policy in the system |
| `identity_audit` | Append-only identity action log | `brand_id`, `audit_id UUID`, `brain_id`, `action TEXT CHECK IN ('mint','link','merge','unmerge','rebind','erase')`, `merge_id UUID NULL`, `detail JSONB`, `occurred_at TIMESTAMPTZ` | `(brand_id, audit_id)` | RLS on `brand_id`; INSERT+SELECT only |

#### FX Rate + Cost Inputs (migration 0005)

| Table | Purpose | Key Columns | PK | Isolation |
|---|---|---|---|---|
| `fx_rate` | Realization-date FX rates — global reference data | `fx_rate_id UUID`, `currency_from CHAR(3)`, `currency_to CHAR(3)`, `rate_date DATE`, `rate NUMERIC(18,8)`, `source TEXT`, `fetched_at TIMESTAMPTZ` | `fx_rate_id`; UNIQUE `(currency_from, currency_to, rate_date, source)` | Global (no RLS) — seeded with INR, AED, SAR rates |
| `cost_input` | Per-brand cost structure (global/sku/channel/category/order_type) | `brand_id`, `cost_input_id UUID`, `scope TEXT CHECK IN ('global','sku','category','channel','order_type')`, `scope_ref TEXT`, `cost_type TEXT`, `amount_minor BIGINT NULL`, `pct_bps INT NULL`, `currency_code CHAR(3)`, `cost_confidence TEXT CHECK IN ('Trusted','Estimated','Insufficient')`, `effective_from DATE`, `effective_to DATE NULL` | `(brand_id, cost_input_id)` | RLS on `brand_id` |

#### Metric Registry (migration 0005, same migration as FX)

| Table | Purpose | Key Columns | PK | Isolation |
|---|---|---|---|---|
| `metric_definition` | Versioned metric registry — global; the TypeScript engine interprets, SQL never computes | `metric_id TEXT`, `version INT`, `display_name TEXT`, `unit TEXT CHECK IN ('minor_currency','ratio','pct','count')`, `formula_spec JSONB`, `inputs TEXT[]`, `maturity_required BOOL`, `cost_confidence_floor TEXT`, `is_active BOOL`, `effective_from DATE` | `(metric_id, version)` | Global (no RLS) |
| `metric_dependency` | Metric-to-metric dependency graph | `metric_id`, `version`, `depends_on_metric_id`, `depends_on_version` | `(metric_id, version, depends_on_metric_id)` | Global |
| `metric_test` | Golden fixture rows for the parity oracle | `test_id UUID`, `metric_id`, `version`, `golden_input JSONB`, `expected_output JSONB` | `test_id` | Global |
| `metric_audit` | Change log for metric definitions | `metric_id`, `version`, `changed_by`, `change_reason TEXT`, `changed_at TIMESTAMPTZ` | `(metric_id, version, changed_at)` | Global |

#### Realized-Revenue Ledger (migration 0006) — THE M1 STAR

| Table | Purpose | Key Columns | PK | Isolation |
|---|---|---|---|---|
| `realized_revenue_ledger` | The single append-only financial SoR for realized revenue. Every economic effect is a new signed row — the sale row is NEVER mutated. | `brand_id`, `ledger_event_id TEXT` (deterministic = `hash(order_id \|\| event_type \|\| source_pk \|\| version)` — idempotent on replay), `order_id TEXT`, `brain_id UUID NULL`, `event_type TEXT CHECK IN ('provisional_recognition','finalization','rto_reversal','refund','chargeback','cancellation','settlement_fee_reversal','marketplace_adjustment','payment_adjustment','concession')`, `amount_minor BIGINT` (signed; reversals negative), `currency_code CHAR(3)`, `fx_rate_id UUID`, `economic_effective_at TIMESTAMPTZ` (drives attribution + CM2 as-of math), `billing_posted_period DATE` (the OPEN period a late adjustment posts to; closed periods immutable), `recognition_label TEXT CHECK IN ('provisional','settling','finalized')`, `supersedes_ledger_event_id TEXT NULL`, `settlement_source TEXT`, `maturity_state TEXT`, `ledger_snapshot_id TEXT`, `raw_event_id TEXT`, `created_at TIMESTAMPTZ` | `(brand_id, ledger_event_id)` | RLS on `brand_id`; INSERT+SELECT only for `brain_app` — NO UPDATE, NO DELETE at the GRANT level |

Partition: by `economic_effective_at` month (to bound as-of scan cost as the ledger grows unbounded over time). Index on `(brand_id, order_id)` for order-to-ledger join. Index on `(brand_id, billing_posted_period)` for billing reads.

NOTE — `attribution_credit_ledger` is M3, not M1. The M1 spine only needs the realized-revenue ledger. Attribution is blocked until identity reconciles (doc 10 §9). The table is modeled in doc 08 §7.2 and is referenced here only to confirm its deferral.

#### Existing Sprint-0 Tables (migration 0001 — NOT YET APPLIED)

| Table | Status | Notes |
|---|---|---|
| `audit_log` | Exists in 0001_init.sql — authored, not applied | Hash-chained, WORM-anchored, cross-brand (brand_id nullable for system actions). INSERT+SELECT only for `brain_app`. RLS intentionally disabled. |
| `brand_keyring` | Exists in 0001_init.sql — authored, not applied | Per-brand wrapped DEK. `brain_app` has SELECT only. Written by key-management job only. RLS disabled (key-mgmt job needs cross-brand writes). |
| `_rls_demo` | Exists in 0001_init.sql — isolation-fuzz test stub | Dropped or retained for CI only; not a business table. |

#### Deferred to M2 / M3+ (not in M1)

- `subscription`, `plan`, `gmv_meter_snapshot`, `invoice`, `invoice_line`, `billing_adjustment`, `entitlement`, `dunning_state`, `payment_method`, `payment` (billing tables) — **M2**
- `goal`, `dq_grade`, `dq_signal`, `feature_flag`, `feature_flag_override` — **M2**
- `attribution_credit_ledger` — **M3**
- `decision_log`, `recommendation`, `recommendation_outcome`, `ai_provenance`, `mcp_key`, `notification`, `notification_pref` — **M3/M4**
- `survey_responses`, `silver.touchpoint` — **M3**
- Reserved domains (§36): `chart_of_accounts`, `ledger_transactions`, `bills`, `accounting_invoices`, `tax_ledger`, `marketplace_fees`, `messaging_events`, `reviews`, `capi_dispatch_log` — **Phase 2+; built none in Phase 1**

### 3.2 Iceberg Bronze

One-way flow: events land in Bronze first. Append-only, replay SoR.

#### `bronze.collection_event` (rename of the Sprint-0 `brain_bronze.collector_events`)

The Sprint-0 table covers the browser/pixel event family. M1 keeps this schema (it already has the correct partition spec and additive-only evolution policy) and extends via additive nullable columns only.

| Column | Type | Notes |
|---|---|---|
| `event_id` | STRING NOT NULL | UUID v7 idempotency key component |
| `brand_id` | STRING NOT NULL | Tenant key — partition bucket source |
| `occurred_at` | TIMESTAMPTZ NOT NULL | Event time; partition `days()` source |
| `ingested_at` | TIMESTAMPTZ NOT NULL | Collector spool time; watermark anchor |
| `schema_name` | STRING NOT NULL | Apicurio artifact ID |
| `schema_version` | INT NOT NULL | Apicurio schema version |
| `event_type` | STRING NOT NULL | Semantic event type (page_view, order_placed, etc.) |
| `correlation_id` | STRING NOT NULL | Distributed trace ID |
| `partition_key` | STRING NOT NULL | `brand_id:event_id` — for log correlation |
| `payload` | STRING NOT NULL | JSON-encoded body — no raw PII (I-S02) |
| `processing_flags` | STRING | Optional stream-worker metadata; nullable |
| `collector_version` | STRING | Optional; nullable |

Partition spec (fixed at creation — non-retrofittable): `bucket(16, brand_id) + days(occurred_at)`.

#### `bronze.connector_order` (NEW for M1)

Landing table for Shopify order webhook events. The provenance envelope (doc 07 §4 + doc 08 §36/§37) is carried on every row. No raw PII in payload — all customer identifiers are hashed before landing.

| Column Group | Columns |
|---|---|
| Envelope | `event_id STRING NOT NULL`, `brand_id STRING NOT NULL`, `occurred_at TIMESTAMPTZ NOT NULL`, `ingested_at TIMESTAMPTZ NOT NULL`, `schema_name STRING NOT NULL`, `schema_version INT NOT NULL`, `correlation_id STRING NOT NULL`, `connector_id STRING NOT NULL`, `source_system TEXT` (e.g. `shopify`), `source_object_id TEXT` (Shopify order GID), `source_created_at TIMESTAMPTZ`, `source_updated_at TIMESTAMPTZ`, `sync_batch_id TEXT`, `dedup_key TEXT` (`brand_id:source_object_id:event_type`) |
| Region / currency | `region TEXT` (`IN\|AE\|SA`), `transaction_currency CHAR(3)`, `reporting_currency_value_minor BIGINT NULL` (normalized to brand reporting currency via fx_rate) |
| Payload | `payload STRING NOT NULL` — JSON of the canonical connector order event body; no raw PII |
| Evolution-safe | `processing_flags STRING NULL`, `schema_evolution_version INT NULL` |

Partition spec: `bucket(16, brand_id) + days(occurred_at)`. Same as collection_event.

Table properties: format-version=2, parquet/zstd, target-file-size=128 MB, 24-month retention, `write.upsert.enabled=false` (append-only; idempotency via MERGE on `(brand_id, event_id)` in the stream-worker).

Both Bronze tables are registered via the Iceberg REST catalog (Nessie locally; AWS Glue in production). Schema evolution is additive-optional only (never drop/rename/type-change a column — I-E02).

### 3.3 StarRocks Silver + Gold

Built by dbt-on-StarRocks over Bronze. NOT a System of Record. Fully rebuildable. Every table has a row policy applied at creation time (template in `db/starrocks/row_policy_template.sql`).

**Row policy pattern (applied to every table):**
```sql
CREATE ROW POLICY IF NOT EXISTS tenant_isolation_policy
  ON brain_silver.<table_name>
  TO 'brain_analytics'@'%'
  USING (brand_id = IFNULL(NULLIF(SESSION_VALUE('brain_current_brand_id'), ''),
                            '00000000-0000-0000-0000-000000000000'));
```

#### Silver Tables (M1)

| Table | Key Columns | PK | Distribution | Row Policy | Status |
|---|---|---|---|---|---|
| `brain_silver.order_state` | `brand_id VARCHAR(36)`, `order_id VARCHAR(128)`, `order_name TEXT`, `customer_id TEXT`, `email_hash TEXT`, `phone_hash TEXT`, `financial_status TEXT`, `fulfillment_status TEXT`, `order_status TEXT` (canonical), `payment_provider TEXT`, `provider_type TEXT`, `is_cod BOOL`, `currency_code CHAR(3)`, `subtotal_minor BIGINT`, `total_discounts_minor BIGINT`, `total_tax_minor BIGINT`, `tax_regime TEXT`, `total_shipping_minor BIGINT`, `total_price_minor BIGINT`, `source_name TEXT`, `channel TEXT`, `ship_country TEXT`, `ship_state_or_emirate TEXT`, `ship_city TEXT`, `ship_postcode TEXT`, `cart_attr_brain_anon_id TEXT`, `cart_attr_click_ids JSON`, `cart_attr_first_utms JSON` (§35 stitch), `settled_status TEXT`, `net_realized_value_minor BIGINT`, `recognition_label TEXT`, `is_new_customer BOOL`, `observed_brain_id VARCHAR(36)`, `raw_event_id TEXT`, `created_at DATETIME`, `updated_at DATETIME` | `PRIMARY KEY (brand_id, order_id)` | `DISTRIBUTED BY HASH(brand_id, order_id) BUCKETS 8` | `tenant_isolation_policy` | NEW for M1 |
| `brain_silver.customer` | `brand_id VARCHAR(36)`, `brain_id VARCHAR(36)`, `customer_id TEXT`, `email_hash TEXT`, `phone_hash TEXT`, `first_order_at DATETIME`, `orders_count INT`, `total_spent_minor BIGINT`, `aov_minor BIGINT`, `acquisition_channel TEXT`, `acquisition_cohort TEXT`, `accepts_email BOOL`, `accepts_sms BOOL`, `country TEXT`, `identity_confidence TEXT`, `completeness DECIMAL(5,2)`, `created_at DATETIME`, `updated_at DATETIME` | `PRIMARY KEY (brand_id, brain_id)` | `DISTRIBUTED BY HASH(brand_id, brain_id) BUCKETS 8` | `tenant_isolation_policy` | NEW for M1 |
| `brain_silver.behavior_event` | `brand_id VARCHAR(36)`, `event_id VARCHAR(128)`, `event_name TEXT`, `brain_anon_id TEXT`, `brain_session_id TEXT`, `observed_brain_id VARCHAR(36)`, `occurred_at DATETIME`, `page_url TEXT`, `referrer TEXT`, `utm_source TEXT`, `utm_medium TEXT`, `utm_campaign TEXT`, `utm_content TEXT`, `utm_term TEXT`, `click_ids JSON`, `fbp TEXT`, `fbc TEXT`, `ga_client_id TEXT`, `device_type TEXT`, `os TEXT`, `browser TEXT`, `ip_hash TEXT`, `geo_country TEXT`, `geo_region TEXT`, `geo_city TEXT`, `consent_state JSON`, `product_id TEXT`, `currency_code CHAR(3)`, `price_minor BIGINT`, `channel TEXT`, `dedup_state TEXT`, `identity_state TEXT`, `raw_event_id TEXT`, `created_at DATETIME` | `PRIMARY KEY (brand_id, event_id)` | `DISTRIBUTED BY HASH(brand_id, event_id) BUCKETS 8` | `tenant_isolation_policy` | NEW for M1 |

M1 scope deliberately limits Silver to the three tables required for the spine: order lifecycle, customer rollup, and behavioral events. The following Silver tables from doc 08 §11/§37 are DEFERRED:

- `silver.order_line_item`, `silver.order_status_history`, `silver.refund` — M2 (needed for True CM2)
- `silver.payment`, `silver.settlement` — M2 (needed for Razorpay settlement + billing)
- `silver.shipment`, `silver.shipment_tracking_event` — M3 (needed for RTO / logistics)
- `silver.marketing_spend`, `silver.ad_account`, `silver.ad_campaign`, `silver.ad_set`, `silver.ad_creative` — M1 (Meta connector is M1); included only for Meta spend attribution; the full field-complete set per §37.3 is M2
- `silver.product`, `silver.product_variant`, `silver.inventory_level` — M2
- `silver.touchpoint` — M3
- `silver.support` — M3
- `silver.identity_projection` — M2

#### Gold Tables (M1)

| Table | Key Columns | Key Type | Distribution | Row Policy | Status |
|---|---|---|---|---|---|
| `brain_gold.realized_revenue_ledger` | Mirror of Postgres `realized_revenue_ledger`: `brand_id`, `ledger_event_id TEXT`, `order_id TEXT`, `brain_id TEXT NULL`, `event_type TEXT`, `amount_minor BIGINT`, `currency_code CHAR(3)`, `fx_rate_id TEXT`, `economic_effective_at DATETIME`, `billing_posted_period DATE`, `recognition_label TEXT`, `supersedes_ledger_event_id TEXT NULL`, `raw_event_id TEXT`, `created_at DATETIME` | `DUPLICATE KEY (brand_id, ledger_event_id)` — append-only mirror; no upsert | `DISTRIBUTED BY HASH(brand_id, ledger_event_id) BUCKETS 8` | `tenant_isolation_policy` | NEW for M1 |
| `brain_gold.order_margin_fact` | `brand_id`, `order_id TEXT`, `net_revenue_minor BIGINT`, `cogs_minor BIGINT NULL`, `forward_shipping_minor BIGINT NULL`, `cod_fee_minor BIGINT NULL`, `packaging_minor BIGINT NULL`, `marketplace_fee_minor BIGINT NULL`, `return_cost_minor BIGINT NULL`, `concession_minor BIGINT NULL`, `payment_fee_minor BIGINT NULL`, `marketing_minor BIGINT NULL`, `cost_confidence TEXT`, `currency_code CHAR(3)`, `channel TEXT`, `campaign_id TEXT`, `region TEXT`, `payment_method TEXT`, `is_new_customer BOOL`, `updated_at DATETIME` | `PRIMARY KEY (brand_id, order_id)` — upsert as cost components are updated | `DISTRIBUTED BY HASH(brand_id, order_id) BUCKETS 8` | `tenant_isolation_policy` | NEW for M1 (thin — cogs/shipping populated as connectors arrive) |

DEFERRED Gold tables (not M1):
- `gold.attribution_credit_ledger` — M3
- `gold.channel_contribution` — M3
- `gold.attribution_confidence_mart` — M3
- `gold.attribution_model_credit`, `gold.attribution_triangulation` — M3
- `gold.customer_360` — M2

### 3.4 dbt Models — M1 Spine

The one-way rule: Iceberg → dbt → StarRocks → Analytics API. Never reverse. The dbt project (`db/dbt/`) already has the layer skeleton (`staging: view`, `intermediate: view`, `marts: table`).

M1 adds these model files (creating the `intermediate/` and `marts/` layer directories):

**Staging layer (1:1 Bronze dedup + contract validation):**
```
models/staging/
  stg_bronze__collection_event.sql    -- dedup on (brand_id, event_id); watermark validation
  stg_bronze__connector_order.sql     -- dedup on (brand_id, dedup_key); envelope validation
  _sources.yml                        -- Bronze external catalog source definitions
  _models.yml                         -- column-level tests: not_null, unique, accepted_values
```

**Intermediate layer (normalize + identity projection):**
```
models/intermediate/
  int_order_canonical.sql             -- canonical order fields; stitch attrs; tax_regime; settled_status
  int_customer_rollup.sql             -- per-brain_id aggregates from orders; RFM inputs
  int_behavior_deduplicated.sql       -- dedup + session attribution; consent filter
```

**Marts layer (Silver + Gold materializations):**
```
models/marts/silver/
  silver_order_state.sql              -- materializes brain_silver.order_state (PK upsert)
  silver_customer.sql                 -- materializes brain_silver.customer (PK upsert)
  silver_behavior_event.sql           -- materializes brain_silver.behavior_event (PK upsert)

models/marts/gold/
  gold_realized_revenue_ledger.sql    -- append-only mirror from Postgres ledger via connector
  gold_order_margin_fact.sql          -- cost component rollup (thin for M1; extended in M2)
```

**dbt tests (in `_models.yml` per layer):**
- Staging: `unique(brand_id + event_id)`, `not_null(brand_id, event_id, occurred_at)`, `accepted_values(event_type)`, freshness check vs `ingested_at`
- Intermediate: `not_null(brand_id, order_id)`, referential integrity `order_id` in canonical orders
- Silver/Gold: `unique(brand_id, order_id)` on order_state and order_margin_fact, `not_null(amount_minor, currency_code)` on ledger rows, row-count drift check (±3σ vs trailing 30d — the data-quality `data-quality` skill §2)
- Parity oracle: a separate `tests/parity/` folder with golden-fixture SQL tests that assert the TypeScript metric engine and the dbt aggregation agree on `realized_revenue` for a set of pinned golden orders (the CI-blocking gate per doc 10 §8)

---

## 4. Seed / Reference Values

Seeds are idempotent and brand-scoped. All seed logic lives in `tools/seed/seed.mjs`. Seeds are gated by environment: reference data seeds run in all envs; demo/dev seeds run only when `NODE_ENV !== 'production'`.

### 4.1 Reference Data (all environments — idempotent `INSERT ... ON CONFLICT DO NOTHING`)

**RBAC Roles (4 fixed roles):**
| `role_code` | `level` | `display_name` |
|---|---|---|
| `owner` | 1 | Owner |
| `brand_admin` | 2 | Brand Admin |
| `manager` | 3 | Manager |
| `analyst` | 4 | Analyst |

**Metric Registry Definitions (realized_revenue and its direct dependencies):**
| `metric_id` | `version` | `display_name` | `unit` | `formula_spec` (declarative AST — engine interprets) |
|---|---|---|---|---|
| `realized_revenue` | 1 | Realized Revenue | `minor_currency` | `{type: "ledger_sum", event_types: ["finalization"], filter: "recognition_label='finalized'"}` |
| `provisional_revenue` | 1 | Provisional Revenue | `minor_currency` | `{type: "ledger_sum", event_types: ["provisional_recognition"], filter: "recognition_label='provisional'"}` |
| `gross_revenue` | 1 | Gross Revenue | `minor_currency` | `{type: "order_sum", field: "total_price_minor"}` |
| `order_count` | 1 | Order Count | `count` | `{type: "order_count"}` |
| `aov` | 1 | Average Order Value | `minor_currency` | `{type: "ratio", numerator: "gross_revenue", denominator: "order_count"}` |

Each metric row also gets a `metric_test` golden fixture row (the parity oracle harness reads these; CI blocks if the engine output does not match `expected_output`).

**FX Rate Seeds (INR, AED, SAR — development baselines):**
| `currency_from` | `currency_to` | `rate` | `source` | `rate_date` |
|---|---|---|---|---|
| `INR` | `USD` | `0.01190000` | `seed` | `2026-06-01` |
| `AED` | `USD` | `0.27230000` | `seed` | `2026-06-01` |
| `SAR` | `USD` | `0.26670000` | `seed` | `2026-06-01` |
| `USD` | `INR` | `84.05000000` | `seed` | `2026-06-01` |

(Production rates are fetched by the FX rate job; seed rows are for dev-baseline and the parity oracle golden fixture only.)

**Tax Regime Enum Values** (CHECK constraint values on `brand.tax_regime` and `connector_instance.region`-related fields):
`GST_IN`, `VAT_AE_5`, `VAT_SA_15` (full set per doc 08 §36 Delta 1; GCC values are modeled now, GTM Phase 5)

### 4.2 Demo / Dev Seeds (dev + staging only — gated by `NODE_ENV !== 'production'`)

**Design-Partner Organisation + Brand (Sugandh Lok — the M1 POC, doc 10 §15):**
| Field | Value |
|---|---|
| `organization.legal_name` | `Sugandh Lok Aromas Private Limited` |
| `organization.billing_country` | `IN` |
| `organization.region` | `IN` |
| `brand.display_name` | `Sugandh Lok` |
| `brand.slug` | `sugandh-lok` |
| `brand.base_currency` | `INR` |
| `brand.timezone` | `Asia/Kolkata` |
| `brand.region` | `IN` |
| `brand.tax_regime` | `GST_IN` |
| `brand.revenue_definition` | `realized` |
| `brand.status` | `onboarding` |

**Per-Brand KMS Keyring Row** (`brand_keyring`): a dev-mode wrapped DEK row for the demo brand; `kms_key_id = 'alias/brain-dev-cmk'`; `wrapped_dek_b64` set to a local dev value (never a real production key); `key_version = 1`.

**Golden Fixture Orders for the Parity Oracle**: 5 seed orders in `bronze.connector_order` + corresponding `realized_revenue_ledger` rows whose `amount_minor` values are pinned so the TypeScript metric engine and the dbt aggregation must agree exactly. These rows carry `brand_id = <sugandh-lok-brand-id>` and serve as the M1 `metric_test` golden inputs.

**Connector Instance Seed**: a Shopify connector row for the demo brand (`connector_type = 'shopify'`, `category = 'storefront'`, `health_state = 'disconnected'` — placeholder until OAuth is completed in the integration flow).

---

## 5. Migration Plan & Ordering

### 5.1 PostgreSQL — node-pg-migrate

Tool: `node-pg-migrate` (configured in `packages/db`). Migration files live in `db/migrations/`. Each file is numbered sequentially. All migrations are:
- Additive-only (no DROP, no ALTER TYPE to incompatible, no TRUNCATE — I-E02)
- RLS-aware: every new brand-scoped table gets `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, and the `CREATE POLICY tenant_isolation` with the NN-1 two-arg predicate
- Grant-explicit: `brain_app` is granted only the minimum (SELECT + INSERT for append-only tables; SELECT + INSERT + UPDATE + DELETE for mutable tables; SELECT-only for config tables)
- Non-destructive: corrections are new rows or new columns; old columns are never dropped in Phase 1

**The `pnpm migrate` command** — currently MISSING; this is an explicit M1 Sprint-task. It must wire `node-pg-migrate up` with `--database-url $DATABASE_URL --migrations-dir db/migrations`. The CI gate runs `pnpm migrate` on a fresh database after every PR that touches `db/migrations/`.

| # | Migration File | Content | New Tables | Depends On |
|---|---|---|---|---|
| 0001 | `0001_init.sql` (exists — authored Sprint-0) | `brain_app` non-owner role + BYPASSRLS assertion; `audit_log` (hash-chained); `brand_keyring` (SELECT-only for `brain_app`); `_rls_demo` (isolation fuzz stub); NN-1 assertion | `audit_log`, `brand_keyring`, `_rls_demo` | None — this is the bootstrap |
| 0002 | `0002_workspace_access.sql` (NEW M1) | `organization`, `brand` (with `tax_regime`, `region`, `kms_key_arn`, `identity_salt_ciphertext`), `app_user`, `role`, `permission`, `role_permission`, `membership`, `invite`, `session`; RLS on `brand` + `membership` + `invite`; GRANTs; `role` reference data (4 rows) | 9 tables | 0001 (role requires `brain_app` to exist) |
| 0003 | `0003_connector_instance.sql` (NEW M1) | `connector_instance` (with `category`, `provider_type`, `region` per §36 Delta 2), `sync_cursor`; RLS + GRANTs on both | 2 tables | 0002 (`brand` FK) |
| 0004 | `0004_identity_consent_pii_vault.sql` (NEW M1) | `customer`, `identity_link`, `brain_id_alias`, `identity_merge_event`, `merge_rule`, `merge_review_queue`, `shared_utility_identifier`, `consent_record`, `consent_tombstone`, `contact_pii` (vault — double RLS), `pii_erasure_log`, `identity_audit`; RLS + GRANTs (append-only INSERT+SELECT for `identity_link`, `brain_id_alias`, `consent_record`, `identity_merge_event`, `identity_audit`); `contact_pii` requires `app.role = 'send_service'` in addition to `brand_id` | 12 tables | 0002 (`brand` FK on `customer`, `consent_record`), 0001 (`audit_log`) |
| 0005 | `0005_fx_rate_cost_input_metric_registry.sql` (NEW M1) | `fx_rate` (global, no RLS), `cost_input` (brand-scoped, RLS), `metric_definition`, `metric_dependency`, `metric_test`, `metric_audit` (all global, no RLS); FX rate dev-baseline seed rows; metric registry seed rows for `realized_revenue` and dependencies; metric golden fixture rows | 6 tables | 0002 (`brand` FK on `cost_input`) |
| 0006 | `0006_realized_revenue_ledger.sql` (NEW M1) | `realized_revenue_ledger`; partition index on `(brand_id, economic_effective_at)`; index on `(brand_id, order_id)`; index on `(brand_id, billing_posted_period)`; RLS (NN-1 two-arg); GRANT INSERT + SELECT to `brain_app` (NO UPDATE, NO DELETE — append-only enforced at grant level) | 1 table | 0004 (`customer.brain_id` referenced), 0005 (`fx_rate_id` FK) |
| 0007 (FUTURE) | `0007_survey_responses.sql` | `survey_responses` (Postgres-resident per §35) — M3 | 1 table | 0004 |

**Each migration ships with an isolation negative-test**: a SQL assertion that runs after the migration and verifies that querying the new brand-scoped table without setting `app.current_brand_id` returns zero rows (not an error). The test is a DO block that sets `app.current_brand_id` to a brand UUID that has no rows, executes a SELECT, and asserts COUNT = 0.

**Isolation rule for `brain_app` (re-stated for every migration author):**
- `brain_app` NEVER owns any table (owner is the migration runner role)
- `brain_app` NEVER gets `BYPASSRLS`
- `brain_app` NEVER gets DDL permissions
- Every brand-scoped table gets both `ENABLE ROW LEVEL SECURITY` AND `FORCE ROW LEVEL SECURITY` (FORCE makes RLS apply even to the table owner when connecting as owner — belt-and-suspenders)

### 5.2 Iceberg Bronze

Tool: Iceberg REST catalog (Nessie locally; AWS Glue in production). Tables are registered via REST API or Spark/SQL over the catalog.

**Creation sequence:**
1. Ensure namespace `brain_bronze` exists (`CREATE NAMESPACE IF NOT EXISTS brain_bronze`)
2. Create `brain_bronze.collection_event` — already in `db/iceberg/bronze_table.sql`; verify it exists and partition spec matches `bronze_spec.json` before M1 proceeds
3. Create `brain_bronze.connector_order` — NEW for M1; follows the same partition spec (`bucket(16, brand_id) + days(occurred_at)`) and table properties as `collection_event`; schema carries the provenance envelope + regional fields

**Schema evolution rules (I-E02):**
- New columns MUST be optional (nullable) with a default — never required
- No column renames, drops, or type changes to incompatible types
- Partition spec is fixed at creation; if a bucket count change is needed, use Iceberg partition evolution (creates a new partition spec version, old data stays on old spec — additive)

**Maintenance jobs (M1 Sprint-tasks for Argo):**
- Weekly compaction + snapshot-expiry job for both Bronze tables (small-file mitigation + 24-month retention enforcement)
- Erasure-aware compaction path: when `brand_keyring.is_active = false`, the compaction job rewrites the affected partitions (crypto-shredded data is not resurrected from old snapshots)

### 5.3 StarRocks Silver + Gold

Tool: dbt-on-StarRocks (for mart DDL and incremental loads) + bootstrap SQL (for catalog, databases, users, row policies).

**Bootstrap sequence (M1 — applied on managed/production StarRocks):**
1. `db/starrocks/bootstrap.sql` is already applied in dev (creates `brain_silver`, `brain_gold`, `brain_analytics` user, `isolation_test`, `brain_bronze_local` catalog). In production, apply the equivalent with real credentials.
2. Apply `db/starrocks/external_iceberg_catalog.sql` for the production Glue-backed catalog (`brain_bronze_prod`)
3. Create each Silver/Gold table via the dbt run (dbt generates the DDL from model definitions) or explicit DDL following the `silver_template.sql` invariants
4. Apply row policies on each Silver + Gold table immediately after creation (enterprise cluster required for `CREATE ROW POLICY`; `row_policy_template.sql` has the exact syntax)

**DDL invariants per table (enforced in `silver_template.sql`):**
- `brand_id VARCHAR(36) NOT NULL` as the first column
- `PRIMARY KEY (brand_id, <high-card key>)` for upsert-capable Silver tables
- `DUPLICATE KEY (brand_id, <id>)` for append-only Gold tables
- `DISTRIBUTED BY HASH(brand_id, <high-card key>) BUCKETS 8`
- `PROPERTIES ("enable_persistent_index"="true", "compression"="LZ4", "replication_num"="3")` (dev: `replication_num=1`)
- Row policy applied immediately after CREATE TABLE

**M1 table creation order (StarRocks):**
1. `brain_silver.isolation_test` — already exists in dev
2. `brain_silver.order_state` + row policy
3. `brain_silver.customer` + row policy
4. `brain_silver.behavior_event` + row policy
5. `brain_gold.realized_revenue_ledger` + row policy
6. `brain_gold.order_margin_fact` + row policy

### 5.4 dbt — Run Order

dbt runs in the one-way direction only: Bronze (external catalog) → staging models → intermediate models → Silver marts → Gold marts. The Analytics API reads Gold/Silver via StarRocks; it never writes back.

**M1 dbt run order:**
1. `dbt source freshness` — assert Bronze tables are fresh before any model run (block if stale beyond threshold)
2. `dbt run --select staging.*` — create/refresh staging views (dedup + contract validation)
3. `dbt test --select staging.*` — run not_null, unique, accepted_values tests on staging; block on failure
4. `dbt run --select intermediate.*` — normalize + identity project
5. `dbt run --select marts.silver.*` — write Silver PK tables (incremental by `occurred_at` for events; full-refresh for rebuild)
6. `dbt test --select marts.silver.*` — row-count drift, null-rate, uniqueness
7. `dbt run --select marts.gold.*` — write Gold marts
8. `dbt test --select marts.gold.*` — parity assertions + row-count drift
9. `dbt run --select tests/parity/*` — golden-fixture parity oracle (CI-blocking gate)

**Freshness SLA for M1 (doc 08 §28):**
- Bronze: ingest p99 ≤ 1 min (enforced by collector accept+ack SLA)
- Silver `order_state`: stale after 5 min from event
- Gold `realized_revenue_ledger`: provisional recognition ≤ 5 min from order event

### 5.5 Cross-Store Critical Path (Dependency-Ordered)

```
Step 1  POSTGRES: Apply 0001_init.sql (RLS + brain_app role + audit_log + brand_keyring)
        ↓
Step 2  POSTGRES: Apply 0002_workspace_access.sql (organization + brand + RBAC)
        + Seed: 4 roles + demo organization + demo brand (Sugandh Lok, region=IN, currency=INR,
                tax_regime=GST_IN, timezone=Asia/Kolkata)
        ↓
Step 3  POSTGRES: Apply 0003_connector_instance.sql (connector_instance + sync_cursor)
        + Seed: Shopify connector stub for demo brand
        ↓
Step 4  ICEBERG: Verify/create brain_bronze.collection_event; create brain_bronze.connector_order
        ↓
Step 5  POSTGRES: Apply 0004_identity_consent_pii_vault.sql (identity graph + PII vault)
        + Seed: brand_keyring row for demo brand
        ↓
Step 6  POSTGRES: Apply 0005_fx_rate_cost_input_metric_registry.sql
        + Seed: FX rates (INR/AED/SAR dev baseline) + metric registry definitions + metric_test
                golden fixtures
        ↓
Step 7  POSTGRES: Apply 0006_realized_revenue_ledger.sql
        + Seed: 5 golden fixture ledger rows for parity oracle
        ↓
Step 8  STARROCKS: Apply bootstrap (databases + user + external catalog) if not already done
        + Create Silver/Gold DDL + row policies (steps 2–6 in §5.3)
        ↓
Step 9  DBT: Run full M1 model DAG (§5.4 order); assert parity oracle green
        ↓
Step 10 CI GATE: isolation negative-test (brand-A query returns 0 rows from brand-B context)
                 + parity oracle (TypeScript metric engine == dbt aggregation on golden fixtures)
                 → HANDOFF GATE PASSES
```

### 5.6 How Migrations Run — Tooling Gap and CI Gate

**Current gap (M1 Sprint-task):** `pnpm migrate` does not yet exist. The command must be added to the root `package.json`:
```
"migrate": "node-pg-migrate up --database-url $DATABASE_URL --migrations-dir db/migrations --envPath .env"
```
And a `pnpm migrate:test` variant that points at a test database (`$TEST_DATABASE_URL`) for CI.

**CI gate (GitHub Actions):**
1. Spin up a fresh Postgres container (Testcontainers / docker-compose CI profile)
2. Run `pnpm migrate` — assert zero errors
3. Run the isolation negative-test: set `app.current_brand_id` to brand-A UUID; SELECT from every brand-scoped table with a WHERE for brand-B UUID; assert all return 0 rows
4. Run `pnpm migrate` again (idempotency check — must be a no-op)
5. Run dbt on the test Bronze data; run the parity oracle tests; assert CI green

**Replay / rebuild guarantee:** every Silver and Gold dataset can be rebuilt by running the full dbt pipeline over Bronze from the beginning. The Bronze tables are the replay SoR (doc 07 §9). The same dbt code path serves both live incremental runs and full historical backfills — there is no separate backfill codebase (anti-blind-spot per the Data Engineer role definition).

---

## 6. Guardrails & Invariants

These are non-negotiable; a PR that violates any of them is blocked.

| Invariant | Rule | Enforcement |
|---|---|---|
| **I-S01 — RLS everywhere** | Every brand-scoped table has `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + the `CREATE POLICY tenant_isolation` using the NN-1 two-arg predicate | Migration-time DO block assertion; CI isolation negative-test |
| **NN-1 — Two-arg predicate** | `current_setting('app.current_brand_id', TRUE)` — the TRUE (missing_ok) arg is mandatory. The one-arg form throws on a missing GUC; that exception can be swallowed by connection pools, silently returning all rows — a P0 cross-brand leak | Migration-time pg_policies scan asserts no one-arg form exists (already in 0001_init.sql) |
| **brain_app role** | Never owns tables, never gets BYPASSRLS, never gets DDL. Append-only tables (ledger, audit_log, identity_link, consent_record, identity_audit, identity_merge_event): INSERT + SELECT only — NO UPDATE, NO DELETE at the GRANT level | BYPASSRLS assertion in 0001_init.sql; per-migration REVOKE ALL + GRANT minimum |
| **I-S07 — Money minor-units** | All money columns: `*_minor BIGINT` + `currency_code CHAR(3)` paired. No floats for money, ever | Lint rule in packages/contracts; schema review |
| **No raw PII outside vault** | `contact_pii` is the only table with raw PII. All other tables store `sha256(per-brand-salt \|\| normalized value)` — hash only | No-PII lint; column classification tag; `contact_pii` double-RLS |
| **I-E02 — Additive-only migrations** | No DROP COLUMN, no RENAME COLUMN, no type change to incompatible type, no TRUNCATE in any migration | PR review gate; CI checks migration for banned keywords |
| **Contract-first** | Schema mirrors `packages/contracts` Zod definitions. No table ships before its contract is authored and codegen runs clean | CI codegen gate |
| **Isolation negative-test per migration** | Every migration that creates a brand-scoped table ships with an inline negative-test DO block | Migration authoring standard; CI runs the test |
| **Replayable** | Bronze is the replay SoR. The same dbt code serves live and backfill. No separate backfill codebase | Architecture review; dbt DAG has no branch for backfill mode |
| **Tenant-keyed end to end** | `brand_id` is the first column in every brand-scoped table (Postgres, StarRocks). It is the first component of every PK, distribution key, and partition bucket | Schema review; template enforcement |

---

## 7. Phasing — M1 vs Deferred

### M1 (Spine — this plan)
- Postgres control plane: organization, brand, app_user + RBAC, connector_instance + sync_cursor, identity graph (customer + identity_link + brain_id_alias + merge tables + consent + PII vault), fx_rate + cost_input + metric registry, realized_revenue_ledger, audit_log + brand_keyring
- Iceberg Bronze: collection_event + connector_order (Shopify)
- StarRocks Silver: order_state + customer + behavior_event
- StarRocks Gold: realized_revenue_ledger (mirror) + order_margin_fact (thin)
- dbt: staging → intermediate → Silver/Gold for the spine
- Seeds: 4 roles, demo org + brand (Sugandh Lok, IN/INR/GST_IN), FX baseline, metric registry (realized_revenue + deps), golden parity fixtures

### M2 (Measurement — not in this plan)
Billing tables (`subscription`, `plan`, `gmv_meter_snapshot`, `invoice`, `invoice_line`, `billing_adjustment`, `entitlement`, `dunning_state`), DQ grades + signals, feature flags + overrides, goals, Razorpay settlement connector, Silver: `order_line_item`, `order_status_history`, `refund`, `payment`, `settlement`, `product`, `product_variant`, `inventory_level`, `identity_projection`, Customer 360 (`gold.customer_360`), True CM2 cost components. Google Ads connector + marketing_spend Silver table.

### M3 (Attribution — not in this plan)
`attribution_credit_ledger` (Postgres SoR + Gold mirror), `survey_responses`, `silver.touchpoint`, `gold.channel_contribution`, `gold.attribution_confidence_mart`, `gold.attribution_model_credit`, `gold.attribution_triangulation`, Silver: `shipment`, `shipment_tracking_event`, `support`, `identity_projection`, MCP read-only.

### M4 (Decision Engine — not in this plan)
`decision_log`, `recommendation`, `recommendation_outcome`, `recommendation_feedback`, `recommendation_effectiveness`, `ai_provenance`, `mcp_key`, `notification`, `notification_pref`.

### Reserved Domains — Phase 2+ (modeled in doc 08 §36; built NONE in Phase 1)
`chart_of_accounts`, `ledger_transactions`, `bills`, `accounting_invoices`, `tax_ledger` (accounting/AICFO — Zoho/Tally adapters), `marketplace_fees` (Amazon/Noon), `messaging_events` (WhatsApp conversation pricing), `reviews`, `capi_dispatch_log`. None of these tables are created in M1. Their field-complete definitions exist in doc 08 §36 for when they are needed.

---

## Journal Entry

```markdown
## 2026-06-15T12:00:00Z — Data Engineer — M1-database-and-migration-plan
**Stage:** 3 · **Layer:** batch+lakehouse · **Tier:** deterministic
**Parity:** N/A (plan artifact, no compute) · **Replayable:** yes (Bronze SoR + same dbt path for live + backfill) · **Verification:** plan grounded in doc 08 §3/§4/§5/§6/§7/§11/§13/§36/§37, doc 10 §6/§7/§8, doc 11 §1, STACK.md ADR-001/002, Sprint-0 baselines (0001_init.sql, bronze_table.sql, bootstrap.sql) · **Next:** READY-FOR-SECURITY
```
