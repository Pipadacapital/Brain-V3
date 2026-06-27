# Phase 1 — Identity Resolution Platform: Enterprise Implementation Spec

Status: Principal review of the **already-built** deterministic identity spine. This is an
implementation-ready specification, not an architectural redesign. The approved Brain
architecture is fixed and must be preserved:

```
Fastify Collectors → Kafka (KRaft) → Spark Structured Streaming landing → Iceberg Bronze
  → Spark → Iceberg Silver → Phase 1 Identity Intelligence → Customer360 Contract
  → Phase 2 Business Intelligence → Iceberg Gold
  → Analytics Gateway (Redis cache-aside + Trino) → Fastify APIs → dashboards / AI / reports
```

Fixed facts (do not redesign):

- **Serving** = Trino-over-Iceberg + Redis cache-aside. StarRocks is REMOVED. The
  `brain_serving.mv_*` objects are **Trino views** in `db/trino/views/`, not materialized tables.
- **Operational state** = PostgreSQL ops schema. PG is operational-only.
- **Identity SoR** = Neo4j (ADR-0004, `docs/adr/0004-neo4j-identity-sor.md`). Graph holds
  **hashes only**; raw PII vault + immutable audit ledger live in PostgreSQL.
- **Money** = `bigint` minor units + a sibling `currency_code`. Never a float, never blended.
- **PII** = hash-only on every analytical/serving surface; SHA-256 with per-brand + per-subject salt.
- **Tenancy** = `brand_id`-first on every row/edge/key, plus the `${BRAND_PREDICATE}` Trino seam.
- **Probabilistic matcher** = RULE-BASED + REVIEW-GATED. Score capped at 95, band can never be
  `exact`, routes to human review, **never auto-merges**. ML / household / cross-device matchers and
  `predictive_ltv` / `predictive_health` are **REGISTERED-DISABLED**.
- **Data-driven attribution** (Phase 2) = Markov removal-effect.
- **LLMs NEVER match or compute.** They consume deterministic outputs through read-only MCP tools.

Verdict legend used throughout: **BUILT** (running on the live path) · **DESIGNED-TARGET**
(coded/tested but not on the live path, or planned) · **REGISTERED-DISABLED** (declared, fails
closed, intentionally off).

---

## Table of contents

1. Architecture & flow
2. Data engineering (Spark / Iceberg)
3. Identity resolution pipeline
4. Neo4j graph model
5. Probabilistic matching (rule-based now → Splink target, review-gated)
6. Customer360 contract
7. Operational (monitoring / DLQ / retry / review)
8. Security (isolation / PII / encryption / crypto-shred)
9. Scalability
10. AI / MCP integration

Each major module is specified with: **Purpose / Inputs / Outputs / Dependencies / Processing
logic / Incremental strategy / Replay strategy / Failure handling / Performance / Scalability /
Monitoring.**

A consolidated **defect register** (F1–F4, M1–M3, plus index/isolation/contract items) and a
priority backlog close the document.

---

## 1. Architecture & flow

### 1.1 The deterministic spine (BUILT)

The live resolution path is single-responsibility and cleanly layered:

```
IdentityBridgeConsumer            (apps/stream-worker/src/main.ts:233-261)
  → ResolveIdentityUseCase.execute (apps/stream-worker/src/application/ResolveIdentityUseCase.ts)
    → IdentityResolver.resolve     (apps/stream-worker/src/domain/identity/IdentityResolver.ts)  [PURE]
      → Neo4jIdentityRepository.writeOutcome
          (apps/stream-worker/src/infrastructure/neo4j/Neo4jIdentityRepository.ts)
            ├─ Neo4j graph mutation (SoR)
            └─ PG identity_audit + contact_pii (vault + ledger)
```

Layering verdict: clean. `IdentityResolver` is a pure function; `IdentityStore`
(`domain/identity/IdentityStore.ts`) is the port; `Neo4jIdentityRepository` is the SoR adapter;
the Spark marts are pure projections. Preserve this separation.

### 1.2 The unwired domain layer (DESIGNED-TARGET — finding F1, HIGH)

A large, well-tested domain layer exists but is **not on the live write path**:

- `domain/identity/confidence/ConfidenceEngine.ts`
- `domain/identity/decisions/{DecisionEngine,DecisionLogRepository,EvidenceStore}.ts`
- `domain/identity/matchers/{ProbabilisticMatcher,MatcherRegistry,DisabledMatchers}.ts`
- `domain/identity/IdentityTimeline.ts`

Grep confirms **zero** non-test, non-domain importers of `ConfidenceEngine`, `DecisionEngine`,
`createDefaultMatcherRegistry`, or `ProbabilisticMatcher` inside the running stream-worker. Yet weak
signals (`cookie_id` / `ip` / `device_fingerprint` / `session_id`) ARE extracted
(`extract-identifiers.ts:206-221`, re-extracted inline in `ResolveIdentityUseCase.ts:298-312`) and
ARE persisted to Neo4j as `tier='weak'` `IDENTIFIES` edges (on mint, `newLinks = identifiers` — all
tiers, `IdentityResolver.ts:255`).

**Consequence:** weak edges accumulate as dead graph weight and a privacy surface (hashed IP/cookie
edges) but are never read for review-routing. This "extract + persist + never consume" middle state
is the worst option. See §3.4 and §5 for the wiring fix.

### 1.3 The 3-hop enrichment chain (BUILT — document the ordering)

Customer360 enrichment freshness depends on a 3-hop deterministic chain:

```
Neo4j graph → identity-export job → journey-stitch-from-identity job → gold_customer_360
```

`gold_customer_360.py` enrichment columns (`last_activity_at`, channel/device/category) depend on
`silver_touchpoint.stitched_brain_id`, populated by `jobs/journey-stitch-from-identity.ts`, which
depends on the `jobs/identity-export/` projection of Neo4j. Cold-cycle NULL handling is correct
(honest-empty), but the refresh loop **must run the jobs in this order** or enrichment is
perpetually one cycle stale. Document the ordering dependency in `tools/dev/v4-refresh-loop.sh`.

**Monitoring:** emit a per-hop freshness watermark (max processed event timestamp per stage) so the
3-hop lag is measurable, satisfying the "confidence and freshness measurable" review-checklist item.

---

## 2. Data engineering (Spark / Iceberg)

Spark is the sole compute. All marts live in `db/iceberg/spark/{silver,gold}/`. Serving reads only
`brain_serving.mv_*` Trino views (`db/trino/views/`).

### 2.1 MODULE — Bronze raw landing (`db/iceberg/spark/silver/.../bronze_raw_landing.py` family)

- **Purpose:** durable, exactly-once landing of Kafka events into append-only Iceberg Bronze.
- **Inputs:** Kafka topics (KRaft), prefixed by `NODE_ENV` (`dev.*` / `prod.*`).
- **Outputs:** Iceberg Bronze tables in `brain_bronze_local`.
- **Dependencies:** Spark Structured Streaming, Iceberg REST catalog, MinIO/S3, Redpanda/Kafka.
- **Processing logic:** `foreachBatch` commits Kafka offsets **only after** the durable Iceberg
  append, plus `MERGE WHEN NOT MATCHED` on the physical coordinate `(topic, partition, offset)`.
  Two-phase `availableNow → continuous` start avoids the cold-start deadlock.
- **Incremental strategy:** append-only; offset-after-commit is the watermark.
- **Replay strategy:** replay-safe — coordinate-MERGE makes re-landing idempotent.
- **Failure handling:** crash before offset commit ⇒ re-read same batch ⇒ MERGE dedups. No event loss.
- **Performance:** sink heap tuned to 4g (OOM history); `--driver-memory 3g` on crons.
- **Scalability:** horizontal via Kafka partitions; bucket-partitioned Iceberg downstream.
- **Monitoring:** lag = Kafka end-offset − committed-offset; batch duration; append row counts.

Verdict: **BUILT, enterprise-grade.** This is the strongest exactly-once contract in the system.
Do not weaken it.

### 2.2 MODULE — Silver/Gold marts (idempotent MERGE projections)

- **Purpose:** project Bronze → canonical Silver entities → Gold business marts.
- **Inputs:** upstream Iceberg tables + (for identity-linked marts) the identity export.
- **Outputs:** Iceberg Silver/Gold tables; served via `mv_*` Trino views.
- **Processing logic:** every mart is `MERGE INTO … ON <pk> WHEN MATCHED UPDATE / NOT MATCHED INSERT`
  with full restate semantics (`silver_customer.py:190`, `gold_customer_360.py:388`,
  `silver_journey.py:222`). Incremental fold yields the same end-state as a full rebuild.
- **Incremental strategy:** full-projection MERGE (no per-mart watermark) — correct but O(graph). The
  one true incremental + tombstone design is the identity-export job (§3.5); keep the Spark
  `silver_customer_identity.py` **full** projection parity-tested against it.
- **Replay strategy:** MERGE-on-PK is replay-idempotent; re-running a mart converges.
- **Partitioning:** tenant-first `bucket(N, brand_id)` (+ `days()` time partition on journey). Bucket
  counts vary by cardinality (8 / 16 / 256). **Action:** document the bucket-count convention in
  `db/iceberg/spark/README` so it reads as intent, not drift.
- **Schema evolution:** Iceberg native; marts are full-projection MERGEs, so added columns backfill
  on next run.
- **Performance:** full projection is the cost driver at scale; mitigate with partition pruning
  (`brand_id` bucket) and, for the heaviest aggregates, a genuine pre-aggregate (§9.1).
- **Monitoring:** per-mart row count, MERGE matched/inserted split, run duration, parity-oracle delta.

### 2.3 MODULE — `silver_journey.py` (sessionization)

- **Processing logic:** dedups the Bronze idempotency key (`event_id`, line 169) **before**
  sessionizing, then re-derives server-side 30-minute sessions from Bronze timestamps (never trusts
  client clocks). Verdict: **BUILT, correct.**

### 2.4 MODULE — `silver_customer_identity.py` (Neo4j → Iceberg projection)

- **M3 (MED) — single-scan fragility:** must `.collect()` the Neo4j read to the driver and rebuild a
  DataFrame because the Neo4j Spark connector closes its channel pool after the first action
  (line 177, documented). Caps this mart at driver-memory scale. **Action:** acceptable now; when
  customer cardinality grows, paginate the Neo4j read (keyset on `brain_id`) and union the page
  DataFrames, or prefer the TS `identity-export` incremental path as the canonical producer and make
  the Spark version a parity check only.

---

## 3. Identity resolution pipeline

### 3.1 MODULE — Identifier extraction, normalization, hashing (BUILT)

- **Purpose:** turn a raw event payload into a typed, salted-hashed `ExtractedIdentifier[]`.
- **Inputs:** event payload; per-brand salt (PG, via vault); per-subject salt.
- **Outputs:** typed identifiers `{type, hash, tier}` with `tier ∈ {strong, medium, weak}`.
- **Dependencies:** `packages/identity-core/src/index.ts`, `packages/pii-vault/src/index.ts`.
- **Processing logic:** `extract-identifiers.ts` decides `no_identifiers` **before** fetching the salt
  (good — avoids a salt round-trip on empty events). Hashing is SHA-256 with per-brand salt and a
  hard-crash D-2 guard if the salt/keyring is missing (`identity-core/index.ts`). `pre_hashed_*`
  identifiers live in a distinct namespace so connector-pre-hashed and first-party hashes never
  collide — the correct design for continuity-repair.
- **Replay strategy:** deterministic — identical payload + salt ⇒ identical hashes.
- **Failure handling:** missing salt ⇒ hard crash (fail-closed), not a silent low-confidence hash.

**M1 (MED) — duplicate extraction path.** `ResolveIdentityUseCase.ts:91-312` re-implements the entire
extractor inline ("byte-for-byte mirror", per its own comment at line 8). Two copies of
precedence/regex/tier logic must stay identical or the operator replay path
(`jobs/identity/replay-identity`) and the live path mint divergent hashes for the same customer — the
exact bug class the module prevents.
- **Fix:** collapse the live use-case onto `extractRawIdentifierFields` + `buildIdentifiers` from
  `extract-identifiers.ts`.
- **Interim guard:** pin a cross-path conformance test (same payload → identical
  `ExtractedIdentifier[]` from both paths) in CI until the inline copy is removed.

**M3 (MED) — non-IN phone normalization absent.** `normalizePhone` knows only `IN`
(`REGION_PREFIX` has a single entry, `identity-core/index.ts:107`). Non-IN numbers fall to the
digit-stripped low-confidence path, so e.g. UK `+447…` and `07…` for the same number hash
differently ⇒ split identity. Given GCC/multi-currency onboarding, this is a live gap.
- **Fix:** extend `REGION_PREFIX` per onboarded region, or adopt `libphonenumber` and store the
  E.164 form before hashing. Phone tier stays `strong` only when normalized to E.164; otherwise mark
  `weak`.

### 3.2 MODULE — Deterministic matching (union-find) (BUILT)

- **Purpose:** group identifiers into one `brain_id` using strong-key union-find.
- **Processing logic:** strong-only merge keys; medium tier (device/anon) is **resolve-only** with the
  `union.size === 1` adoption guard (`IdentityResolver.ts:204-230`) that structurally prevents a
  shared device from folding two distinct people. This is the correct invariant — preserve it.
  Deterministic `merge_id` (D-4) and `decisionId` derive UUIDs from SHA-256, so replays are
  ON-CONFLICT-idempotent.
- **Replay strategy:** partition signature (which identifiers group together) is deterministic — see
  `IdentityReplayEngine` (§3.6). Labels are NOT (M2 below).

**F3 (MED) — N-way merge converges only one pair per event.** When one event matches ≥3 distinct
`brain_id`s, `resolve` emits a single `MergeSpec(canonical=sortedIds[0], merged=sortedIds[last])`
(`IdentityResolver.ts:286-312`) — the **middle ids are left unmerged** until a future event
re-triggers, and because `newLinks=[]` on merge they are not re-pointed either. `batchResolve`
(`DeterministicUnionFindMatcher`) handles N-way correctly, so the system is only eventually consistent
if the batch/replay path runs. Live, a 3-way co-occurrence leaves the graph transiently split.
- **Fix:** in `IdentityResolver.resolve`, emit a `MergeSpec` for **every** non-canonical member
  (mirror the `batchResolve` loop) in one outcome, and re-point each (see F2).

**M2 (MED) — `randomUUID()` mint ⇒ non-deterministic replay labels.** `IdentityResolver.ts:250`
mints `brain_id` from `randomUUID()`. `IdentityReplayEngine` guarantees the partition *signature*,
not the *labels*; a from-scratch replay after a graph purge yields different `brain_id`s, shifting
every downstream brain_id-keyed mart.
- **Fix:** mint `brain_id` deterministically from the lowest strong identifier hash (same technique as
  `computeMergeId`). This makes replay/backfill label-stable and removes the need for the label-free
  signature workaround.

### 3.3 MODULE — Merge consolidation (F2, HIGH — most important correctness finding)

Today merge does **not** consolidate downstream identity, and order→brain_id is not alias-resolved:

- `IdentityResolver.resolve` on `merged` returns `newLinks: []` (`IdentityResolver.ts:311`).
- `Neo4jIdentityRepository.writeOutcome` creates the `ALIAS_OF` edge and sets the merged Customer
  `lifecycle_state='merged', merged_into=canonical` (lines 240-274) but **never re-points the merged
  customer's `IDENTIFIES` edges to the canonical node.**
- `readState` matches `(i:Identifier)-[r:IDENTIFIES]->(c:Customer)` and returns `c.brain_id`
  **without following `ALIAS_OF`** (lines 116-130). After a merge, the merged customer's identifiers
  still resolve to the dead `brain_id`.
- Downstream, `silver_order_state.py` resolves `brain_id` from `ops.silver_identity_link`
  (`MIN(brain_id)` per `pre_hashed_email`, lines 109-120) **without** joining `merged_into`;
  `silver_customer.py` filters `lifecycle_state <> 'merged'` (line 118) but groups the order rollup by
  the raw `brain_id`. Net: a merged customer's orders form their **own** `silver_customer` row under
  the dead `brain_id` ⇒ **LTV splits across the merge boundary**, defeating the purpose of merge.

**Required repair — pick ONE and apply end-to-end:**

1. **Re-point on merge (graph-canonical):** in `writeOutcome` merge branch, move the merged node's
   active `IDENTIFIES` edges to the canonical customer:
   ```cypher
   MATCH (m:Customer {brand_id:$b, brain_id:$merged})<-[r:IDENTIFIES {is_active:true}]-(i:Identifier)
   MATCH (c:Customer {brand_id:$b, brain_id:$canonical})
   MERGE (i)-[:IDENTIFIES {tier:r.tier, ...}]->(c)
   // close r's interval (see §4 temporal model), do not destructively delete
   ```
   AND emit a `MergeSpec` per non-canonical member (F3).
2. **Alias-resolve on read/export:** make `readState` and the `identity-export` job chase
   `ALIAS_OF` / `merged_into` to the canonical before returning/projecting `brain_id`, and have
   `silver_order_state` join `silver_customer_identity.merged_into` to fold orders onto canonical.

Option 1 is preferred (keeps the graph self-canonical and read paths simple). **Parity test
(blocking):** merge two customers each with one order; assert Customer360 shows one row with
`lifetime_orders = 2` and a single summed `lifetime_value_minor`.

### 3.4 MODULE — Weak-signal handling (F1 wiring — see §5 for activation)

Weak signals are extracted and persisted as `tier='weak'` `IDENTIFIES` edges but never consumed.
Until the ConfidenceEngine/ProbabilisticMatcher is wired (§5), either:
- (a) wire the matcher so weak edges drive review-routing, OR
- (b) **stop extracting/persisting weak signals** to avoid storing IP/cookie hashes you never consult.

Do not keep the current "extract + persist + never consume" middle state.

### 3.5 MODULE — `identity-export` job (BUILT — exemplary incremental design)

- **Purpose:** incrementally project Neo4j identity into `ops.silver_identity_link` for Spark marts.
- **File:** `apps/stream-worker/src/jobs/identity-export/run.ts`.
- **Incremental strategy:** `created_at` watermark **plus** an always-re-pulled bounded set of
  inactive/non-active customers. Rationale (correct): a `created_at` watermark alone would miss
  `SET is_active=false` / lifecycle mutations that carry no new timestamp, so the job always re-pulls
  the bounded tombstone/lifecycle set. This is a genuinely good piece of incremental design.
- **Caveat:** `silver_customer_identity.py` re-implements the same export as a **full** projection
  (line 94 docstring). Two code paths produce the same table — keep them parity-tested.
- **Action under F2:** add `merged_into` (alias resolution) to the export so downstream order
  recognition folds onto canonical.

### 3.6 MODULE — Replay engine (BUILT — strong determinism harness)

- **File:** `apps/stream-worker/src/domain/identity/IdentityReplayEngine.ts`.
- **Purpose:** prove order-independence — stream-vs-batch partition-signature equality across event
  permutations (`assertOrderIndependent`). Excellent. Its only limitation (label-free signatures only)
  ties directly to M2 (random mint); fixing M2 lets the harness assert label-stable replay too.

---

## 4. Neo4j graph model

Files: `apps/stream-worker/src/infrastructure/neo4j/Neo4jIdentityRepository.ts`,
`apps/core/src/modules/identity/internal/infrastructure/neo4j-identity-reader.ts`. ADR-0004.

### 4.1 Model (BUILT — sound shape)

- **Nodes:** `:Identifier {brand_id,type,hash}`, `:Customer {brand_id,brain_id,lifecycle_state,
  merged_into,first_identified_at,…}`, `:MergeEvent {merge_id,…}`, `:SharedUtility` (phone-guard),
  `:MergeReview`.
- **Edges:** `(:Identifier)-[:IDENTIFIES {tier,is_active,confidence_score,…}]->(:Customer)`,
  `(:Customer)-[:ALIAS_OF {merge_id,valid_from,valid_to}]->(:Customer)`.
- Identifiers as first-class nodes is correct (one hash fans out to its IDENTIFIES edges in
  O(degree)). Confidence/provenance is integer-only, version-pinned, stamped on every edge and
  MergeEvent (lines 207-265).

**Neo4j is relationship-intelligence ONLY, not operational.** The immutable `identity_audit` ledger
and raw-PII `contact_pii` vault stay in PostgreSQL; brand phone-guard config is read from PG `brand`
(`readBrandConfig`, lines 318-335). The graph holds hashes only. This matches ADR-0004 and the
approved architecture — preserve it.

### 4.2 GAP — indexes (HIGH PRIORITY)

`bootstrap()` (lines 78-96) creates only 4 uniqueness constraints. Every hot-path filter/sort
predicate is **unindexed**:
- `readState` windowed phone count filters `r.created_at > $cutoff`, `r.is_active`.
- `listCustomers` filters `c.lifecycle_state`, `ORDER BY c.created_at DESC` (reader 152/174).
- `listMergeReviews` filters `mr.status='pending'`, `ORDER BY mr.created_at` (reader 200-203).
- `activeCustomerCount` filters `c.lifecycle_state='active'`.
- `purgeBrand`/erase scans `MATCH (n) WHERE n.brand_id=$b` — a **label-less full-store DETACH
  DELETE** (line 399), catastrophic at scale.

**Fix — add to `bootstrap()`:**
```cypher
CREATE INDEX customer_brand_lifecycle IF NOT EXISTS FOR (c:Customer) ON (c.brand_id, c.lifecycle_state);
CREATE INDEX customer_brand_created   IF NOT EXISTS FOR (c:Customer) ON (c.brand_id, c.created_at);
CREATE INDEX mergereview_brand_status IF NOT EXISTS FOR (mr:MergeReview) ON (mr.brand_id, mr.status);
CREATE INDEX identifies_active_created IF NOT EXISTS FOR ()-[r:IDENTIFIES]-() ON (r.is_active, r.created_at);
```
Replace `purgeBrand`'s label-less `MATCH (n)` with per-label, brand-scoped, batched deletes:
`CALL { MATCH (c:Customer {brand_id:$b}) DETACH DELETE c } IN TRANSACTIONS OF 10000 ROWS` (repeat per
label).

### 4.3 WEAKNESS — single brand-isolation seam (`withGraphBrand`) missing

ADR-0004 §4 mandates "per-brand isolation enforced at a single application seam (`withGraphBrand`)…
with a non-inert mutation proof in the isolation-fuzz suite." `withGraphBrand` **does not exist** —
every Cypher inlines `{brand_id:$b}`. Two real holes:
- `unmergeCustomer` (reader 251-261): `OPTIONAL MATCH (m)-[a:ALIAS_OF]->()` and the canonical it
  re-points to are **not** brand-scoped on the target side (only `m` is).
- `resolveMergeReview` approve path (reader 232-239) trusts `brain_id_a/brain_id_b` from the review
  node without re-asserting both customers share `$b`.

**Fix:** introduce `withGraphBrand(session, brandId, cypher, params)` as the ONLY way app code runs
Cypher. It (a) asserts every `$brand*` param equals `brandId`, (b) brand-guards the query, and (c) is
lint-enforced as the sole Cypher entry point. Add the **non-inert isolation-fuzz test** the ADR
demands: disable the predicate → the test MUST observe a cross-brand leak (i.e., fail) — no
Neo4j-specific isolation-fuzz test exists today.

### 4.4 WEAKNESS — temporal model is partial (replay/audit gap)

`ALIAS_OF` is bitemporal-ready (`valid_from`/`valid_to`), but `IDENTIFIES` edges are **mutated in
place** (`is_active=false` on erase/unmerge, lines 217/280) instead of interval-closed. You can
reconstruct merge history but not link history ("when did this identifier attach/detach?"). For a
"Capture Truth / replay + audit" product this is a real gap.
- **Fix:** give `IDENTIFIES` `valid_from`/`valid_to`; never destructively flip `is_active` — close the
  interval. The PG `identity_audit` ledger is the backstop, but the graph should be self-describing
  for traversal-time-travel.

### 4.5 Edge cases (verify / harden)

- **Erase vs canonical inheritance:** `eraseCustomer` tombstones a customer's edges but does not walk
  `ALIAS_OF`; erasing a canonical that has aliases leaves aliases pointing at an erased node
  (orphaned subgraph). Verify intended; if not, cascade to aliases.
- **`merged_into` denormalization:** scalar `merged_into` duplicates the `ALIAS_OF` edge (lines 247 vs
  255). Two sources of truth; unmerge updates both (reader 255) but a future bug could desync.
  **Fix:** derive `merged_into` from the edge at read time, or add a consistency check job.
- **`getCustomer360` alias chain:** does not resolve alias → canonical before returning identifiers; a
  merged brain_id returns only its own edges. Confirm the BFF resolves canonical first (also covered by
  F2 option 1).
- **No Neo4j tx timeout / deadlock policy:** PG has `statement_timeout` (line 73); Neo4j has none.
  Concurrent merges on a shared `SharedUtility` phone node contend. neo4j-driver 5 `executeWrite`
  retries transient errors — set an explicit `maxTransactionRetryTime`.

### 4.6 PERFORMANCE — N+1 phone counts

`readState` issues one Cypher round-trip **per phone hash** in a loop (lines 156-164). For multi-phone
events this is N round-trips and the biggest throughput risk in the resolve hot path.
- **Fix:** fold into a single `UNWIND $hashes AS h MATCH (i:Identifier {brand_id:$b, type:'phone',
  hash:h})-[r:IDENTIFIES {is_active:true}]->(c) WHERE r.created_at > $cutoff RETURN h, count(c)`.

---

## 5. Probabilistic matching (rule-based now → Splink target, review-gated)

Files: `domain/identity/matchers/{ProbabilisticMatcher,MatcherRegistry,DisabledMatchers}.ts`,
`domain/identity/confidence/ConfidenceEngine.ts`, `packages/contracts/src/identity/matcher.ts`.

### 5.1 State: BUILT but DORMANT (the single most important wiring finding)

The matcher and its safety rails are correctly built, pure, tested, and structurally safe:
- Hard cap `MAX_PROBABILISTIC_SCORE = 95 < 100` (line 81); `subExactBand` can never return `'exact'`
  (lines 86-91) with a defense-in-depth throw (lines 171-172).
- `ConfidenceEngine.assess` consults probabilistic **only when no strong key and no medium adoption**
  (deterministic-first, lines 298-309), clamps to `exact-1`, appends `route_to_review:
  probabilistic_match`.
- `isMergeEligible` returns true ONLY for band `'exact'` (lines 198-200) ⇒ probabilistic can **never
  auto-merge**.

**But the live `ResolveIdentityUseCase` never instantiates `ConfidenceEngine` /
`ProbabilisticMatcher`.** No live consumer fetches weak candidates, runs the matcher, or creates a
probabilistic `:MergeReview`. The only `:MergeReview` rows written today come from the **deterministic**
cycle-guard / suppressed-phone path (`outcome.routeToReview`, repo lines 294-305). `ResolveOutcome`
has no probabilistic-review field. Net: a registered, `status:'enabled'`, fully-safe component that
produces **no live effect**.

### 5.2 Activation (DESIGNED-TARGET — preserve every safety invariant)

1. In `ResolveIdentityUseCase`, after the deterministic resolve returns `action:'minted'` (no
   strong/medium match), fetch weak candidates via a new brand-scoped `readWeakState` repo method:
   ```cypher
   MATCH (i:Identifier {brand_id:$b})-[r:IDENTIFIES {is_active:true}]->(c)
   WHERE [i.type, i.hash] IN $weakPairs
   RETURN c.brain_id, collect([i.type,i.hash]) AS agreements
   ```
   (uses the `identifies_active_created` index from §4.2).
2. Build `ConfidenceEvidence.weakMatches`, call `ConfidenceEngine.assess`. If the verdict carries
   `route_to_review:probabilistic_match`, set `outcome.routeToReview=true` with a distinct
   `reviewReason='probabilistic_weak_signal'`, persist a `:MergeReview` (the existing repo path already
   handles it — just feed it).
3. The review queue UI (`Neo4jIdentityReader.listMergeReviews` / `resolveMergeReview`) already exists;
   probabilistic candidates flow through the same human-approve gate. Approve **never** auto-fires from
   the score — keep it human-gated.

If activation is deferred, apply §3.4(b): stop persisting weak edges.

### 5.3 Wire the DecisionEngine + audit reconciliation (F1 + F4 together)

When activating, route the outcome through `DecisionEngine` so the reversible-command / Decision-Log /
`IdentityTimeline` machinery becomes live, and make `identity_audit` a **projection of the decision-log**
rather than a hardcoded side-write (see §7.2 / F4). Today the Neo4j repo **hardcodes** the verdict it
stamps (`DETERMINISTIC_CONFIDENCE_SCORE=100`, `band='exact'`, `matcher_id='deterministic-union-find'`,
lines 46-49) instead of consuming a real `ConfidenceVerdict`. Fine while only the deterministic matcher
runs, but once probabilistic is live the repo must stamp the **actual** verdict, not a constant.

### 5.4 Assessment vs the Splink target

| Splink capability | Current rule-based matcher | Gap |
|---|---|---|
| Blocking rules | Implicit exact-hash equality on weak keys (`candidateWeakKeys`, 122-127) | No declarative blocking; candidate set is whatever the caller pre-fetches. Fine at low volume. |
| Comparison levels | Binary exact-agree per signal (127, 137-140) | No graded comparison (partial IP-subnet, fuzzy device). Hash-only forecloses fuzzy string by design. |
| EM-trained weights (m/u) | Hand-set conservative `DEFAULT_PROBABILISTIC_WEIGHTS` (69-75) | **Core gap.** No data-driven m/u, no match-weight = log2(m/u). |
| Feature selection | Fixed 4 weak signals (`WEAK_SIGNAL_TYPES`, 42-47) | Static; no importance/selection. |
| Model persistence/versioning | `version='v1-fellegi-sunter'` string (36,100) | Version string only; no serialized artifact, no registry row. (ML matchers are deliberately REGISTERED-DISABLED in `DisabledMatchers.ts`.) |
| Drift detection | None | No score-distribution monitoring (PSI/KL). |
| Thresholds | Static `SUB_EXACT_BANDS {high:80, medium:45, low:1}` (84) | Not calibration-derived; arbitrary cutpoints. |
| Performance | Pure, O(agreements), order-independent (sorted combo, 134,157) | Excellent for a rule engine. |

### 5.5 Evolution path: rule-based → Splink (review-gated, never auto-merge)

The `Matcher` port (`matcher.ts:49-54`), `MatcherRegistry`, and the `ConfidenceEngine` clamp are the
exact seams Splink plugs into. Phased:

1. **Activate the current matcher first** (§5.2) so a labeled review corpus accumulates. Human
   approve/reject on the `:MergeReview` queue **are** the training labels — persist each decision
   (approve/reject + the weak `identifier_combo`).
2. **Offline Splink EM training as a Spark (PySpark) job** under `db/iceberg/spark/` — Spark is the
   approved sole compute. Train m/u from the Silver identity spine + review labels. Output a serialized
   model (m/u + thresholds) to a versioned artifact + a model-registry row (mirror the
   registered-disabled `ml-embedding-similarity` descriptor → flip to a trained-weights descriptor).
3. **Load learned weights into the SAME `ProbabilisticMatcher` shape** — replace
   `DEFAULT_PROBABILISTIC_WEIGHTS` with trained `match_weight` per comparison level; keep
   `MAX_PROBABILISTIC_SCORE` and `subExactBand` UNCHANGED. Only the weight source changes; the matcher
   stays pure. Even a high Splink probability still routes to review — never auto-merges.
4. **Calibrate thresholds** from the trained match-probability distribution (replace 80/45/1) and add
   **drift detection**: a scheduled Spark job comparing live weak-signal score distribution vs training
   (PSI), alerting on drift.
5. **Keep ML/household/cross-device REGISTERED-DISABLED** until each is independently trained +
   review-gated. Preserve the `DisabledMatcher` throw-don't-fake discipline (`matcher.ts:79-89`).

**Non-negotiable invariants to preserve across the whole evolution (CI-gated):** weak-only feature set
(Splink must never read a strong key as a merge key), the sub-exact hard cap (≤95), the human-review
gate, integer-only scores, hash-only inputs, brand_id-first candidate scoping (`match()` lines
121-123). Keep `ProbabilisticMatcher.test.ts` invariant assertions (band ≠ exact, score ≤ 95) as the
regression gate.

---

## 6. Customer360 contract (Phase-1 → Phase-2 handoff)

Files: `packages/contracts/src/api/intelligence.api.v1.ts` (L301-387 `Customer360ContractSchema`),
`intelligence.customer360.recomputed.v1.ts`, `customer360-contract.contract.test.ts`,
`apps/core/.../queries/get-customer-360.ts`, `db/iceberg/spark/gold/gold_customer_360.py`,
`db/trino/views/mv_gold_customer_360.sql`.

### 6.1 State: BUILT (schema + registry + receipt event + contract tests)

One denormalized row per `(brand_id, brain_id)`. Money as bigint-minor strings (`MinorUnitsSchema`)
with one sibling `currency_code`; `churn_score` a non-blended int 0-100; closed
`health_band`/`lifecycle_state`/`lifecycle_stage` enums; brand_id-first PK enforced in tests (L59-64);
a `GOLD_DATA_PRODUCT_REGISTRY` definition-of-done gate pinning the served `mv_gold_customer_360` Trino
view. The recompute receipt `intelligence.customer360.recomputed.v1` mirrors `cache.invalidate.v1`:
PII-free, money-free, brand_id-required, carries `snapshot_id` + `reason` enum + `CacheScope`.

`gold_customer_360.py` is well-built: existing columns byte-identical to the dbt predecessor; all B2
enrichment columns are optional LEFT JOINs that degrade to typed NULL (honest-empty); money discipline
correct — `aov_minor = lifetime_value_minor div lifetime_orders` is exact integer minor-unit division
under one `currency_code` (line 358); deterministic MODE helper (count desc, value asc). Subject to F2,
the per-customer roll-up is correct.

### 6.2 GAP A1 (HIGH) — no temporal/version stamp ON the row

`Customer360ContractSchema` has no `snapshot_id`, `computed_at`/`as_of`, or `contract_version`. The
recompute *event* carries `snapshot_id` (L48) but the *row* Phase-2 binds to does not. A Phase-2
consumer cannot tell which Iceberg snapshot a row reflects, cannot do as-of joins, cannot detect
staleness.
- **Fix:** add `snapshot_id: z.string().nullable()`, `computed_at: z.string()` (ISO),
  `contract_version: z.literal('1')`. Have `gold_customer_360.py` project Iceberg `_snapshot_id` +
  refresh wall-clock onto the row; surface both in `mv_gold_customer_360.sql`.

### 6.3 GAP A2 — asymmetric nullability breaks honest-empty

`segment` (L369) and `acquisition_source` (L371) are required `z.string().min(1)`, but
`lifecycle_stage` and all B2 enrichment fields are `.nullable()`. A genuinely cold customer
(identified, zero journey, unsegmented) cannot satisfy the contract without a sentinel string,
violating the project's honest-null rule.
- **Fix:** make `segment` and `acquisition_source` `.nullable()`, or document a mandated sentinel as a
  closed enum member.

### 6.4 WEAKNESS — `brain_id` typed inconsistently

Contract: `z.string().min(1)` (fixture `'brn_abc123'`). Use-case `get-customer-360.ts` L18/76: validated
against `UUID_RE`, fails-closed on non-UUID. Neo4j mints UUIDs. The wire contract is looser than the
runtime.
- **Fix:** tighten contract `brain_id` to the UUID regex (or a branded `BrainIdSchema`) so contract and
  SoR agree. (Coordinate with M2 if mint becomes a deterministic non-UUID hash — pick the canonical
  format once.)

### 6.5 WEAKNESS — three colliding "Customer360" shapes

`identity.api.v1.Customer360` (graph control-plane), `intelligence.api.v1.Customer360Contract` (BI row),
metric-engine `Customer360SummaryLike` (brand aggregate). Doc-comments acknowledge it (L335-340).
- **Fix:** rename to `IdentityCustomer360` / `Customer360BiRow` / `Customer360BrandSummary`.

### 6.6 MODULE summary — `gold_customer_360`

- **Purpose:** the Phase-1→Phase-2 denormalized handoff row.
- **Inputs:** `silver_customer` (roll-up), `silver_touchpoint.stitched_brain_id` (enrichment),
  `silver_order_state` (orders).
- **Outputs:** Iceberg Gold `gold_customer_360`; served `mv_gold_customer_360`.
- **Incremental strategy:** Spark MERGE on `(brand_id, brain_id)` driven by
  `IScopedRecomputeRepository.upsert()`.
- **Replay:** MERGE-on-PK idempotent.
- **Failure handling:** enrichment LEFT JOINs degrade to typed NULL (honest-empty).
- **Monitoring:** add the freshness watermark (A1) so incremental staleness is visible to consumers.

---

## 7. Operational (monitoring / DLQ / retry / review)

Files: `apps/stream-worker/src/application/EraseSubjectUseCase.ts`,
`infrastructure/pg/DlqRecordRepository.ts`, `infrastructure/redis/RetryCounterAdapter.ts`,
`jobs/dlq-redrive/run.ts`, `apps/core/src/modules/ai/mcp/dispatch-wiring.ts`.

### 7.1 State: PARTIAL — strong stream-worker DLQ/retry; thin MCP-path observability

The ingestion/erasure path is enterprise-grade: bounded retry (`RetryCounterAdapter`) → DLQ
(`DlqRecordRepository`) → `dlq-redrive` job. `EraseSubjectUseCase` is fail-closed (salt failure ⇒ no
offset commit ⇒ DLQ after MAX_RETRY; "an erasure must not be lost"). Manual review is first-class:
merges cap at 95 and route to `MergeReview`/`MergeReviewList` — never auto-merge.

### 7.2 F4 (HIGH-ish) — `identity_audit` not replay-idempotent; cross-store write non-transactional

`writeOutcome` does the Neo4j tx, then a **separate** PG tx for `identity_audit` + `contact_pii`
(`Neo4jIdentityRepository.ts:308-309, 338-393`). The Kafka offset commits only after the whole
`execute()` returns (`IdentityBridgeConsumer.ts:84`), so any failure replays the entire event. Neo4j
writes are MERGE-idempotent and `contact_pii` has `ON CONFLICT DO NOTHING` — but the `identity_audit`
INSERT has **no idempotency key / ON CONFLICT** (line 348). A retry or Bronze replay **duplicates the
immutable compliance ledger.** A crash between the Neo4j commit and the PG commit leaves the graph
ahead of the ledger.
- **Fix:** give `identity_audit` a deterministic natural key (e.g. `DecisionEngine.decisionId`) with
  `ON CONFLICT DO NOTHING`, and write the audit row inside the same logical unit as the graph mutation
  — or, preferably, make `identity_audit` a **projection of the decision-log** (write the decision-log
  first as the SoR of intent, then project both Neo4j and audit from it).
- The audit row today records only `action ∈ {mint, link, merge}` and never the
  `route_to_review`/`suppress`/`unmerge` commands the DecisionEngine models — wiring §5.3 fixes this too.

### 7.3 GAP — MCP dispatch has zero audit/observability

`dispatchMcpTool` (`mcp-dispatch.ts:501`) emits no structured log, no `correlation_id`, no per-tool
latency/error metric, no audit row of *which principal invoked which tool against which brain_id*. For
an LLM-facing read surface over PII-adjacent intelligence, every call should be audited.
- **Fix:** wrap `createMcpDispatch` (`dispatch-wiring.ts:113`) with a child logger
  (`correlation_id`+`brand_id`, per the project structured-logging standard) and an append-only
  `ai.mcp_tool_call_log` (tool name, principal brand_id, brain_id arg, latency, outcome) — counts/hashes
  only, no raw output.
- Add counters on `error.code` (`NOT_IMPLEMENTED_YET`, `MCP_PRINCIPAL_NO_SCOPE`, `MCP_UNKNOWN_TOOL`) so
  disabled-tool / scopeless-principal hits are visible to alerting.

### 7.4 WEAKNESS — erasure step 4 (Iceberg compaction) REGISTERED-DISABLED

`EraseSubjectUseCase` honestly documents that a shredded subject can be resurrected from old Iceberg
snapshots and that in-pipeline compaction throws `NotImplementedYet` (caught, logged, not
retried/DLQ'd). Correct honest posture but a live compliance residual — see §8.1.

### 7.5 Review queue (BUILT)

Reviews flow `Neo4jIdentityReader.listMergeReviews` → human approve/reject →
`Neo4jIdentityReader.resolveMergeReview`. Harden with the brand-scope re-assertion (§4.3) and feed
probabilistic candidates (§5.2).

---

## 8. Security (isolation / PII / encryption / crypto-shred)

Files: `db/migrations/0114_subject_crypto_shred.sql`, `db/migrations/0115_shred_subject_keyring_fn.sql`,
`packages/pii-vault/src/index.ts`, `apps/core/.../identity-timeline-reader.ts`,
`apps/core/.../queries/get-customer-360.ts`.

### 8.1 State: BUILT — strong. Per-subject crypto-shred is well-designed

- **Per-subject envelope encryption (0114):** `tenancy.subject_keyring` is brand_id-first PK,
  `FORCE ROW LEVEL SECURITY` with a brand-scoped policy; `brain_app` is SELECT-only; writes/reads go
  through `SECURITY DEFINER` `provision_subject_crypto` / `get_subject_keyring` (search_path-pinned);
  post-condition assertion guards in the migration. `contact_pii.subject_key_version` disambiguates
  subject-DEK vs legacy brand-DEK.
- **Crypto-shred (0115):** `shred_subject_keyring` is idempotent (`WHERE is_active=TRUE`, returns false
  on replay), `REVOKE ALL FROM PUBLIC` + EXECUTE to `brain_app`. The vault **fails closed** on
  `is_active=FALSE` (`pii-vault/src/index.ts:207-209`) at both brand and subject grain — the DEK is
  never served from cache after key-deny (SEC M-1).
- **PII hash-only** end-to-end: the contract row carries only `brain_id`/`brand_id`; identity DTOs carry
  a 12-hex salted-hash prefix only (`identity.api.v1.ts:30`); MCP `mapExplain` re-filters identifiers
  through `HEX12` (`mcp-dispatch.ts:289/364`).
- **Tenant isolation** is layered: RLS GUC (`set_config('app.current_brand_id')`) **plus** explicit
  `WHERE brand_id=$1`, even on the `rawPgPool` timeline reader (it sets the GUC manually — raw-pool use
  does NOT bypass isolation).

### 8.2 GAP C1 (HIGH compliance residual) — Iceberg snapshot erasure

Crypto-shred renders `contact_pii` unreadable, but Bronze/Silver Iceberg retain hash material in
historical snapshots; `erasure_raw_delete.py` is a manual step and in-pipeline compaction is
`NotImplementedYet`.
- **Fix (DPDP/GDPR "render unrecoverable"):** build erasure-aware compaction (expire snapshots / rewrite
  data files for the subject's brand partition) and wire it as erasure step 4 (with retry + DLQ, since
  "an erasure must not be lost"). Until then, **document the recovery-window exposure** explicitly in the
  compliance record.

### 8.3 WEAKNESS C2 — merge `confidence` unconstrained at the contract

`confidence` is an unconstrained `z.string()` (`identity.api.v1.ts:38`, mirrored in
`intelligence.api.v1`). The "cap 95, never exact, route to review" invariant lives only in the matcher,
not the contract.
- **Fix:** validate `confidence` as int 0-100 (or `.refine(v => Number(v) <= 95)` for probabilistic) at
  the contract so a bug emitting 100/auto-merge fails loudly at the seam. The MCP path already
  normalizes via `confidenceToInt` (L281-287), but the source contract should also constrain.

### 8.4 RBAC / audit

Identity admin actions (merge/unmerge/erase) flow through review + `pii_erasure_log` (append+update, no
DELETE). The MCP read surface is read-only by construction (§10). The one missing piece is the MCP-call
audit trail (§7.3). Close the `withGraphBrand` isolation seam + non-inert fuzz test (§4.3).

---

## 9. Scalability

Targets: 100k brands, billions of events, 100M+ customers.

### 9.1 WEAKNESS — `brain_serving.mv_*` are Trino VIEWS, not materializations

Despite the `mv_` prefix, these are logical Trino views over Iceberg (`db/trino/views/`).
`customer360_lookup` computes a full-brand aggregate (`customer_count`,
`total_lifetime_value_minor`) every call. For a 100M-customer brand each cache-miss is a full Iceberg
scan. Redis cache-aside (the approved Analytics Gateway) is the essential mitigation.
- **Verify:** the cache key includes the Gold `snapshot_id` (depends on A1) so invalidation is correct;
  confirm a TTL/refresh policy exists.
- **Improvement:** for the heaviest aggregates, back the view with a genuine materialized Gold rollup
  (brand-grain pre-aggregate in `db/iceberg/spark/gold/`) rather than a view, OR drive precise cache
  eviction from the recompute receipt event (§9.3).

### 9.2 WEAKNESS — single-currency-per-brand assumption in MCP money mapping

`mapCustomer360` pairs each top-customer's money with the **brand-level** `currency_code`
(`mcp-dispatch.ts:304-305`); `customerScore` folds brand currency onto the row
(`dispatch-wiring.ts:98-103`). With GCC/FX multi-currency, a customer transacting in a non-primary
currency is mislabeled.
- **Fix:** carry per-row `currency_code` from the mart; never inherit the brand default; never blend.

### 9.3 Per-subject cache-bust is best-effort

`intelligence.customer360.recomputed.v1` is OPTIONAL (event doc L13-15) with product-grain
`cache.invalidate.v1` as the floor. At 100M customers, product-grain busts are expensive.
- **Improvement:** make per-subject emission the **default** for `identity_merge` / `order_state_change`
  reasons (O(1 subject) eviction), reserving product-grain busts for `backfill` / `scheduled_refresh`.

### 9.4 Positives to preserve

brand_id-first PK on every product + the `${BRAND_PREDICATE}` Trino seam gives clean partition pruning;
the Spark MERGE incremental path scales horizontally; DLQ/retry is bounded; Bronze offset-after-commit
is replay-safe. The Neo4j N+1 (§4.6) and full-store purge (§4.2) are the two graph-side scale risks to
fix before large tenants onboard.

---

## 10. AI / MCP integration

Files: `packages/ai-gateway-client/src/{mcp-tools,mcp-dispatch}.ts`,
`apps/core/src/modules/ai/mcp/{tools,dispatch-wiring}.ts`, `apps/core/src/main.ts:548-577`.

### 10.1 State: BUILT (read-only design is exemplary) — but transport NOT mounted (PARTIAL)

The read-only-by-construction design matches the brief exactly:
- Every tool is `access:'read'`; `writeToolCount` is **derived** (L210) and CI-asserted to 0;
  `FORBIDDEN_TOOL_NAME_SUBSTRINGS` + `FORBIDDEN_SEAM_NAME_SUBSTRINGS` (L253-270) ban sql/write/mutate
  **and** operator-only paths (replay/idempot/migrat/backfill/unmerge/erase/rebind).
- `McpReadSeams` is a closed surface of pure read functions — a writer is **structurally unreachable**
  (not a property of the interface). `MCP_READ_SEAM_NAMES` is a frozen allowlist;
  `assertSeamNamesClean()` is a CI canary.
- **LLMs never compute:** the dispatch authors no number, only `.toString()`s engine bigints
  (L274-279); money leaves as bigint-minor string + currency_code; `list_metrics` returns names only;
  `resolve_and_compute` selects a binding, the deterministic engine produces the figure.
- **brand_id ONLY from the principal** (L528-531), never a tool input — fail-closed
  `McpPrincipalScopeError` on a scopeless session (I-S01).
- **Honest deferral:** `segment_lookup` is `disabled-not-implemented`, fails closed with a reason,
  matching REGISTERED-DISABLED `predictive_ltv` / `predictive_health` / attribution `uplift` / `survival`
  / `shapley` (`intelligence.api.v1` `DISABLED_PREDICTIVE_MODELS`).
- The four required identity tools are registered read-only: `customer360_lookup`, `journey_lookup`,
  `timeline_lookup`, `identity_explainability_lookup` (the last two hash-only, never coupled to money).

### 10.2 GAP E1 (HIGH) — dispatch built but not exposed

`apps/core/src/main.ts:577` is `void mcpDispatch;` with "the MCP server transport (LiteLLM/MCP, deferred
to M3) binds to it." Tools are wired in-process and unit-tested, but **no live MCP transport serves
them**. Any "MCP is live" claim is premature — it is *assembled-and-ready*, not *mounted*.
- **Fix (M3):** mount the dispatch behind the MCP/LiteLLM transport with the principal derived from the
  session JWT, plus the audit log + per-tool metrics from §7.3.

### 10.3 WEAKNESS E2 — explainability drops `reasons`

`identityExplain` reuses `getCustomer360` and drops `reasons[]` (main.ts:564-570 maps merges without
`reasons`, which `ExplainMergeLike.reasons` / `mapExplain` support; L375 falls back to `[]`). So
explainability returns *that* two profiles merged + confidence + rule_version, but not *why* (the matched
identifier reasons).
- **Fix:** source `reasons` from the merge-decision/audit evidence (the decision-log under §5.3/§7.2) so
  the tool explains the match basis, not just asserts it.

### 10.4 Minor — `mapExplain` role precedence

`mapExplain` derives `role` from `x.merges[0]` (L378) — fine for the common case, ambiguous if a brain_id
is canonical in one merge and merged in another. Document the precedence (canonical wins).

---

## Defect register

| ID | Sev | Area | Finding | Primary file(s) |
|----|-----|------|---------|-----------------|
| F2 | HIGH | Merge | Merge never re-points `IDENTIFIES` edges; reads + order recognition don't alias-resolve `merged_into` ⇒ merged customers' orders split LTV under the dead brain_id | `Neo4jIdentityRepository.ts:116-130,240-274`; `silver_order_state.py:109-120`; `silver_customer.py:118` |
| F4 | HIGH | Audit | `identity_audit` INSERT has no idempotency key ⇒ replay/retry duplicates the compliance ledger; cross-store write non-transactional | `Neo4jIdentityRepository.ts:308-393`; `IdentityBridgeConsumer.ts:84` |
| F1 | HIGH | Wiring | ConfidenceEngine/DecisionEngine/ProbabilisticMatcher/IdentityTimeline unwired from live path; weak signals persisted but never consumed | `main.ts:233-261`; `ResolveIdentityUseCase.ts:298-330`; `matchers/*`, `decisions/*` |
| A1 | HIGH | Contract | No `snapshot_id`/`computed_at`/`contract_version` on the Customer360 row | `intelligence.api.v1.ts:301-387`; `gold_customer_360.py`; `mv_gold_customer_360.sql` |
| C1 | HIGH | Security | No Iceberg snapshot-expiry/compaction in erasure ⇒ shredded subject resurrectable from snapshots | `EraseSubjectUseCase.ts`; `0114_subject_crypto_shred.sql` |
| E1 | HIGH | AI/MCP | MCP dispatch assembled but `void`ed — no live transport mounted | `apps/core/src/main.ts:577` |
| NEO-IDX | HIGH | Neo4j | No range/rel-property indexes; label-less full-store purge | `Neo4jIdentityRepository.ts:78-96,399` |
| F3 | MED | Match | N-way merge converges only one pair per event live | `IdentityResolver.ts:286-312` |
| M2 | MED | Replay | `randomUUID()` mint ⇒ non-deterministic brain_id labels on full replay | `IdentityResolver.ts:250` |
| M1 | MED | Extract | Extraction logic duplicated (inline use-case vs `extract-identifiers.ts`) — hash-drift risk | `ResolveIdentityUseCase.ts:91-312` |
| M3 | MED | Normalize | Non-IN phone normalization absent ⇒ split identity for non-IN brands | `identity-core/index.ts:107` |
| ISO | MED | Security | `withGraphBrand` single seam + non-inert isolation-fuzz proof missing; unscoped target-side matches | `neo4j-identity-reader.ts:232-261` |
| D2 | MED | Scale | Per-row currency inherits brand default in MCP money mappers | `mcp-dispatch.ts:304-305`; `dispatch-wiring.ts:98-103` |
| A2 | MED | Contract | `segment`/`acquisition_source` required ⇒ breaks honest-empty | `intelligence.api.v1.ts:369-371` |
| TEMP | MED | Neo4j | `IDENTIFIES` mutated in place, not interval-closed ⇒ no link-history time-travel | `Neo4jIdentityRepository.ts:217,280` |
| E2 | MED | AI/MCP | Explainability drops `reasons[]` | `apps/core/src/main.ts:564-570` |
| C2 | MED | Security | Merge `confidence` unconstrained `z.string()` at contract | `identity.api.v1.ts:38` |
| L1 | LOW | Perf | Phone-guard over-suppression edge + N+1 count queries | `IdentityResolver.ts:166-180`; `Neo4jIdentityRepository.ts:156-164` |

### Phone-guard note (L1)
The guard counts `existingCount + 1 > threshold` assuming the new resolution adds a *distinct* brain_id
(`IdentityResolver.ts:166-180`), but the phone may resolve to an existing brain_id (count unchanged). A
legitimate repeat customer on a shared/popular phone at the boundary can be over-suppressed. **Fix:**
check whether the matched brain_id is already in the windowed set before counting it. Pair with the N+1
batch fix (§4.6).

---

## Priority backlog (Principal ranking)

1. **F2 — merge consolidation end-to-end** (re-point `IDENTIFIES` on merge + emit N-way MergeSpecs +
   alias-resolve order recognition). Add the merge-LTV parity test. Highest correctness impact.
2. **F4 — make `identity_audit` replay-idempotent** (deterministic key + ON CONFLICT; ideally project
   from a decision-log written in the same unit as the graph mutation).
3. **NEO-IDX — add Neo4j indexes + replace label-less purge + de-N+1 phone counts.** Required before
   large tenants onboard.
4. **A1 — add `snapshot_id`/`computed_at`/`contract_version` to the Customer360 row.** Unblocks
   historical snapshots / as-of joins / staleness detection and correct cache keying (§9.1).
5. **C1 — erasure-aware Iceberg compaction as erasure step 4.** Closes the DPDP "unrecoverable" residual.
6. **E1 + §7.3 — mount the MCP transport + add tool-call audit log & metrics.**
7. **F1/§5.2 — wire ConfidenceEngine/ProbabilisticMatcher (review-gated) into the live path,** OR
   de-scope and stop persisting weak edges. Then the Splink evolution (§5.5) once a label corpus exists.
8. **ISO — `withGraphBrand` single seam + non-inert isolation-fuzz proof** (close unscoped target-side
   matches).
9. **M1 (collapse duplicate extractor), M2 (deterministic mint), M3 (non-IN phone), F3 (N-way),
   D2 (per-row currency), A2 (honest-empty), C2 (confidence constraint), TEMP (interval-close
   IDENTIFIES), E2 (explain reasons), L1 (phone-guard).**

---

## Invariants to preserve (do not regress)

- Pure-domain `IdentityResolver` with the medium-tier `union.size === 1` adoption guard.
- The probabilistic matcher's structural sub-exact cap (cannot reach band `exact`) and human-review gate.
- Bronze offset-after-commit + coordinate-MERGE exactly-once contract.
- `identity-export` incremental + tombstone-sweep design.
- Stream-vs-batch order-independence replay harness.
- Neo4j = hashes only; raw PII vault + immutable audit ledger in PostgreSQL (ADR-0004).
- Money = bigint minor + sibling `currency_code`, never blended, never a float.
- brand_id-first tenancy + `${BRAND_PREDICATE}` seam everywhere.
- Read-only MCP: LLMs consume deterministic outputs only; never match, never compute, never write.
- REGISTERED-DISABLED matchers/predictive marts fail closed with a reason — never fake empty.
