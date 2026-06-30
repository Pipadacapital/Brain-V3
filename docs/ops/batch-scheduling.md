# Batch scheduling — Bronze → Silver → Gold → serving (Brain V4)

> Scope: the Argo `CronWorkflow` schedule for the V4 medallion refresh. Confirms each cron, its
> schedule, `concurrencyPolicy`, the enforced dependency order, expected per-stage runtimes, and —
> arithmetically — **whether the staggered schedules actually guarantee
> Bronze → Silver → Gold (Phase 1) → Gold (Phase 2) → serving views ordering without overlap.**
>
> Source of truth: `infra/helm/cronworkflows/` (`templates/spark-v4.yaml`, `templates/spark-bronze.yaml`,
> `templates/cronworkflows.yaml`, `values.yaml`). Dev mirror of the same dependency chain:
> `tools/dev/v4-refresh-loop.sh`.
>
> **Finding:** there is a **real overlap gap** — the staggered schedule does **not** guarantee ordering
> under load. See [§5](#5-arithmetic-do-the-windows-overlap) and [§6](#6-proposed-fix). All other invariants
> (every cron is `Forbid`, idempotent, digest-pinned, bounded-retry) are confirmed.

---

## 1. The architecture in one paragraph

Brain V4 makes Spark the **sole compute**. The medallion lives in Iceberg
(`brain_bronze`/`brain_silver`/`brain_gold`); the `brain_serving.mv_*` Trino views are thin projections
**straight over** the Iceberg Gold/Silver marts — there is **no separate view-refresh leg** (StarRocks and
dbt are removed). The refresh chain is **not** an Argo DAG: it is decomposed into one container per
`CronWorkflow`, and dependency order is enforced purely by **staggered start times + idempotency** (every
Spark `MERGE` and every node job is replay-safe). This is a deliberate convention of this chart
(`spark-v4.yaml` header: *"DEPENDENCY ORDER is enforced by STAGGERED SCHEDULES … NOT an Argo DAG"*). The
trade-off this doc evaluates is exactly that choice.

All schedules are **IST (`Asia/Kolkata`)** (`values.yaml → timezone`). Verified via
`helm template cronworkflows ./cronworkflows --set …image.digest=…` and `helm lint` (passes; only the
cosmetic `icon is recommended` INFO).

---

## 2. Every CronWorkflow

### 2a. Spark medallion crons (`templates/spark-v4.yaml`, `spark-bronze.yaml`)

| CronWorkflow | Schedule (IST) | Cadence | `concurrencyPolicy` | `activeDeadlineSeconds` | Enabled | What it runs |
|---|---|---|---|---|---|---|
| `bronze-materialize` | `*/15 * * * *` | every 15 min (:00/:15/:30/:45) | **Forbid** | 1800 (30 min) | `sparkBronze.enabled: true` | `bronze_materialize.py` — `TRIGGER_MODE=availableNow` drains the collector + backfill Kafka lanes → Iceberg Bronze (`MERGE … WHEN NOT MATCHED`, idempotent on `(brand_id, event_id)`). |
| `bronze-maintenance` | `0 3 * * *` | daily 03:00 | **Forbid** | 1800 | `sparkBronze.enabled: true` | `bronze_maintenance.py MODE=maintain` — small-file compaction + 24-month snapshot-expiry TTL. |
| `v4-silver` | `5 * * * *` | hourly :05 | **Forbid** | **2400 (40 min)** | `sparkV4.enabled: true` | `silver_order_state.py` (the brain_id spine) **first**, then `silver_*.py` (the rest of Silver, incl. an initial `silver_touchpoint` pass). |
| `v4-gold` | `25 * * * *` | hourly :25 | **Forbid** | **2400 (40 min)** | `sparkV4.enabled: true` | `gold_revenue_ledger.py` → `gold_attribution_credit.py` → `gold_marketing_attribution.py` → `gold_attribution_paths.py` (these four forced first), then the rest of `gold_*.py` / `snap_*.py` in shell-glob (alphabetical) order — `gold_customer_360`, segments/cohorts/scores, funnel/engagement/health/retention/recommendation, executive/cac. |

### 2b. Node jobs (`templates/cronworkflows.yaml`, driven by `values.yaml → jobs`)

All inherit `defaults`: **`concurrencyPolicy: Forbid`**, `startingDeadlineSeconds: 300`,
`activeDeadlineSeconds: 1800` (30 min), `backoffLimit: 2`.

| CronWorkflow | Schedule (IST) | Cadence | Image | Role in the chain |
|---|---|---|---|---|
| `identity-export` | `2 * * * *` | hourly :02 | stream-worker | **Chain step −1.** Neo4j identity graph → `silver_identity_link`. Must run **before** `v4-silver` so the Silver order spine resolves order `brain_id`. |
| `journey-stitch-export` | `3 * * * *` | hourly :03 | stream-worker | Projects PG `connector_journey_stitch_map` → `silver_journey_stitch`. |
| `journey-stitch-from-identity` | `15 * * * *` | hourly :15 | stream-worker | **Chain step 2.** Deterministic, unambiguous-only anon→brain_id→order stitch → `connector_journey_stitch_map`. |
| `attribution-reconcile` | `30 * * * *` | hourly :30 | core | **Chain step 3.** Credit recognized orders (`finalization ∪ cod_delivery_confirmed`) under all 5 models incl. data-driven Markov; clawbacks. |
| `audit-checkpoint` | `15 * * * *` | hourly :15 | core | WORM-anchor the audit hash-chain head to S3 (independent of the medallion chain). |
| `phone-guard-reeval` | `50 * * * *` | hourly :50 | stream-worker | Re-evaluate expired phone-guard suppression windows (independent). |
| `recommendation-detectors` | `0 6 * * *` | daily 06:00 | core | Morning-Brief detectors. |
| `meta-token-refresh` | `0 3 * * *` | daily 03:00 | stream-worker | Re-exchange Meta long-lived tokens. |
| `shopify-token-refresh` | `30 3 * * *` | daily 03:30 | stream-worker | Re-exchange Shopify offline tokens. |
| `partition-maintenance` | `30 2 * * *` | daily 02:30 | stream-worker | Create-ahead + drop-old PG RANGE partitions (C4). |

**`concurrencyPolicy: Forbid` confirmed on every cron** (10 node + 2 Spark Bronze + 2 Spark V4 = 14
`CronWorkflow`s; `helm template` output shows `Forbid` on all). **Important:** `Forbid` prevents a
CronWorkflow from overlapping **itself** only — it has **no effect across different CronWorkflows**. That
distinction is the crux of [§5](#5-arithmetic-do-the-windows-overlap).

---

## 3. The enforced dependency order (the V4 attribution chain)

Per `spark-v4.yaml` header + `values.yaml → jobs` comments + `README.md`, the intended hourly order is:

```
:00 :15 :30 :45  bronze-materialize     Kafka → Iceberg Bronze (every 15 min)
:02              identity-export        Neo4j → silver_identity_link            (BEFORE silver)
:03              journey-stitch-export  connector_journey_stitch_map → silver_journey_stitch
:05              v4-silver  (Spark)     silver_order_state spine + rest of Silver
:15              journey-stitch-from-id  identity links → stitch map
:25              v4-gold    (Spark)     gold_revenue_ledger → attribution → customer/gap/exec
:30              attribution-reconcile   credit recognized orders + clawbacks
```

Intended dependency edges (each downstream reads the always-fresh Trino view / Iceberg snapshot of its
upstream):

```
bronze-materialize ──▶ v4-silver ──▶ v4-gold ──▶ attribution-reconcile
identity-export ─────▶ v4-silver
v4-silver ───────────▶ journey-stitch-from-identity ──▶ v4-gold
```

### How this maps to the dev loop (`tools/dev/v4-refresh-loop.sh`)

The dev loop runs the **full** fine-grained chain in a single pass, in this exact order:

1. `identity-export` → `silver_identity_link`
2. `silver-collector-event` (R2/R3 admission gate)
3. `silver_order_state` (brain_id spine)
4. the rest of Silver (incl. an initial `silver_touchpoint` pass)
5. **`gold_revenue_ledger` + ensure `mv_silver_touchpoint` / `mv_gold_revenue_ledger` views**
6. `journey-stitch-from-identity` + `journey-stitch-export` (reads the views from step 5)
7. **rebuild `silver_touchpoint`** (now that the stitch exists → `stitched_*` columns populate)
8. `gold_customer_360` (the Phase-1 → Phase-2 **handoff** contract)
9. the rest of Gold BI (attribution, executive/cac, gap marts)
10. ensure all `mv_*` serving views

The loop is the **reference ordering**. The two-cron decomposition (`v4-silver` + `v4-gold`) is a
**coarsening** of it, and that coarsening introduces two scheduling consequences documented in
[§5](#5-arithmetic-do-the-windows-overlap) and [§7](#7-secondary-observation-pipelined-lag).

---

## 4. Expected per-stage runtimes

The chart specifies **deadlines** (hard kill caps), not measured runtimes. Honest statement of what is and
isn't known:

| Stage | `activeDeadlineSeconds` (hard cap) | In-pod retry | Expected real runtime |
|---|---|---|---|
| `bronze-materialize` | 1800 (30 min) | Argo `backoffLimit: 2` | `availableNow` drains current backlog then exits — seconds-to-minutes at steady state; minutes on a large backlog. |
| `v4-silver` | **2400 (40 min)** | `SPARK_MAX_RETRIES=1` (per submit) + `backoffLimit: 2` | **Not measured in-repo.** ~40 silver jobs run sequentially in one `local[*]` pod. Dev (small data) completes inside the 300 s loop interval; **prod scale is unmeasured.** |
| `v4-gold` | **2400 (40 min)** | `SPARK_MAX_RETRIES=1` + `backoffLimit: 2` | **Not measured in-repo.** ~40 gold/snap jobs sequentially in one pod — strictly heavier than Silver. |
| `journey-stitch-from-identity` | 1800 (30 min) | `backoffLimit: 2` | Single deterministic join; minutes. |
| `attribution-reconcile` | 1800 (30 min) | `backoffLimit: 2` | Per-brand × 5 models; minutes. |

> ⚠️ The **only** runtime bound the chart actually enforces is the `activeDeadlineSeconds` cap. The
> dependency design implicitly assumes each stage finishes well **inside the gap to its successor**. That
> assumption is **not** itself enforced — which is the gap in §5.

---

## 5. Arithmetic — do the windows overlap?

Compute the gap between each dependent pair and compare it to the **upstream's hard deadline** (the worst
case the scheduler permits before force-kill):

| Dependency edge | Start gap | Upstream hard cap | Gap ≥ cap? | Verdict |
|---|---|---|---|---|
| `identity-export` (:02) → `v4-silver` (:05) | **3 min** | 30 min | ❌ | Silver can start with stale `silver_identity_link`. |
| `v4-silver` (:05) → `journey-stitch-from-identity` (:15) | **10 min** | **40 min** | ❌ | Stitch can read a half-built Silver. |
| `journey-stitch-from-identity` (:15) → `v4-gold` (:25) | **10 min** | 30 min | ❌ | Gold can start before the stitch map is complete. |
| **`v4-gold` (:25) → `attribution-reconcile` (:30)** | **5 min** | **40 min** | ❌ | **Smoking gun:** Gold has ~40 sequential jobs and up to 40 min to run; only 5 min later `attribution-reconcile` fires and reads `gold_revenue_ledger` + `gold_attribution_*`. Under any realistic prod load, attribution **routinely starts while Gold is still building.** |

**Conclusion: NO. The staggered schedule does NOT guarantee
Bronze → Silver → Gold(P1) → Gold(P2) → views ordering without overlap.** *Every* dependent gap (3, 5, 10,
10 min) is **smaller** than its upstream's hard deadline (30–40 min), and because `concurrencyPolicy:
Forbid` is **intra-CronWorkflow only**, nothing prevents a slow upstream from still running when its
downstream fires.

### Severity / blast radius

This is **not data corruption** — it is **eventual-consistency lag**, because:

- Every stage reads the **always-fresh Trino view over the latest committed Iceberg snapshot** (no async
  view refresh). A premature downstream read sees the **previous** complete snapshot of its upstream, not a
  torn write (Iceberg commits are atomic at snapshot granularity).
- Every job is **idempotent**, so the **next** hourly cycle re-runs the downstream against the
  now-complete upstream and converges.

The practical impact: a fresh order/touchpoint can take **one or more extra hourly cycles** to reach
correct attribution credit. The **dangerous regime** is sustained load where `v4-silver`/`v4-gold` *always*
exceed their gaps — then `v4-gold` and `attribution-reconcile` are **perpetually one cycle behind**, never
catching up, and dashboards show a permanent ~1–2 h attribution lag rather than a transient one.

`bronze-materialize` (`*/15`) → `v4-silver` (:05) is **safe**: Bronze is independent and continuously
draining; Silver simply reads whatever Bronze snapshot exists at :05. Its 30-min deadline > 15-min cadence
also means a long materialize could overrun the next `*/15` tick, but `Forbid` correctly suppresses the
self-overlap there.

---

## 6. Proposed fix

The root cause is that the **gaps are smaller than the deadlines**, and `Forbid` cannot cross
CronWorkflows. There are two levels of fix.

### 6a. Durable fix (recommended) — collapse the chain into a single Argo Workflow DAG

The chart deliberately chose *"staggered schedules, NOT an Argo DAG"*. That choice **is** the gap. The
correct, runtime-independent fix is one `CronWorkflow` whose `workflowSpec` is a DAG with explicit
`dependencies:` so each task starts **only after** its predecessor's `Succeeded`:

```
identity-export ─▶ v4-silver ─▶ journey-stitch-from-identity ─▶ v4-gold ─▶ attribution-reconcile
```

This guarantees ordering regardless of how long any stage takes, and removes the need to guess gaps. It is
a template change (out of scope for a schedule-only edit) but is the only option that is **provably**
overlap-free.

### 6b. Schedule-only mitigation (if staying with the staggered convention)

Widen each gap to the largest the hourly window allows, **and** bound the Spark deadline below the smallest
Spark→downstream gap so a runaway stage is **force-killed before its dependent fires** — that is what turns
"`Forbid` + gap" into a real ordering boundary. Exact `values.yaml` edits:

```yaml
# infra/helm/cronworkflows/values.yaml

sparkV4:
  silverSchedule: "5 * * * *"      # :05  (unchanged)
  goldSchedule:   "35 * * * *"     # was "25 * * * *"  → 30-min gap after silver, 15-min after stitch
  activeDeadlineSeconds: 900       # was 2400 — force-kill a hung silver/gold at 15 min, BEFORE its
                                   # dependent fires (silver→stitch gap = 15 min; gold→attribution = 20 min)

jobs:
  - name: identity-export
    schedule: "0 * * * *"          # was "2 * * * *"  → :00, 5-min lead before v4-silver :05
  - name: journey-stitch-export
    schedule: "2 * * * *"          # was "3 * * * *"  (reads prev-cycle map; lead is harmless)
  - name: journey-stitch-from-identity
    schedule: "20 * * * *"         # was "15 * * * *" → 15-min gap after v4-silver :05
  - name: attribution-reconcile
    schedule: "55 * * * *"         # was "30 * * * *" → 20-min gap after v4-gold :35
```

Resulting hourly layout: `identity :00 → silver :05 → stitch :20 → gold :35 → attribution :55`, with each
Spark stage capped at 15 min (≤ its 15- / 20-min downstream gap).

> **Caveat — this only holds if real `v4-silver`/`v4-gold` runtime is < ~15 min at prod scale.** That is
> currently **unmeasured** ([§4](#4-expected-per-stage-runtimes)). If either stage legitimately needs more,
> the 900 s cap would kill a valid build mid-run — at which point the gaps must widen further (impossible
> within an hourly cadence for two 40-min stages) and **6a (the DAG) becomes mandatory.** **Action:**
> instrument `v4-silver`/`v4-gold` wall-clock (the `v4_job duration_ms` jlog line already exists in the dev
> loop; emit the equivalent from the cron pods), set the cap to `p99 + margin`, and confirm the gap ≥ cap
> before relying on 6b.

> A note on `identity-export` and `journey-stitch-from-identity` (node-job `defaults.activeDeadlineSeconds:
> 1800`): even with the widened gaps above, their 30-min cap still exceeds the new 15-/20-min gaps. They are
> short single-join jobs in practice, but for a true boundary they would also need a per-job deadline
> override ≤ their gap. This reinforces that **6a is the only fully-robust answer.**

---

## 7. Secondary observation — pipelined lag (by design, not a bug)

Independent of the overlap gap, the **coarse two-cron decomposition** does not replicate the dev loop's
intra-pass interleave, producing a built-in lag even when no overlap occurs:

1. **Stitch reads last hour's revenue ledger.** The loop builds `gold_revenue_ledger` *before*
   `journey-stitch-from-identity` (loop step 5 → 6). In cron, `gold_revenue_ledger` is inside `v4-gold`
   (:25) but `journey-stitch-from-identity` runs at :15 — **before** it. So the stitch reads the *previous*
   hour's ledger (order→brain_id). One-cycle lag.
2. **`silver_touchpoint.stitched_*` lags one hour.** The loop **rebuilds** `silver_touchpoint` *after* the
   stitch (loop step 7) so `stitched_*` populates in the same pass. In cron, `silver_touchpoint` is built
   only inside `v4-silver` (:05) — **before** the stitch at :15 — so a fresh stitch only reflects in
   touchpoint at **next** hour's `v4-silver`. Attribution credit therefore trails a new touchpoint by
   ~1–2 hourly cycles.

Both are **eventual-consistency lags** (idempotent + hourly convergence), acceptable for the current
hourly SLO but worth stating explicitly: a fresh order's *full* attribution propagation is **~2 cycles**,
not one. The DAG fix (6a) — with an explicit `gold_revenue_ledger → stitch → silver_touchpoint rebuild →
attribution` ordering — would also close these.

### Within-`v4-gold` ordering (low risk, flagged)

Inside the single `v4-gold` container, `gold_attribution_credit/marketing/paths` are forced to run
**first**, while `gold_customer_360` (the loop's Phase-1 handoff) runs **later** in the alphabetical glob —
i.e. the cron **inverts** the loop's Phase-1(customer_360) → Phase-2(BI) order. This is **benign today**
because attribution reads `silver_touchpoint` + `gold_revenue_ledger` (both built earlier in the same
container), **not** `gold_customer_360`; and the per-customer marts (`gold_customer_cohorts/scores/
segments`, `gold_executive_metrics`) sort *after* `gold_customer_360` alphabetically, so they still see it.
But this correctness rests on an **implicit alphabetical-glob ordering**, not a declared dependency — a
newly added per-customer mart that sorts *before* `gold_customer_360` would silently read a stale
Customer360. Treat the glob order as fragile; the DAG (6a) or an explicit ordered submit list in
`spark-v4.yaml` would make it robust.

---

## 8. Confirmation summary

| Claim | Status |
|---|---|
| Every CronWorkflow has `concurrencyPolicy: Forbid` | ✅ Confirmed (14/14 via `helm template`) |
| Every job is idempotent (replay/retry-safe) | ✅ Confirmed (Spark `MERGE`; node jobs documented idempotent) |
| Images are digest-pinned, fail-closed on missing digest (B3) | ✅ Confirmed (template `fail` guards) |
| Bounded retry on every stage | ✅ Confirmed (`SPARK_MAX_RETRIES` + Argo `backoffLimit: 2`) |
| `bronze-materialize` (`*/15`) self-overlap suppressed | ✅ Confirmed (`Forbid` + 30-min deadline) |
| **Staggered schedule guarantees Silver→Gold→attribution ordering without overlap** | ❌ **NO — see §5.** Gaps (3/5/10/10 min) < deadlines (30/40 min); `Forbid` is intra-cron only. |
| Impact of the gap | ⚠️ Eventual-consistency lag (not corruption); becomes a permanent ~1–2 h lag under sustained load where Spark stages exceed their gaps. |
| Recommended fix | §6a Argo DAG (durable) or §6b schedule widening + deadline bounding (mitigation, contingent on measured runtime). |

---

## 9. Verification performed

- `helm lint infra/helm/cronworkflows` → **passes** (only the cosmetic `icon is recommended` INFO).
- `helm template …` (with dummy `--set …image.digest=sha256:…` to satisfy the B3 fail-closed guards) →
  all 14 CronWorkflows render; confirmed each schedule, `concurrencyPolicy: Forbid`, and
  `activeDeadlineSeconds` value cited above.
- Schedule arithmetic in §5 cross-checked by hand against the rendered `schedule:` / `activeDeadlineSeconds`
  fields.
- Dependency order cross-checked against `tools/dev/v4-refresh-loop.sh` (the reference ordering) and the
  `spark-v4.yaml` / `values.yaml` inline comments.
</content>
</invoke>
