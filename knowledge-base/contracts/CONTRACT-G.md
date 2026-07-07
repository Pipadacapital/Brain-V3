<!-- SPEC: G -->
# CONTRACT-G — Recommendation Engine (SPEC:G + AMD-21)

**Status:** SCAFFOLD ONLY (PLAN-OF-RECORD §PART 6 §G). Schema + 501 stub + flag. NO models, NO scoring.
**Binding inputs:** PLAN-OF-RECORD §PART 6 §G; 01-delta-plan.md (G row); AMD-21 (R1, BINDING).
**Non-negotiables honored:** additive-only; `brand_id` FIRST on the table + idempotency key; explainability schema-enforced; new endpoint fail-closed behind a DEFAULT-OFF flag.

---

## 1. What was scaffolded

### 1.1 Output schema DDL — `brain_gold.gold_recommendations`
File: `db/iceberg/gold_recommendations.sql` (Iceberg format-v2, brand_id-first partitioning, schema-of-record).

| Column | Type | Null | Notes |
|---|---|---|---|
| `brand_id` | STRING | NOT NULL | Tenant key, **FIRST column**, partition bucket source, isolation anchor. |
| `recommendation_id` | STRING | NOT NULL | Stable id — idempotency key `(brand_id, recommendation_id)`. **Additive** to the §G field list (MERGE grain); see §4. |
| `subject_type` | STRING | NOT NULL | `customer \| product \| campaign` — the entity the rec is ABOUT. Enum enforced in the (deferred) writer. |
| `subject_id` | STRING | NOT NULL | Id within `subject_type`. |
| `rec_type` | STRING | NOT NULL | `product \| campaign \| nba`. Enum enforced in the (deferred) writer (Iceberg has no CHECK). |
| `payload` | STRING (json) | NOT NULL | JSON-encoded recommendation body. No raw PII (I-S02). |
| `score` | DOUBLE | NOT NULL | Model relevance/ranking score. Produced by DEFERRED model. |
| `confidence` | DOUBLE | NOT NULL | Model confidence [0,1]. NOT NULL — "Confidence before decisions". |
| `evidence` | STRING (json) | NOT NULL | Feature NAMES + VALUES used. **Explainability, schema-enforced.** |
| `model_version` | STRING | NOT NULL | Producing model/pipeline version — provenance/audit. |
| `business_rules_applied` | STRING (json) | NOT NULL | Rules/guardrails applied. **Explainability, schema-enforced.** |
| `generated_at` | TIMESTAMP | NOT NULL | UTC generation time; `days()` partition source; freshness anchor. |
| `expires_at` | TIMESTAMP | NULL | UTC expiry (null = never); rec must not be served after this. |

Partitioning: `bucket(16, brand_id), days(generated_at)`. TBLPROPERTIES mirror the shared Gold DDL contract (`iceberg_base.py::create_iceberg_table`): format-v2, zstd parquet, `write.upsert.enabled=false` (append-only-on-no-match MERGE).

**Explainability is schema-ENFORCED, not a UI afterthought (§G):** `evidence`, `model_version`, `business_rules_applied`, `score`, and `confidence` are all `NOT NULL`. No recommendation row can be persisted without the features+values it used, the rules applied, its model provenance, and its confidence. The DB enforces this at write time — no reader is trusted to backfill it.

### 1.2 Serving stub — 501 behind flag (AMD-21-scoped path)
File: `apps/core/.../routes/recommendations-generated.routes.ts`, wired in `bff.routes.ts` (additive, next to the grandfathered decisions routes).

- **Path:** `GET /api/v1/recommendations/generated` (repo convention prefixes `/api`; the spec's `GET /v1/recommendations` maps here — see §2).
- **Flag:** `recommendations.api` (already registered in `packages/platform-flags`, wave G, DEFAULT OFF, fail-closed).
- **Behavior (fail-closed):**
  - no session brand → `400 NO_BRAND` (brand from session only, D-1).
  - flag OFF (default) or flag service absent → `404 NOT_ENABLED` (capability gated off for this brand).
  - flag ON → `501 NOT_IMPLEMENTED` (enabled, but Wave G models/scoring deferred).

No reader for `gold_recommendations` exists — the endpoint is a failing-by-design NotImplemented stub.

---

## 2. How the shipped surface is NOT regressed (AMD-21, BINDING)

A **working rule-based recommend-only surface already ships** and stays byte-for-byte untouched:
- `GET /api/v1/recommendations` — the "Morning Brief" (open recommendations).
- `POST /api/v1/recommendations/refresh` — run the detectors.
- `POST /api/v1/recommendations/:id/action` — human-action ledger (migration 0082).
- Backed by `decisions.routes.ts` detectors + confidence-gate + `recommendation_action` ledger + UI.

The §G verbatim path is `GET /v1/recommendations`. Under the repo's `/api`-prefixed routing that is exactly the shipped `GET /api/v1/recommendations` — so implementing §G verbatim as a 501 would **overwrite a live, ledgered product feature** (prohibited by §0.5 non-breaking).

**Resolution (AMD-21 R1):** the 501 stub is scoped to a **NEW, net-new path** — `GET /api/v1/recommendations/generated` — over the (empty) `gold_recommendations` mart. It is a separate route file, separately registered; it shares no handler, no code path, and no ledger with the shipped surface. Zero shipped behavior changes. Two recommendation surfaces coexist until Wave G proper unifies them (see §4).

Verification: shipped routes in `decisions.routes.ts` were read and left unmodified; the new route is the ONLY new registration; `@brain/core` typechecks clean.

---

## 3. Invariants honored
- **Additive-only:** new SQL file, new route file, two additive lines in `bff.routes.ts`. No column/row/behavior removed.
- **brand_id FIRST:** first table column, first idempotency-key member, partition bucket source; endpoint reads brand from session only (D-1), never from request.
- **Flags DEFAULT OFF, fail-closed:** absent/OFF flag ⇒ 404, never a live surface.
- **v4-naming-guard:** `gold_recommendations` is a SERVING mart of finished recommendations, NOT a feature-precompute table (no `feature_*_daily` grain, no `brain_feature`); adds no retired-DB (StarRocks / dbt-internal) coupling. Passes the guard.
- **Money:** none in this schema (score/confidence are model floats, not money); the bigint-minor+currency rule is N/A here.
- **`// SPEC: G (AMD-21)` headers** on every new file.

---

## 4. Deliberately DEFERRED (NOT in this scaffold)
- **All models + all scoring** (§G explicit). `score`/`confidence` columns exist but are never populated by scaffold code.
- **No writer / no Spark build job / no refresh-loop wiring** for `gold_recommendations`. `db/iceberg/gold_recommendations.sql` is the schema-of-record only; the table is created empty and stays empty. (Deliberately NOT added to `_gold_registry`/`v4-refresh-loop` — a registered job would imply a writer.)
- **No serving view** (`mv_gold_recommendations`) and **no read seam** — the 501 stub returns before any query. Added when Wave G models ship.
- **enum enforcement** for `subject_type`/`rec_type` lives in the future writer (Iceberg has no CHECK constraint).
- **Surface unification:** merging the grandfathered rule-based surface and the new schema-backed surface is Wave-G-proper work; two surfaces coexist meanwhile.

---

## 5. Files touched
- `db/iceberg/gold_recommendations.sql` (new — DDL)
- `apps/core/src/modules/frontend-api/internal/routes/recommendations-generated.routes.ts` (new — 501 stub)
- `apps/core/src/modules/frontend-api/internal/bff.routes.ts` (edit — 2 additive lines: import + register)
- `packages/platform-flags` — no change (`recommendations.api` was already registered, wave G, DEFAULT OFF)
