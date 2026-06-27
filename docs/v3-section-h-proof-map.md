# Section-H Proof Map

This is the consolidated map from **each platform invariant** to the **proof test** that
demonstrates it, with a one-line note on what the test asserts and an honest **status**.

Conventions:
- **PROVEN** — the invariant is asserted by a pure / always-run test that fails CI if the behavior
  regresses (or by a live test whose pure-unit half is always-run and load-bearing).
- **LIVE-GATED** — the strongest end-to-end assertion runs only when infra (StarRocks / Trino /
  Neo4j / the lakehouse docker profile) is reachable; otherwise the test **PENDs** (visibly skipped,
  never silently green). The pure portion (where present) is always-run.
- **DEFERRED (DISABLED seam)** — the capability is registered but **throws** `NotImplementedYet`
  rather than faking success. The *fact that it fails closed* is itself proven.

All paths are repo-relative. CI enforcement is described in the last section.

| # | Invariant | Proof test (path) | What it asserts | Status |
|---|-----------|-------------------|-----------------|--------|
| 1 | **End-to-end pipeline** (HTTP edge → Bronze SoR → brand-scoped read) | `apps/stream-worker/src/tests/pipeline-wire.e2e.test.ts` | Real `POST /collect` → collector_spool → Redpanda → **Spark sink → Iceberg `brain_bronze.collector_events`** → readable via the StarRocks external catalog, brand-scoped; wrong-brand read → 0 rows. No mocked cross-component seam. | LIVE-GATED (needs `lakehouse` docker profile) |
| 1b | **Bronze landing / dedup / isolation** | `apps/stream-worker/src/tests/bronze.e2e.test.ts` | (1) produced event → 1 Bronze row; (2) same `(brand_id,event_id)` twice → exactly ONE row (Spark MERGE WHEN NOT MATCHED = idempotency I-E02); (3) brand_B-scoped read of a brand_A event → 0 rows. | LIVE-GATED (lakehouse profile) |
| 2 | **Replay-determinism** (operator replay rebuilds the same graph) | `apps/stream-worker/src/tests/identity-replay-determinism.test.ts` | Pure rebuild via `IdentityReplayEngine` (real `IdentityResolver` over an isolated `InMemoryIdentityGraph`): a bridging event MERGES; re-running yields the SAME label-free partition signature; idempotent on re-replay; label-free (random brain_ids differ, partition identical); cross-brand read rejected. | PROVEN (pure) |
| 3 | **Order-independence (stream == backfill)** — resolution level | `apps/stream-worker/src/tests/stream-backfill-resolution-parity.test.ts` **(NET-NEW)** | The SAME `identifier→brain_id` edge set fed to `DeterministicUnionFindMatcher` in LIVE-lane order vs BACKFILL-lane order yields **byte-identical** canonical assignment + merge SET + deterministic `merge_id`s (D-4); identical `canonicalOf` across reversed / brand-id-desc / 50 seeded shuffles; replay-safe under duplicated edges. | PROVEN (pure) |
| 3b | Order-independence — primitive level | `apps/stream-worker/src/domain/identity/matchers/union-find.test.ts` | `computeConnectedComponents` is invariant under 50 seeded edge shuffles (byte-identical components + `canonicalOf`); transitive chains collapse to one component; canonical = lowest UUID; idempotent under duplicate edges; empty batch. | PROVEN (pure) |
| 3c | Order-independence — full stream vs batch cross-check | `apps/stream-worker/src/tests/identity-replay-determinism.test.ts` (`streamEqualsBatch`) | The streaming `IdentityResolver` rebuild's partition equals the batch `computeConnectedComponents` partition across as-given / reversed / sorted-by-event-id orderings. | PROVEN (pure) |
| 4 | **Identity-change → scoped-recompute → cache-invalidation** | `apps/stream-worker/src/tests/scoped-recompute-loop.integration.test.ts` | An `identity.merged` event for BRAND_A → `ScopedRecompute` upsert containing ONLY {canonical, merged_away} brain_ids; `cache.invalidate.v1` names the full `CUSTOMER_GRAINED_MARTS` set mapped to `brain_serving.mv_*`; no BRAND_B row/invalidation; deterministic `request_id` (replay idempotency); non-recompute events (minted/linked) produce nothing. | PROVEN (pure TS, faked infra) |
| 4b | Scoped-recompute unit + cache-invalidate consumer | `apps/stream-worker/src/domain/identity/ScopedRecompute.test.ts`, `apps/stream-worker/src/interfaces/consumers/IdentityChangeRecomputeConsumer.test.ts`, `.../AnalyticsCacheInvalidateConsumer.test.ts` | The mapper, the recompute request shape, and the cache-invalidate consumer wiring in isolation. | PROVEN (pure) |
| 5 | **AS-OF versioned identity** (bitemporal alias chain) | `apps/stream-worker/src/tests/identity-neo4j-repo.live.test.ts` (MERGE case) + `apps/stream-worker/src/tests/identity-timeline.test.ts` | Neo4j live: a merge tombstones the merged Customer (`lifecycle_state='merged'`, `merged_into`) and writes an `ALIAS_OF` edge carrying `merge_id, valid_from, valid_to=null` — the bitemporal "as-of" record (Neo4jIdentityRepository schema). Timeline (pure): `buildIdentityTimeline` returns the versioned history in chronological order with a stable sequence, and a query on the **merged-away** brain_id still surfaces the merge that absorbed it (point-in-time lineage). | PROVEN (timeline = pure); LIVE-GATED (the bitemporal `ALIAS_OF` valid_from/valid_to edge assertion needs live Neo4j — PENDs otherwise) |
| 6 | **Crypto-shred** — per-subject key-deny + RTBF over raw | `apps/stream-worker/src/tests/erasure-orchestrator.unit.test.ts` + `packages/pii-vault/src/subject-vault-key-provider.test.ts` | Orchestrator (pure): erasure runs init→shred→erasePii→surrogate→recompute→capi→complete; records a non-null surrogate tombstone; `completeErasure` (vault_shredded=TRUE) reached; CAPI deletion reused once; a DIFFERENT subject/brand is provably untouched; salt/lookup failure is a hard crash (no silent loss). Vault provider: subject DEK round-trips; `is_active=FALSE` subject → `getDek` throws (`inactive`) = key-deny; per-subject + cross-subject uncorrelatable. Together: shred the subject DEK → ciphertext is permanently undecryptable (I-S05). | PROVEN (pure) |
| 6b | Crypto-shred — **erasure-aware Iceberg compaction** | `apps/stream-worker/src/tests/erasure-orchestrator.unit.test.ts` (`shredIcebergSnapshots`) | The disabled compaction seam **throws `NotImplementedYet`** with message `erasure-aware-iceberg-compaction` (fail-closed: never claims I-S05 conformance for raw rows still in old Iceberg snapshots). | **DEFERRED (DISABLED seam)** — raw-row rewrite/compaction over historical Iceberg snapshots is not built; crypto-shred relies on DEK-deny (ciphertext stays, key gone). Honestly registered-disabled, proven to throw. |
| 7 | **AI read-only** (MCP no-write / no-replay canary) | `tools/isolation-fuzz/src/mcp.test.ts` | Real `@brain/ai-gateway-client` registry: `writeToolCount === 0`, every tool `access==='read'`, no tool/seam name contains sql/write/mutate/insert/update/delete/**replay/idempot/migrat/backfill/reprocess**; dispatch surface is EXACTLY the frozen read-seam allowlist; every seam call is scoped to the PRINCIPAL brand (a smuggled `brand_id` in tool input is ignored); empty principal fails closed; disabled `segment_lookup` throws `NotImplementedYet`. | PROVEN (pure; CI-blocking canary) |
| 8 | **Tenant isolation — StarRocks/Silver seam (mutation proof)** | `tools/isolation-fuzz/src/silver-order-state.test.ts` | `withSilverBrand` injects the `${BRAND_PREDICATE}` → brand-A read returns only brand-A rows; **mutation/non-inert proof**: `__unsafeDisableBrandPredicate` MUST leak brand-B rows (else the guard was inert → fail loud). | LIVE-GATED (StarRocks :9030 + `brain_silver.silver_order_state`; PENDs otherwise) |
| 8b | Tenant isolation — **Trino seam (brand-predicate mutation proof)** | `tools/isolation-fuzz/src/trino-brand-predicate.test.ts` | Pure (always-run): missing sentinel → throws (fail-closed); injects `brand_id = ?` + appends brandId; disabled path rewrites to `1 = 1` (NOT `brand_id = ?`) and produces DIFFERENT SQL (guard is structural); shared single sentinel string. Live: brand-A read returns only brand-A; disabling predicate MUST leak brand-B. | PROVEN (pure half always-run); LIVE-GATED (live leak proof needs Trino :8090) |
| 8c | Tenant isolation — additional seams | `tools/isolation-fuzz/src/{starrocks,pg,redis,rls-role-guard,secdef-guard,ai-provenance,silver-touchpoint}.test.ts` | StarRocks native row-policy / PG RLS-role / SECURITY DEFINER / Redis key-scoping / AI provenance isolation surfaces. | Mixed (pure + LIVE-GATED) |
| 9 | **Monetary — minor units, no float, multi-exponent** | `packages/money/src/index.test.ts` | `currencyExponent`: 2 for INR/AED/SAR/QAR, **3 for KWD/BHD/OMR**, 0 for JPY; `minorUnitsDivisor('KWD')===1000`; `money()` takes `bigint` minor + ISO `currency_code` (no float, no allowlist throw, malformed code throws); `minorToMajorNumber` divides by the per-currency exponent (guards the hardcoded `/100` bug class); `formatMoney` → `KWD 12.500` (3-decimal) and `JPY 8900` (0-decimal). | PROVEN (pure) |

## Net-new in this change
- **`apps/stream-worker/src/tests/stream-backfill-resolution-parity.test.ts`** (row 3) — frames
  order-independence explicitly as **LIVE-lane vs BACKFILL-lane** resolution parity through the one
  enabled matcher (`DeterministicUnionFindMatcher`), asserting byte-identical canonical brain_id
  assignment, merge sets, and deterministic `merge_id`s. Distinct from the generic
  `union-find.test.ts` shuffle proof (3b) and the `IdentityReplayEngine` stream==batch proof (3c).

## CI enforcement (`.github/workflows/pr.yml`)
These proofs are gates on every PR (the `pr` workflow), so a regression blocks merge:
- **`pnpm turbo run lint typecheck test:unit --affected`** — rows 2, 3, 3b, 3c, 4, 4b, 5 (timeline),
  6, 9 (the pure unit proofs).
- **`test:contract --affected`** — contract-shape proofs (envelopes, MCP schemas).
- **`test:isolation --affected`** — rows 7, 8, 8b, 8c (the isolation-fuzz mutation/non-inert proofs).
- **`test:parity --affected`** (+ always-on parity in `integration.yml` core-live) — Gold/serving
  parity oracle.
- **C5 Log-Grep Gate** (`pnpm log-grep`, `tools/eslint-rules/log-grep-patterns.json`) — scans source
  for raw PII / financial identifiers; complements the crypto-shred + hash-only (I-S02) invariants.
- **Brain V4 Naming Guard** (`tools/lint/v4-naming-guard.sh`, self-tested then run over the tree) —
  fails on retired-DB refs, any `dbt` invocation, feature-precompute, and non-`mv_*` / non-Iceberg
  Gold/Silver reads (the V4 architecture invariants underpinning rows 1, 1b, 8, 8b).
- The **LIVE-GATED** rows (1, 1b, 5 bitemporal, 8 live, 8b live) run their strongest assertions in
  the integration / core-live lanes against real StarRocks / Trino / Neo4j / lakehouse; when infra
  is absent they **PEND** (visibly skipped) rather than passing silently.

## Honesty notes
- **6b (erasure-aware Iceberg compaction) is genuinely DEFERRED.** Crypto-shred today = deny the
  per-subject DEK (`is_active=FALSE` → `getDek` throws); the ciphertext remains in Iceberg and is
  undecryptable. Physically rewriting/compacting old Iceberg snapshots to drop erased raw rows is a
  registered-DISABLED seam (`shredIcebergSnapshots` throws `NotImplementedYet`) — proven to fail
  closed, not faked.
- **5 (AS-OF versioned identity):** the chronological/lineage half is PROVEN purely
  (`identity-timeline.test.ts`); the bitemporal `ALIAS_OF {valid_from, valid_to}` edge is asserted
  only in the live Neo4j test, which PENDs without a reachable Neo4j.
- **8 / 8b live mutation proofs** are the only runtime evidence of isolation on Trino (no native row
  policy) and dev StarRocks (no `CREATE ROW POLICY` on the allin1 image); the pure SQL-rewrite proof
  (8b Part A) is always-run, but the cross-brand *leak* proof requires the live engine.
