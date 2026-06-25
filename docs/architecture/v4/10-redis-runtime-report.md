# 10 — Redis Runtime Report

**Brain V4 Architecture Migration Audit**
**Scope:** Core Principle (6) "Redis owns runtime state"; the features-must-be-runtime mandate; the "NO permanent feature tables" rule; TTL posture.
**Verdict:** **MOSTLY CONFORMANT.** Redis usage is V4-correct: every key carries a TTL and Redis is never a source of truth. **One V4 violation persists in the feature pipeline:** a permanent feature *table* (`feature_customer_daily`) exists and the runtime feature store is **sourced from a StarRocks-owned Gold table** rather than from runtime computation over Iceberg-Gold-fed `mv_*`.

> **Authority note.** Per V4: *"if code/functionality/migrations/UI/APIs disagree with architecture, ARCHITECTURE WINS."*

---

## 1. V4 contract for Redis + features (verbatim mandate)

- **Principle 6:** Redis owns **runtime state**.
- **DB ownership / Redis:** sessions, cache, runtime features, temp state, signals.
- **FEATURES:** runtime, **generated dynamically, cached in Redis, recomputed**. **NO permanent feature tables.**
- **Flow:** StarRocks `mv_*` (serving) → **Redis runtime cache (TTL)** → Feature computation / AI runtime / Decision runtime / Dashboards+APIs.
- **DECISION:** outputs runtime; only stored decision-loop tables allowed are `recommendation_history`, `decision_history`, `decision_outcome`, `user_feedback`.

---

## 2. Executive summary

| V4 mandate | Reality (evidence) | Status |
|---|---|---|
| Redis used ONLY for runtime state/cache/features/signals | All Redis use is online feature store, dedup, retry counters, rate-limiter — no SoR use found | ✅ Conformant |
| Every Redis key carries a TTL | Feature store `FEATURE_TTL_SECONDS=25h` + freshness sentinel (`packages/feature-store/src/index.ts:70,113,132`); dedup `SET NX EX DEDUP_TTL 7d` (`RedisDedupAdapter.ts:52`); retry counter `INCR+EXPIRE 7d` (`RetryCounterAdapter.ts:36,67`); rate-limiter `INCR+PEXPIRE` (`ConnectorRateLimiter.ts:63`) | ✅ Conformant |
| Tenant-scoped Redis keys | `dedup:{brand_id}:{event_id}` (`RedisDedupAdapter.ts:4`); session `brain:v1:session:brand:{brandId}:tok:…` (`packages/tenant-context/src/index.ts:119`) | ✅ Conformant |
| Features are runtime / cached in Redis | Feature online store writes Redis (the correct **sink**) | ✅ (sink) |
| NO permanent feature tables | `feature_customer_daily` exists as a **dbt-built persistent table** (`db/dbt/models/marts/feature_customer_daily.sql`) | ❌ **Violated** |
| Feature source = runtime over Gold/MV | feature-materialization reads StarRocks **base** table `gold_customer_360` (a StarRocks-owned Gold table) (`apps/stream-worker/src/jobs/feature-materialization/run.ts`) | ❌ Source-side violation |

---

## 3. Redis usage inventory — all conformant

| Use | Adapter / path | Key shape | TTL | Verdict |
|---|---|---|---|---|
| Online feature store | `@brain/feature-store` (`packages/feature-store/src/index.ts:70,113,132`) | feature keys (brand-scoped) | `FEATURE_TTL_SECONDS=25h` + freshness sentinel | ✅ runtime feature cache (Principle 6 / Features) |
| Event dedup | `RedisDedupAdapter.ts:4,52` | `dedup:{brand_id}:{event_id}` | `SET NX EX`, `DEDUP_TTL=7d` | ✅ runtime signal/temp state |
| Durable retry counter | `RetryCounterAdapter.ts:36,67` | brand-scoped retry key | `INCR + EXPIRE 7d` | ✅ runtime signal ("durable" = retry/dedup state, V4-assigned to Redis) |
| Connector rate-limiter | `ConnectorRateLimiter.ts:63` | brand/connector key | `INCR + PEXPIRE` | ✅ runtime temp state |
| Session/tenant context | `packages/tenant-context/src/index.ts:119` | `brain:v1:session:brand:{brandId}:tok:…` | session TTL | ✅ sessions (DB ownership / Redis) |

**Finding:** No Redis source-of-truth use found. The "durable Redis" references in prior memory are **retry/dedup signal state**, which V4 explicitly assigns to Redis. The TTL posture is exemplary — every adapter sets an expiry. **This layer needs no change for V4.**

---

## 4. The feature-pipeline violation (the only Redis-adjacent V4 gap)

V4: *"FEATURES: runtime, generated dynamically, cached in Redis, recomputed. **NO permanent feature tables.**"*

### 4.1 Violation A — a permanent feature table exists

- **`feature_customer_daily`** (`db/dbt/models/marts/feature_customer_daily.sql`) is a **dbt-materialized persistent table** in the serving store. This is exactly the "permanent feature table" V4 forbids.
- **Fate:** must NOT be re-built as an Iceberg table or a StarRocks table. The feature it represents must be **computed at runtime and cached in Redis with a TTL**, recomputed on demand — never persisted as a feature mart. (Cross-ref report 08 §3.4, which flags it as the one dbt model that must NOT get a Spark-table replacement.)

### 4.2 Violation B — the feature source is a StarRocks-owned Gold base table

- `apps/stream-worker/src/jobs/feature-materialization/run.ts` reads StarRocks **`brain_gold.gold_customer_360`** (a StarRocks-owned Gold *base table*) and writes the Redis online store.
- The **sink is correct** (features → Redis with TTL). The **source is wrong**: under V4, features are computed at runtime from **Iceberg Gold served via `mv_*`** (Spark calculates → Iceberg Gold → StarRocks `mv_*` → runtime feature computation → Redis), not pulled from a StarRocks-owned Gold base table.
- **Fate:** repoint the source to the Iceberg-Gold-fed `mv_*` (gated on reports 08/09); keep the Redis sink unchanged.

---

## 5. Target state — runtime features over the V4 spine

```
Spark Gold ─▶ Iceberg Gold ─▶ StarRocks mv_* (serving)
                                     │
                                     ▼
                    Runtime feature computation (dynamic, recomputed)
                                     │
                                     ▼
                         Redis (TTL cache) ─▶ AI / Decision / APIs / UI
```

**Rules to enforce:**
1. **No permanent feature tables** anywhere — drop `feature_customer_daily`; do not recreate it in Iceberg or StarRocks.
2. Features are **computed at runtime** from `mv_*` (over Iceberg Gold) and **cached in Redis with a TTL** (the existing `FEATURE_TTL_SECONDS=25h` + freshness sentinel pattern is the correct mechanism — reuse it).
3. The feature-materialization sink to Redis stays; only its **source** flips from `brain_gold.gold_customer_360` (base table) to the Iceberg-Gold-fed `mv_*`.
4. AI outputs and decision outputs remain **runtime** (not stored), except the four V4-allowed decision-loop tables (`recommendation_history`, `decision_history`, `decision_outcome`, `user_feedback`) — these are out of Redis scope (PG operational), but reaffirmed here because the feature/decision runtime path terminates at them.

---

## 6. Migration ordering (feature-pipeline)

This change is **gated on the Spark Gold + StarRocks `mv_*` re-platform** (reports 08, 09) because the conformant feature *source* (`mv_*` over Iceberg Gold) does not exist yet.

1. Land Iceberg Gold + StarRocks `mv_*` for the customer-360 data product (reports 08/09).
2. Implement **runtime** feature computation reading `mv_*`, caching to Redis with TTL (reuse the existing online-store TTL + freshness-sentinel mechanism).
3. Repoint `feature-materialization/run.ts` source from `brain_gold.gold_customer_360` → `mv_*`.
4. **Drop `feature_customer_daily`** (and remove its dbt model) once no consumer reads the permanent feature table.

**Risk: LOW.** No money/billing truth is stored in Redis or in the feature path; the change is a source-repoint plus a permanent-table deletion. No ⚠️ HIGH-RISK callouts in this layer. The only dependency risk is sequencing — do not drop `feature_customer_daily` or repoint the source before `mv_*` is live and parity-checked, or the feature store goes stale/empty.

---

## 7. Disposition summary

| Item | Path | Disposition | Risk |
|---|---|---|---|
| Online feature store (Redis sink) | `packages/feature-store/src/index.ts` | ✅ KEEP — conformant TTL'd runtime cache; **reuse** as the feature mechanism | — |
| Dedup / retry / rate-limit / session | `RedisDedupAdapter.ts`, `RetryCounterAdapter.ts`, `ConnectorRateLimiter.ts`, `tenant-context` | ✅ KEEP — all TTL'd, tenant-scoped, runtime signals | — |
| `feature_customer_daily` (permanent feature table) | `db/dbt/models/marts/feature_customer_daily.sql` | 🗑️ **REMOVE** — violates "NO permanent feature tables"; compute at runtime + cache in Redis instead | Low |
| feature-materialization source | `apps/stream-worker/src/jobs/feature-materialization/run.ts` | 🔁 REPOINT source `gold_customer_360` (StarRocks base) → `mv_*` (Iceberg Gold); keep Redis sink | Low |

**Bottom line:** Redis itself is V4-clean — best-in-class TTL and tenant-scoping discipline, no SoR use. The only V4 work in this layer is in the **feature pipeline**: delete the permanent feature table and source runtime features from `mv_*` over Iceberg Gold. Both are gated on the Spark Gold / StarRocks `mv_*` re-platform (reports 08 and 09), and both are low-risk.
