<!-- SPEC: E (PLAN-OF-RECORD §PART 6.E — AI Feature Layer) -->
# CONTRACT-E — AI Feature Layer (SCAFFOLD ONLY)

**Wave:** E · **Status:** scaffolded (contracts/interfaces/DDL/registry/501 stub only — NO computation).
**Binding spec:** PLAN-OF-RECORD §PART 6.E. **Amendment:** AMD-19 (feature store vs the "features are RUNTIME" invariant).
**Flag:** `features.online_serving` (registry, wave E, **DEFAULT OFF**).

Point-in-time (PIT) correctness is the load-bearing requirement of this wave. Everything below is a
**contract**: types, a logical DDL, a registry shape, a Redis key contract, and an honest 501 endpoint.
No feature is computed, materialized, embedded, or served in this wave (see §Deferred).

---

## 1. AMD-19 posture taken

CLAUDE.md and `tools/lint/v4-naming-guard.sh` (R3) forbid a permanent feature-precompute table
(`feature_customer_daily` / `brain_feature` write). AMD-19 defers the store choice to E-scaffold time and
mandates a store-agnostic contract. **This scaffold takes posture R2 — as-of over Silver/Gold, no new
precompute table:**

- The `gold_ai_features` **EAV / point-in-time schema is a *logical* contract** — a documented DDL (§2) plus
  TS row types (`packages/ai-features/src/schema.ts`). It is **NOT** a `.sql`/Spark DDL that the refresh loop
  would create, and it is **NOT** registered in `db/iceberg/spark`. Nothing materializes it → it trips no guard.
- **Training reads** resolve features by an **AS-OF JOIN over the Silver/Gold spine at `event_timestamp`**
  (greatest `event_timestamp <= label_time`), **never "latest"** — the *discipline* is load-bearing, not the storage.
  The sanctioned request shape is `AsOfFeatureQuery` (`asOf` is REQUIRED; there is no "latest" overload).
- If a physical offline store is later sanctioned, that is an **additive** decision recorded as a new amendment
  **plus a named allowlist entry in the guard** — explicitly out of scope for scaffolding. The guard is untouched here.

**Naming reconciliation (important).** A WIDE current-state serving mart named `gold_ai_features` already ships
(`db/iceberg/spark/gold/gold_ai_features.py` → `brain_serving.mv_gold_ai_features`, read by
`@brain/metric-engine` `getAiFeatures`). That is a *runtime Silver fold* — one row per `(brand_id, brain_id)`,
current-state — and is a **different artifact** from the EAV/PIT contract here. It is left **untouched**. When
Wave-E logic lands, the two must be disambiguated (rename the logical PIT table, e.g. `gold_ai_feature_values`,
or namespace it) so the physical serving mart and the PIT contract never collide. Flagged for the E gate.

---

## 2. The feature schema contract (logical DDL — documented, NOT materialized)

EAV, point-in-time, `brand_id`-first (§0.5), money = bigint minor + sibling currency (§1.2):

```sql
-- LOGICAL CONTRACT ONLY — do NOT create in the refresh loop (AMD-19 R2). Mirrors schema.ts::AiFeatureRow.
gold_ai_features (
  brand_id           string     NOT NULL,   -- §0.5: brand_id FIRST, first in the PK
  entity_type        string     NOT NULL,   -- customer | product | campaign
  entity_id          string     NOT NULL,   -- brain_id / sku / campaign_id (brand-scoped)
  feature_name       string     NOT NULL,   -- registry key (packages/ai-features/features/*.yaml)
  feature_value      <typed>    NOT NULL,   -- typed union double|long|string|vector (NEVER blended)
  currency_code      string,                -- sibling for `long` MONEY features only (§1.2), else NULL
  event_timestamp    timestamp  NOT NULL,   -- VALID time: when the fact became true (the AS-OF key)
  created_timestamp  timestamp  NOT NULL,   -- SYSTEM time: when the row was written (audit only)
  feature_version    string     NOT NULL    -- feature-definition version (registry-pinned)
)
PRIMARY KEY (brand_id, entity_type, entity_id, feature_name, feature_version, event_timestamp)
```

- **Typed value union** (`schema.ts::FeatureValue`) discriminated by `dtype`: `double` (ratios from integer
  inputs), `long` (integer count / MINOR-unit money + sibling `currency_code`), `string` (categorical),
  `vector` (embedding — arm present, **production deferred**). Never a blended/coerced scalar; money never a float.
- **`event_timestamp` = valid time = the ONLY sanctioned as-of join key.** `created_timestamp` = system time =
  audit only, **never** a join key (using it would leak write-lag into training).

### Training-read discipline (§PART 6.E, Feast-style)
> A training read selects, per `(entity, feature)`, the row with the **greatest `event_timestamp` ≤ the label's
> event time** — an as-of join. It **never** selects `max(event_timestamp)` globally ("latest"), which would leak
> future information. Encoded in the contract type `AsOfFeatureQuery` (mandatory `asOf`); the resolver is deferred.

---

## 3. Online-serving contract (Redis hash)

```
KEY   : {brand_id}:feat:{entity_type}:{entity_id}   -- brand_id FIRST (§0.5); built ONLY via tenant-context
FIELD : feature_name
VALUE : serialized typed feature value (dtype-tagged)
```

- Holds the **current** ("latest") materialized value for **inference** — the one place "latest" is correct,
  because online inference is a now-query, not a training read. **Cache, not truth** (mirrors the A.4 touchpoint
  cache); the offline as-of contract (§2) is authoritative.
- **Crypto-shred:** the key is brand+subject scoped → a subject erasure DELetes it in the re-projection step.
  Registered in the shred manifest (§5). Real keys MUST be built via the sanctioned `@brain/tenant-context`
  key builder — `schema.ts::onlineFeatureKeyTemplate()` is a documentation/test template only.
- **Materialization is DEFERRED** — nothing in this wave writes these keys.

---

## 4. Endpoint stub — `GET /api/v1/features/:entity_type/:entity_id`

`apps/core/.../routes/features.routes.ts`, mounted in `bff.routes.ts`. Spec path `/v1/features/...` maps to the
repo-canonical `/api/v1/...` BFF prefix (AMD-14).

- **Tenant-scoped:** brand from **session** (`auth.brandId`), never a path/query param → 400 with no active brand.
- **Contract-validated:** `entity_type` ∈ `{customer, product, campaign}` (via `@brain/ai-features`
  `isFeatureEntityType`) → 400 otherwise; missing `entity_id` → 400.
- **Flag read (load-bearing):** `features.online_serving` is read per-brand and echoed in the body; it is
  fail-closed to OFF when no flag service is wired.
- **Honest NotImplemented:** returns **501 `NOT_IMPLEMENTED`** whether the flag is ON or OFF — there is no serving
  logic to gate in this wave. Enabling the flag does not change behavior until Wave-E logic ships.

---

## 5. Registry — `packages/ai-features`

`@brain/ai-features` — YAML-per-feature registry + a pure loader skeleton (the Wave-D compiler pattern,
conceptually; **loader only, no compute**).

- **Declaration shape** (`registry.ts::FeatureDefinition`, one `features/<name>.yaml` per feature):
  `{name, entity, dtype, source, freshness_sla, owner, pii}` (+ optional `currency` for money, `description`).
  `source` references the Wave-D semantic layer as an opaque string: `metric:<name>` or `entity:<entity>.<field>`.
- **Loader** (`loader.ts`): `parse → validate → assemble` into a `ParsedFeatureRegistry`. **Hexagonal & pure** —
  YAML parsing and directory reads are injected **ports** (`YamlParsePort`, `FeatureSourcePort`); adapters live
  in `src/infrastructure/` (a minimal dependency-free flat-YAML parser + a node:fs directory source). Swap the
  flat parser for a full YAML library behind the same port when the compiler is built.
- **PII discipline:** a feature with `pii: true` **MUST** appear in `knowledge-base/privacy/shred-manifest.md`
  (§1.9 invariant 3). The loader exposes `piiFeatureNames`; a subject crypto-shred neutralizes the materialized
  values. Seed registry: `customer_email_domain` is the PII exemplar; `customer_lifetime_value_minor` (money+INR),
  `product_repeat_purchase_rate`, `campaign_roas` are non-PII.
- **Deferred entrypoints** (fail-by-design `FeatureLayerNotImplementedError`): `resolveAsOfFeatures` (as-of
  training read), `materializeOnline` (Redis hash write), `materializeOffline` (offline jobs/embeddings).

---

## 6. Invariant posture

| Invariant | Posture in this scaffold |
|---|---|
| §0.5 additive / brand_id-first | New package + one additive route + logical DDL; `brand_id` first in the PK, the Redis key, and the auth scope. No existing table/route changed. |
| §1.2 money | Money features are `long` MINOR units with a **sibling `currency_code`** (contract-enforced); ratios are `double` from integer inputs. |
| §1.3 crypto-shred | PII features register in the shred manifest; the online hash key is subject-scoped and DELeted on erasure (§5, §3). |
| §1.7 schema governance | No new Kafka topic in Wave E → no Apicurio registration needed. (F/I own the new envelopes.) |
| §1.9 flags-OFF | `features.online_serving` OFF by default; the endpoint is 501 either way; nothing materializes → byte-identical pre-wave behavior. |
| v4-naming-guard | AMD-19 R2: no precompute table, no retired-DB ref — guard passes (verified). |

---

## 7. Scaffolded vs DELIBERATELY deferred

**Scaffolded (this change):**
- `packages/ai-features`: `schema.ts` (PIT EAV row contract + typed value union + online-hash contract +
  as-of query type), `registry.ts` (`FeatureDefinition` + validator/assembler), `loader.ts` (loader skeleton +
  ports + NotImplemented deferred stubs), `infrastructure/` (flat-YAML parser + fs source), 4 seed `features/*.yaml`,
  `loader.test.ts` (7 tests).
- `features.online_serving` flag (already registered) + the 501 endpoint `GET /api/v1/features/:entity_type/:entity_id`.
- The logical `gold_ai_features` PIT DDL (this doc §2) + shred-manifest registration of the online hash & PII features.

**Deliberately deferred (NOT built — §PART 6.E "Deferred: computation jobs, embeddings, materialization"):**
- All feature **computation** jobs (Spark/Trino) and the offline as-of **resolver** over Silver/Gold.
- All **embeddings** (the `vector` dtype arm) — no vector store, no embedding compute.
- All **materialization** — neither the logical offline table nor the online Redis hashes are written.
- A **physical** offline feature store (would require a new amendment + a named guard allowlist).
- Feature **versioning/lineage automation**, freshness-SLA monitors, and the Wave-D-style **compiler** that turns
  `source:` references into executable reads (loader-only here).
- Disambiguating the logical PIT table name from the shipped current-state `gold_ai_features` serving mart
  (naming reconciliation flagged in §1 — resolved when Wave-E logic lands).
