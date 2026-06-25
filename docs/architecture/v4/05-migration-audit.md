# 05 — Migration Audit (Classification & Rewrite Plan)

**Audit scope:** `db/migrations/0001 … 0111` (111 migrations; numbering gap at `0102`).
**Reference standard:** OFFICIAL BRAIN V4 ARCHITECTURE — PostgreSQL is operational-only; events/analytics/attribution/recommendations/identity-graph/features NEVER in PG; Neo4j owns identity; Gold lives in Iceberg; only `recommendation_history`/`decision_history`/`decision_outcome`/`user_feedback` decision tables allowed in PG.
**Evidence base:** the validated V4 audit bundle (PostgreSQL/DB-architecture workstream + Security workstream). Where a migration disagrees with the architecture, **architecture wins**.

---

## 1. Classification scheme

| Label | Meaning | Action |
|---|---|---|
| **VALID** | Created/maintains operational data that V4 keeps in PG | Keep as-is |
| **REFACTOR** | The migration is still needed but the table/object must change (rename to an allowed decision table, or relocate compute) to satisfy V4 | Rewrite forward (new migration), do not edit history |
| **DEPRECATED** | The migration's object is now obsolete (it references dropped tables, or duplicates another migration, or was a no-op) | Drop the object / clean up in a new migration |
| **REMOVE (relocate)** | The migration created analytical/AI data that V4 forbids in PG; the data must be rebuilt by Spark in the lakehouse, then dropped from PG | Relocate-then-cutover (gated on Spark) |
| **SUPERSEDED ✅** | A later migration already dropped the offending object — the realignment is complete | No further action |

> **Iron rule:** migrations are append-only history. Nothing below is "edited in place." Every REFACTOR/REMOVE/DEPRECATED action is a **new forward migration**. "Must be rewritten" = the *intent* must be reimplemented forward (e.g., the analytical table is rebuilt in Spark/Iceberg and a new migration drops the PG copy).

---

## 2. Headline

The migration corpus is **largely VALID** for operational data, and the most important analytical-data migrations have **already been reversed** by a completed medallion realignment:

| Originally-violating migration | Reversed by | Status |
|---|---|---|
| `0016_bronze_events` | `0070_drop_bronze_events` | **SUPERSEDED ✅** |
| `0018_realized_revenue_ledger` | `0098_drop_realized_revenue_ledger` | **SUPERSEDED ✅** |
| `0032_attribution_credit_ledger` | `0099_drop_attribution_credit_ledger` | **SUPERSEDED ✅** |
| `0017_identity_graph` (+ `0039/0051/0090/0095`) | `0101_drop_pg_identity_tables` | **SUPERSEDED ✅** (Neo4j owns identity) |
| `0083_ml_platform_foundation` (prediction_log part) | `0103_drop_ml_prediction_log` | **SUPERSEDED ✅** (registry kept) |
| `0029_ad_spend` | `0105_drop_ad_spend_ledger` | **SUPERSEDED ✅** |

What remains actionable: **5 residual analytical/AI migrations to REMOVE/REFACTOR**, a handful of **DEPRECATED hygiene items** (no-op duplicates + dangling functions), and the standing rule that the realignment can't fully close until **Spark Silver/Gold + StarRocks `mv_*` exist** (none do today — RECON-1).

---

## 3. Residual violations — must be REMOVED or REFACTORED forward

These are the migrations whose objects still violate V4 ownership. None can be dropped PG-side alone; all are **gated on the Spark→Iceberg→StarRocks-MV build**.

| Migration | Object | Class | Rationale (V4) | Forward rewrite |
|---|---|---|---|---|
| `0035_dq_check_result` (+ partition `0072`) | `audit.dq_check_result` | **REMOVE** | DQ outcome stream = analytics; never in PG | Rebuild DQ as a Spark check writing Iceberg Gold + StarRocks `mv_dq_*`; new migration drops the PG table |
| `0036_ai_provenance` | `ai_config.ai_provenance` | **REFACTOR / RATIFY** | AI output is runtime; V4 forbids permanent AI output | Either stop persisting, or ratify as an audit-ledger exception preserving redact-before-store; forward migration narrows/justifies |
| `0044_recommendation_decision_log` | `ai_config.recommendation`, `ai_config.recommendation_action`, `audit.decision_log` | **REFACTOR (rename)** | only `recommendation_history`/`decision_history`/`decision_outcome` allowed; computed recs forbidden | Forward migration renames to allowed tables; ensure they hold decision-loop *state*, not computation |
| `0045_recommendation_outcome` | `ai_config.recommendation_outcome` | **REFACTOR → `decision_outcome`** | effectiveness measurement = analytics unless it is the allowed `decision_outcome` | Forward migration renames/narrows to `decision_outcome`; measurement compute moves to Spark |
| `0082_recommendation_action_ledger` (+ partition) | `recommendation_action` ledger | **REFACTOR (rename)** | recommendation *action* output; keep only as `recommendation_history`/`decision_history` | Forward migration renames; ensure no computed scores stored |

> ⚠️ **HIGH-RISK — blocked-on-Spark, relocate-then-cutover only.** `dq_check_result` and the recommendation/decision tables are **actively written by stream-worker + core today**, and there are **ZERO Spark Silver/Gold jobs and ZERO `mv_*` views** to receive them (RECON-1). Dropping or renaming before the lakehouse replacement is live → read-path 500s (live routes read these) + DQ/recommendation blanking. **These forward migrations are the LAST step of the Spark migration, not the first.** Requires architecture sign-off.

---

## 4. DEPRECATED — hygiene cleanup (new migration, no Spark dependency)

These objects are obsolete *now* and can be cleaned up independently.

| Migration | Issue | Class | Action |
|---|---|---|---|
| `0085_drop_pg_bronze_events` | No-op "retire-plan only" comment that **duplicates** the real drop in `0070` — dead/confusing | **DEPRECATED** | Document as no-op; no schema action (history stays, but flag in changelog) |
| `0086_fk_covering_indexes` | **Duplicates** `0068_fk_covering_indexes` | **DEPRECATED** | Verify idempotency; consolidate intent; flag duplicate |
| `0024_dev_secret` | Dev-only secret gate | **DEPRECATED** | Superseded by `0087_drop_rls_demo_gate_dev_secret` — confirm fully removed |
| `0043_realized_gmv_for_period`, `0056_cm2_signal_for_brand` | Business-signal SQL functions over the **dropped** revenue ledger | **DEPRECATED** | Drop the dangling `SECURITY DEFINER` functions in a new migration |
| `rto_risk_signal_for_brand`, `realization_signal_for_brand` (introduced in earlier connector/signal migrations) | Compute-in-PG signals over now-dropped ledger | **DEPRECATED** | Drop; business signals belong in Spark→Iceberg Gold |

> **Note on drop-migration debt:** several of the realignment drop migrations (`0098/0099/0101/0103/0105`) left `SECURITY DEFINER`/signal functions still **referencing the dropped tables**. A single consolidating cleanup migration should drop these dangling functions to remove the broken references.

> ⚠️ **HIGH-RISK guard on cleanup:** an earlier drop migration introduced a **view-rebind-to-legacy bug** during `0081_drop_partition_legacy_tables` (per realignment history). Any cleanup migration that drops functions/views must be verified not to silently rebind a view to a legacy/dropped object. Verify with the live read paths before applying.

---

## 5. VALID — operational migrations (keep as-is)

The overwhelming majority. Grouped by domain; all are operational data V4 keeps in PG, RLS-isolated.

### 5.1 IAM / tenancy / auth / RBAC — **VALID**
`0001_init`, `0002_auth`, `0003_workspace`, `0004_brand`, `0005_invitation`, `0008_membership_self_read`, `0009_organization_self_read`, `0010_brand_locale`, `0011_onboarding_state`, `0012_session_rotation_lineage`, `0013_brand_self_read`, `0014_member_lifecycle`, `0019_active_brand_enumeration`, `0047_provision_workspace_and_brand`, `0048_find_session_for_rotation`, `0049_find_invite_for_acceptance`, `0064_phase_a_operational_schemas_iam_tenancy`, `0088_brand_config_history_scd`.

### 5.2 Connector config & sync control plane — **VALID**
`0006_connector`, `0021_connector_health`, `0022_backfill_job`, `0023_backfill_job_enumeration`, `0025_connector_sync_status_unique`, `0026_live_connector_security_definer_fns`, `0027_razorpay_settlement` (config), `0028_resolve_brand_by_install_token`, `0030_gokwik_shopflo_connectors`, `0031_connector_journey_stitch_map` (config/mapping), `0050_connector_webhook_raw_archive`, `0053_connector_repull_work_queue`, `0059_shiprocket_connector`, `0060_woocommerce_connector`, `0061_woocommerce_webhook_resolve`, `0062_connector_provider_dehardcode`, `0063_phase_a_operational_schemas_connectors_jobs`, `0091_data_driven_provider_discovery`, `0092_multi_account_per_provider`, `0093_sync_run_history_ledger`, `0094_webhook_archive_partition_and_dlq_record`, `0106_ad_account_activation`, `0108_resolve_gokwik_connector_by_merchant`, `0111_resource_backfill_state`.

> ⚠️ `0050_connector_webhook_raw_archive` is load-bearing for dedup/idempotency (`body_sha256`). It stays in PG as operational; **if** ever relocated to Bronze, preserve the dedup hash or risk duplicate order processing.

### 5.3 Ingress (transient) — **VALID**
`0015_collector_spool`, `0069_collector_spool_retention`.

### 5.4 Billing / financial operational state — **VALID (LOAD-BEARING)**
`0040_billing_meter_snapshot`, `0041_billing_plan_and_composition`, `0042_invoice_issuance`, `0046_gst_split_and_credit_notes`, `0073_partition_realized_revenue_ledger`*, `0078_partition_tax_ledger`, `0104_grant_update_ad_spend_ledger`*.

> ⚠️ **HIGH-RISK — Finance sign-off:** billing/invoice/tax/GMV-meter migrations are revenue/GST compliance load-bearing. Stay in PG; do not alter schema without finance ratification.
> *`0073` and `0104` target ledgers later dropped (`0098`/`0105`) — they are **historically VALID** but now inert; no action needed (the drop already neutralized them).

### 5.5 Compliance vault + WORM audit (ADR-0004) — **VALID (do not sweep out)**
`0033_consent_record_tombstone`, `0033_send_log`, `0037_contact_pii_ciphertext`, `0038_erase_customer`, `0075_partition_identity_audit`, `0077_partition_send_log`, `0100_erase_contact_pii_for_customer`, `0109_brand_identity_salt`, `0110_token_lookup_security_definer`.

> ⚠️ **HIGH-RISK — Security/DPDP sign-off:** PII vault + WORM audit deliberately retained in PG per ADR-0004. Do NOT classify as "customer history." Keep.

### 5.6 Pixel — **VALID**
`0007_pixel`, `0058_pixel_auto_install`.

### 5.7 RLS / isolation / security — **VALID (preserve at all costs)**
`0067_audit_security_rls_isolation`, `0084_partition_child_rls_lockdown`, `0087_drop_rls_demo_gate_dev_secret`, and all per-table `*_isolation` policies embedded in analytical/operational migrations.

> ⚠️ **HIGH-RISK — P0 / Security-VETO:** any REFACTOR/REMOVE forward migration MUST re-apply RLS FORCE on the new/renamed object. A regressed policy is a cross-tenant leak.

### 5.8 Reference data / locale / FX — **VALID**
`0071_reference_tables_currency_timezone`, `0107_gcc_india_currencies_timezones`.

### 5.9 Partition management & infra — **VALID**
`0080_partition_maintenance_routine`. (`0072/0076/0082`-partition portions are tied to the REMOVE/REFACTOR tables in Section 3 and move with them; `0074_partition_ad_spend_ledger` / `0073` are inert post-drop.)

### 5.10 ML lifecycle config — **VALID**
`0083_ml_platform_foundation` — the `model_registry` portion is operational config and was **kept** by `0103` (only `prediction_log` dropped).

### 5.11 Other operational reads / helpers — **VALID**
`0020_provisional_gmv_as_of`, `0052_capi_passback_unsupported_currency_status`, `0054_refund_per_refund_dedup`, `0055_cost_input` (margin cost inputs — operational config), `0057_customer_list_for_brand`, `0079_identity_first_identified_at`, `0096_attribution_model_id_data_driven` (config enum), `0097_realized_revenue_ledger_payment_method`*, `0089_backfill_realized_revenue_ledger_brain_id`* (*inert post-`0098` drop).

### 5.12 Phase-A schema-split migrations — **VALID**
`0063/0064/0065/0066` (`phase_a_operational_schemas_*`) — namespaced the flat-public PG into operational schemas aligned with DDD bounded contexts. Conformant.

---

## 6. SUPERSEDED ✅ — realignment already complete (no action)

| Migration (created) | Drop migration | Domain |
|---|---|---|
| `0016_bronze_events` | `0070` | raw events → Iceberg Bronze |
| `0017_identity_graph`, `0039_identity_merge_admin`, `0051_deterministic_admin_merge_id`, `0090_identity_link_anon_id_and_medium_dedup`, `0095_identity_link_pre_hashed_identifier_types` | `0101` | identity → Neo4j |
| `0018_realized_revenue_ledger` | `0098` | revenue truth → Gold/Iceberg |
| `0032_attribution_credit_ledger` | `0099` | attribution → lakehouse |
| `0083` (prediction_log part) | `0103` | predictions out of PG |
| `0029_ad_spend` | `0105` | spend → Bronze/Silver |
| `0024_dev_secret` | `0087` | dev gate removed |

These migrations stay in history (append-only) but require **no further action** — their objects are already gone.

---

## 7. Migrations that must be REWRITTEN (forward) — summary

"Rewritten" = a **new forward migration** that relocates/renames the object to satisfy V4. None edit history.

| # | New migration intent | Class | Gate |
|---|---|---|---|
| RW-1 | Rebuild DQ in Spark→Iceberg + `mv_dq_*`; drop `audit.dq_check_result` from PG | REMOVE (`0035`) | ⚠️ Spark Silver/Gold + MV must exist first |
| RW-2 | Rename `ai_config.recommendation`/`recommendation_action`/`audit.decision_log` → `recommendation_history`/`decision_history`; strip computed fields | REFACTOR (`0044`/`0082`) | ⚠️ Decision-runtime in place; recs computed by Spark/decision-runtime not PG |
| RW-3 | Rename `recommendation_outcome` → `decision_outcome`; move measurement compute to Spark | REFACTOR (`0045`) | ⚠️ As RW-2 |
| RW-4 | Resolve `ai_provenance`: stop persisting OR ratify as audit-ledger exception (keep redaction) | REFACTOR/RATIFY (`0036`) | ⚠️ Architecture + Security ruling |
| RW-5 | Drop dangling `SECURITY DEFINER`/signal functions referencing dropped ledgers (`realized_gmv_for_period`, `cm2_signal_for_brand`, `rto_risk_signal_for_brand`, `realization_signal_for_brand`) | DEPRECATED cleanup | none (verify no view-rebind regression) |
| RW-6 | Changelog/no-op consolidation note for duplicate/no-op migrations (`0085` dup of `0070`; `0086` dup of `0068`) | DEPRECATED hygiene | none |

---

## 8. Sequencing & risk

> ⚠️ **HIGH-RISK — ordering is load-bearing.** RW-1/RW-2/RW-3 are the **terminal** step of the larger compute-to-Spark migration. They are blocked on: (a) Spark Silver+Gold jobs existing (today: zero — only 4 Bronze jobs), (b) Gold landing in Iceberg, (c) StarRocks reduced to `mv_*` serving (today: zero `mv_*`), and (d) the live read routes (which currently read these PG tables) re-pointed to the MVs. **Relocate-then-cutover, parity-verify, then drop — never drop first.** Premature execution blanks dashboards and 500s the read paths.

**Safe-to-do-now (no Spark dependency):** RW-5 (drop dangling functions) and RW-6 (hygiene notes), provided the cleanup is verified against live read paths for the view-rebind regression.

**Counts:** ~95 migrations **VALID**, **7 SUPERSEDED ✅** (already reversed), **5 residual REMOVE/REFACTOR** (Section 3, Spark-gated), **~5 DEPRECATED** hygiene/dangling (Section 4). Net: the migration corpus is in **good V4 health** — the heavy analytical-data evacuation is done; what's left is a small, well-bounded forward-migration backlog tightly coupled to the Spark/StarRocks re-platform.
