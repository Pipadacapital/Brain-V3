# 06 — Naming Violations

**Audit:** Brain V4 Architecture Migration
**Scope:** Conformance of filenames, class names, function names, table/column names, event names, and API routes against the V4 NAMING contract.
**Evidence base:** Validated audit bundle (RECON-1 + 8 domain audits) plus direct filesystem verification noted inline.

> **ENFORCEMENT (now CI-gated).** The mart/serving-object naming rule below is enforced by
> `tools/lint/v4-naming-guard.sh` (blocking step in `.github/workflows/pr.yml`): it fails any live
> (non-test, non-comment) reference to the retired dbt DBs `brain_gold.`/`brain_silver.`, any `dbt`
> invocation, any permanent feature precompute (`feature_customer_daily` / a `brain_feature` write), and
> any Gold/Silver read not via `brain_serving.mv_*` or the rest-Iceberg catalogs. The retired DBs are
> torn down by `db/starrocks/teardown/drop_dbt_internal_dbs.sql` (brain_gold/brain_silver) and
> `db/starrocks/teardown/drop_dead_feature_db.sql` (brain_feature). Readers serve from `brain_serving.mv_*`.

---

## V4 naming contract (the rule)

| Artifact | Required convention | Example |
| --- | --- | --- |
| Files | `kebab-case` | `customer-repository.ts` |
| Classes | `PascalCase` | `CustomerRepository` |
| Functions | `camelCase` | `calculateRealizedRevenue` |
| Tables / columns | `snake_case` | `customer`, `customer_id` |
| Events | `dot.lower` | `order.created` |
| APIs | REST | `GET /customers/{id}` |

**Architecture-wins rule:** Where current code disagrees with the contract, the contract is the source of truth and the code must be renamed.

---

## Summary scoreboard

| Category | Verdict | Violations found | Severity |
| --- | --- | --- | --- |
| Files (`.ts` source) | **VIOLATION** | 125 PascalCase `.ts` files | Normal (mechanical) |
| Classes | Conformant | 0 | — |
| Functions | Conformant | 0 | — |
| Tables / columns | Conformant | 0 | — |
| Events | Conformant | 0 (dot.lower throughout) | — |
| APIs (REST routes) | Conformant | 0 material | — |
| Mart / serving-object naming | **VIOLATION** (semantic, not casing) | Gold marts named as base tables, not `mv_*` | High (architectural) |

> The casing conventions for tables, columns, and events are **broadly compliant** across the corpus (multiple audits concur: Data Architecture, Spark/DE, PG/DB, Security). The single material *casing* violation is the file-naming rule. The single material *semantic* naming violation is that no `mv_*` materialized-view serving objects exist — the serving layer is misnamed (and mis-architected) as base Gold tables.

---

## 1. File naming — `kebab-case` rule (VIOLATION)

**Rule:** source files must be `kebab-case` (e.g. `customer-repository.ts`).
**Finding:** **125 `.ts` source files are `PascalCase`** — they are named after the class they export rather than kebab-cased.

**Evidence:** Staff-SWE audit reports "125 PascalCase-named .ts files violate the kebab-case file rule." Filesystem verification confirms an exact count of **125** files matching `/[A-Z][A-Za-z]*\.ts$` under `apps/` and `packages/`.

> NOTE: This is the most common and most mechanical V4 naming deviation in the codebase. It is low-risk (no behavior change, import-path-only churn) but high-volume.

### Representative offenders and their correct names

| Current path (PascalCase — WRONG) | Correct V4 name |
| --- | --- |
| `apps/stream-worker/src/application/ResolveIdentityUseCase.ts` | `resolve-identity-use-case.ts` |
| `apps/stream-worker/src/application/ProcessEventUseCase.ts` | `process-event-use-case.ts` |
| `apps/stream-worker/src/application/ProjectConsentUseCase.ts` | `project-consent-use-case.ts` |
| `apps/stream-worker/src/application/RequestCapiDeletionUseCase.ts` | `request-capi-deletion-use-case.ts` |
| `apps/stream-worker/src/identity-bridge/IdentityBridgeConsumer.ts` | `identity-bridge-consumer.ts` |
| `apps/stream-worker/src/infrastructure/redis/RetryCounterAdapter.ts` | `retry-counter-adapter.ts` |
| `apps/stream-worker/src/infrastructure/redis/RedisDedupAdapter.ts` | `redis-dedup-adapter.ts` |
| `apps/stream-worker/src/infrastructure/redis/ConnectorRateLimiter.ts` | `connector-rate-limiter.ts` |
| `apps/stream-worker/src/infrastructure/secrets/SaltProvider.ts` | `salt-provider.ts` |
| `apps/stream-worker/src/infrastructure/health/HealthServer.ts` | `health-server.ts` |
| `apps/stream-worker/src/infrastructure/pg/BronzeRepository.ts` | `bronze-repository.ts` |
| `apps/stream-worker/src/infrastructure/pg/CursorRepository.ts` | `cursor-repository.ts` |
| `apps/stream-worker/src/infrastructure/pg/ConsentRepository.ts` | `consent-repository.ts` |
| `apps/stream-worker/src/infrastructure/pg/StitchMapWriter.ts` | `stitch-map-writer.ts` |
| `apps/stream-worker/src/infrastructure/pg/SyncRunRepository.ts` | `sync-run-repository.ts` |
| `apps/stream-worker/src/infrastructure/pg/DlqRecordRepository.ts` | `dlq-record-repository.ts` |
| `apps/stream-worker/src/infrastructure/pg/LeaderLock.ts` | `leader-lock.ts` |
| `apps/stream-worker/src/infrastructure/kafka/DlqProducer.ts` | `dlq-producer.ts` |
| `apps/stream-worker/src/infrastructure/kafka/DlqRedriver.ts` | `dlq-redriver.ts` |
| `apps/stream-worker/src/domain/identity/IdentityStore.ts` | `identity-store.ts` |
| `apps/stream-worker/src/domain/identity/IdentityResolver.ts` | `identity-resolver.ts` |
| `apps/stream-worker/src/domain/bronze/BronzeRow.ts` | `bronze-row.ts` |
| `apps/stream-worker/src/domain/bronze/DedupPolicy.ts` | `dedup-policy.ts` |
| `apps/stream-worker/src/interfaces/consumers/CollectorEventConsumer.ts` | `collector-event-consumer.ts` |
| `apps/stream-worker/src/interfaces/consumers/BackfillOrderConsumer.ts` | `backfill-order-consumer.ts` |
| `apps/stream-worker/src/interfaces/consumers/ConsentSuppressorConsumer.ts` | `consent-suppressor-consumer.ts` |
| `apps/stream-worker/src/interfaces/consumers/CapiDeletionConsumer.ts` | `capi-deletion-consumer.ts` |
| `apps/stream-worker/src/interfaces/consumers/EventBronzeBridgeConsumer.ts` | `event-bronze-bridge-consumer.ts` |
| `apps/stream-worker/src/jobs/ingestion-backfill/PgResourceBackfillStateRepository.ts` | `pg-resource-backfill-state-repository.ts` |
| `apps/stream-worker/src/infrastructure/neo4j/Neo4jIdentityRepository.ts` | `neo4j-identity-repository.ts` |
| `packages/connector-secrets/src/ISecretsManager.ts` | `i-secrets-manager.ts` (or `secrets-manager.contract.ts`) |
| `packages/connector-secrets/src/LocalSecretsManager.ts` | `local-secrets-manager.ts` |
| `packages/connector-secrets/src/AwsSecretsManager.ts` | `aws-secrets-manager.ts` |
| `packages/connector-core/src/contracts/IngestionManifest.ts` | `ingestion-manifest.ts` |
| `packages/connector-core/src/contracts/CanonicalEvent.ts` | `canonical-event.ts` |
| `packages/connector-core/src/contracts/Backfill.ts` | `backfill.ts` |
| `packages/connector-core/src/contracts/Dedup.ts` | `dedup.ts` |

> The 125 offenders cluster overwhelmingly in `apps/stream-worker/src/**` (use-cases, consumers, infrastructure adapters, domain) and `packages/connector-*`. The remaining ~90 not enumerated above follow the same pattern (a `PascalCase` filename whose stem is the exported class). The corrective rename in every case is: **lowercase the stem and insert hyphens at the original case boundaries; the exported `PascalCase` class name stays unchanged.**

### Rename guidance (no behavior change)

The class names themselves are **correct** (`PascalCase`) — do not touch them. Only the *file* needs renaming, plus every import specifier that references the old path. On case-insensitive filesystems (macOS default) a two-step `git mv` (to a temp name, then to the kebab name) is required so Git records the rename.

> NOTE: Because `apps/web` is a clean consumer and these files live in backend/packages, the rename has **zero UI impact** and **zero API-contract impact** — it is import-graph churn only.

---

## 2. Class naming — `PascalCase` (CONFORMANT)

No violations. The 125 file-naming offenders above all export correctly-cased `PascalCase` classes (`ResolveIdentityUseCase`, `Neo4jIdentityRepository`, `AwsSecretsManager`, `CustomerRepository`, etc.). The problem is the *file*, not the *class*.

---

## 3. Function naming — `camelCase` (CONFORMANT)

No violations found. Audit-cited function names conform: `buildPartitionKey` (`packages/events/src/index.ts:144`), `calculateRealizedRevenue`, `reconcileAttribution`, `reconcileDataDrivenAttribution`, `erase_contact_pii_for_customer` is a SQL function (snake_case, correct for SQL).

---

## 4. Table & column naming — `snake_case` (CONFORMANT casing)

**Casing is conformant.** Every audit (Data Architecture, Spark/DE, PG/DB) independently confirms `snake_case` tables/columns throughout: `silver_order_state`, `brand_id`, `order_value_minor`, `gold_customer_360`, `gold_revenue_ledger`, `attribution_credit_ledger`, `dq_check_result`, `recommendation_action`, `customer_id`, `currency_code`.

> IMPORTANT — *casing is correct, but ownership/layer naming is not.* The Data Architecture audit flags that several object **names** misrepresent the V4 layer they should live in (e.g. `brain_gold.*` tables are physically StarRocks base tables, but V4 says Gold lives in Iceberg and StarRocks may only hold `mv_*` serving views). That is a **semantic naming violation of the serving layer** — covered in §7 below and in the code-violations deliverable (`07-code-violations.md`). It is not a casing fix.

---

## 5. Event naming — `dot.lower` (CONFORMANT)

No violations. Event names conform to `dot.lower` across producers and bridges:

| Event | Source (evidence) |
| --- | --- |
| `order.live.v1` | `stg_order_events_bronze.sql:32`, `bronzeBridges.ts` |
| `order.created` | naming examples / migration corpus |
| `order.backfill.v1` | backfill lane (RECON-1) |
| `spend.live.v1` | `silver_marketing_spend.sql:5-9` |
| `shopflo.checkout_abandoned.v1` | `bronzeBridges.ts:37-61` |
| `gokwik.awb_status.v1` | `bronzeBridges.ts:37-61` |
| `shiprocket.shipment_status.v1` | `bronzeBridges.ts:37-61` |
| `user.registered.v1` | m1 control-plane domain topic |
| `pixel.brand_mismatch` | `ProcessEventUseCase.ts` quarantine audit |

> NOTE — **topic taxonomy is a separate concern from event naming.** V4's *illustrative* per-source topic set (`pixel.events`, `shopify.orders`, `identity.events`) differs from Brain's unified-envelope topic `collector.event.v1` carrying an `event_name` discriminant (SPARK-007). The **event names** are V4-conformant; whether the **topic partitioning** should be re-cut is an architecture decision, not a naming violation, and is flagged HIGH-RISK in the code-violations deliverable.

---

## 6. API naming — REST (CONFORMANT)

No material violations. The web app consumes the core BFF over `/api/bff/*` REST routes (`apps/web/lib/api/client.ts`); attribution/dq/dashboard routes are REST (`attribution.routes.ts`, `dashboard.routes.ts`). No RPC-style or verb-in-path anti-patterns were surfaced by any audit.

> Forward-looking note under V4's "Architecture change → API change → UI change" rule: when Gold compute moves to Spark/Iceberg and serving moves to `mv_*`, the **DTO-shaped REST contracts stay stable** (Frontend audit: near-zero UI impact). New canonical entity routes added during the migration (e.g. `GET /customers/{id}` for `customer_360`) must follow REST + `{id}` path-parameter style.

---

## 7. Serving-object naming — `mv_*` rule (VIOLATION — high)

⚠️ **HIGH-RISK — requires stakeholder sign-off (architectural, not cosmetic).**

**Rule:** StarRocks owns serving ONLY, exposed as materialized views named `mv_*`. Gold business truth lives in Iceberg; StarRocks "does NOT own customer_360 / attribution / realized_revenue / business-logic / recommendations."

**Finding:** **ZERO `mv_*` materialized views exist anywhere** (grep clean — confirmed by Spark/DE, Infra, and Staff-SWE audits, and re-verified: no `mv_` matches in `db/dbt/models` or `db/starrocks`). Instead, every Gold and serving object is named and materialized as a **base table** in `brain_gold` / `brain_silver`:

| Current object (WRONG layer/name) | Materialization (evidence) | V4-correct serving name |
| --- | --- | --- |
| `brain_gold.gold_customer_360` | StarRocks `incremental` table (`gold_customer_360.sql:12-13`) | `mv_customer_360` (over Iceberg Gold) |
| `brain_gold.gold_revenue_ledger` | dbt table mart | `mv_revenue_ledger` |
| `brain_gold.gold_attribution_credit` | StarRocks PK table (`@brain/attribution-writer` INSERTs, `index.ts:96,346`) | `mv_attribution_credit` |
| `brain_gold.gold_attribution_paths` | dbt table mart | `mv_attribution_paths` |
| `brain_gold.gold_marketing_attribution` | dbt table mart (attribution-gold-refresh cron) | `mv_marketing_attribution` |
| `brain_gold.gold_cac` | dbt table mart | `mv_cac` |
| `brain_gold.gold_customer_scores` | dbt table mart | `mv_customer_scores` |
| `brain_gold.gold_customer_segments` | dbt table mart | `mv_customer_segments` |
| `brain_gold.gold_cohorts` | dbt table mart | `mv_cohorts` |
| `brain_gold.gold_executive_metrics` | dbt table mart | `mv_executive_metrics` |
| `brain_gold.gold_ml_prediction_log` | StarRocks PK table | (not a serving MV — relocate to lakehouse) |
| `brain_gold.feature_customer_daily` | dbt table mart | **REMOVE** — V4 forbids permanent feature tables (features are runtime/Redis) |
| `brain_silver.silver_*` (9 entities) | dbt tables in StarRocks | Iceberg Silver (Spark-built); StarRocks `mv_*` only if served |

**Why this is a naming violation and not only an architecture one:** the `gold_*` prefix on a StarRocks **base table** asserts an ownership ("StarRocks owns Gold") that V4 explicitly forbids. Under V4 the only correctly-named StarRocks objects are `mv_*` serving views over Iceberg-resident Gold. The rename is therefore inseparable from the storage relocation (Iceberg Gold) — it cannot be done as a cosmetic `ALTER ... RENAME`.

> NOTE — `feature_customer_daily` is doubly wrong: wrong name (a permanent table, not `mv_*`) **and** wrong existence (V4: "NO permanent feature tables"; features are runtime, generated dynamically, cached in Redis). The correct disposition is removal, not rename.

**Sign-off needed because:** renaming/relocating `gold_revenue_ledger` (billing reads it), `gold_attribution_credit`, and `gold_marketing_attribution` is a **revenue/attribution-truth migration**, not a casing change. It must be parity-gated (exact minor-unit Σ oracle) before cutover. See `07-code-violations.md` and the migration-plan deliverables for sequencing.

---

## Disposition summary

| # | Violation | Count | Disposition | Risk |
| --- | --- | --- | --- | --- |
| 1 | PascalCase source files vs `kebab-case` | 125 | Mechanical rename (file only; classes unchanged) | Low |
| 2 | Classes | 0 | — | — |
| 3 | Functions | 0 | — | — |
| 4 | Table/column casing | 0 | — | — |
| 5 | Event names | 0 | — | — |
| 6 | API routes | 0 | — | — |
| 7 | Serving objects named `gold_*` base tables instead of `mv_*` over Iceberg Gold | ~12 | ⚠️ Rename-with-relocation; parity-gated | High |

**Bottom line:** Brain's *casing* discipline (classes, functions, tables, columns, events, APIs) is genuinely strong and V4-compliant. The two real naming problems are (1) a high-volume but trivially-mechanical file-casing fix, and (2) a high-risk *semantic* serving-layer misnaming that is really an architecture relocation (`gold_*` → `mv_*` over Iceberg Gold) and must be ratified before execution.
