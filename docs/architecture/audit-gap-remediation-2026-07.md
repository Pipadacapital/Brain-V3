# Audit Gap Remediation — External Architecture Audit (2026-07)

Status: review complete. Verdicts recorded against the actual implementation.
Scope: docs-only. This file records the outcome of reviewing an 8-gap external
architecture audit (G1..G8) against the code that is already merged. It changes
no runtime component.

Bottom line: **7 of 8 gaps are not actionable** — 6 are already implemented (some
flag-gated OFF pending an operational wave, not code), 1 is a misread of a live
streaming path, 1 would re-introduce a regression against a ratified ADR, and 1
proposes an inferior identifier scheme that breaks parity tests. **Exactly one
(G1) is a genuine, additive improvement** and is being taken forward flag-gated
behind an ADR.

---

## Verdict table

| Gap | Audit ask (short) | Verdict | Anchor |
| --- | ----------------- | ------- | ------ |
| **G1** | Query-time revenue on the identity spine | **genuine** (additive, flag-gated) | new flag `identity.revenue_querytime` + ADR (below) |
| **G2** | Multi-key session stitch | **implemented / done-flag-off** | `db/iceberg/duckdb/silver/silver_session_identity.py:1` ("Stitch v2"); flag `stitch.v2` default OFF |
| **G3** | Bronze→identity hashing bridge | **not-a-gap** | `apps/stream-worker/src/identity-bridge/IdentityBridgeConsumer.ts` (live consumer) |
| **G4** | Unified `brain_bronze.events` table | **regression-rejected** | ADR-0010 — table DROPPED 2026-07-05 |
| **G5** | `event_category` + `silver_version` | **implemented** | `_silver_technical_ports.py:19`; `_normalize_base.py:152` |
| **G6** | Cross-source composite dedup | **implemented** (deliberately flag-only) | `db/iceberg/duckdb/silver/silver_touchpoint.py:22` |
| **G7** | `<tenant>-YYYYMMDD-<random>` public id | **regression-rejected** | `_identity_ref.py` (`BRN-` Crockford `customer_ref`) |
| **G8** | Extract a standalone analytics gateway | **implemented in-process** | `@brain/metric-engine` behind ESLint boundary fence; ADR-0007 |

---

## Rejected / already-done gaps — evidence

### G2 — Multi-key session stitch: ALREADY DONE (flag-off is operational, not code)

Deterministic multi-key stitch is already built as **Stitch v2** in
`db/iceberg/duckdb/silver/silver_session_identity.py`. Its module docstring
(`:1`, SPEC A.2.1 / A.2.3 / A.2.3.5 / A.2.5) resolves a session's **full
identifier set** through `identity_current` to a single canonical `brain_id`.
The 5-identifier set is enumerated at `:31-37`:

- `anonymous_id` (salted `external_id` hash)
- `email` (pre-hashed interop space)
- `phone` (pre-hashed interop space)
- `platform_customer_id` (salted)
- `checkout_session_id` (salted)

It links on `(brand_id, identifier_hash)` alone (`:37`), refuses to guess when a
session resolves to >1 `brain_id` (`:8`), and enforces the shared-device 90-day
recency rule (`:50`). The re-stitch machinery the audit asked for also exists:
the **RestitchDirtyConsumer** re-folds past sessions dirtied by an identity-map
mutation —
`apps/stream-worker/src/interfaces/consumers/RestitchDirtyConsumer.ts`
(+ `domain/identity/RestitchDirty.ts`, `infrastructure/pg/RestitchDirtyRepository.ts`,
unit test `tests/restitch-dirty.a2-3-5.unit.test.ts`), the A.2.3.5 (WA-18)
restitch drain referenced at `silver_session_identity.py:18`.

The **only** open item is that the per-brand flag `stitch.v2` is **default OFF,
fail-closed** (`silver_session_identity.py:64`, `_platform_flags.py:37`). Turning
it on is an **operational enablement** (flip the per-brand flag, optionally
`STITCH_V2_BRANDS=<uuid>` for a parity run — `:66-70`), not a code change.

Runbook: `docs/runbooks/enable-stitch-v2.md` (per-brand enablement + parity
verification procedure).

### G3 — Bronze→identity hashing bridge: NOT A GAP

The audit proposes adding hashed identifier **columns to Silver** and a batch
bridge that reads Bronze. That path already exists as a **live Kafka consumer**,
not a table read:
`apps/stream-worker/src/application/ResolveIdentityUseCase.ts` —
"extract → normalize → hash → resolve → write" — driven by
`apps/stream-worker/src/identity-bridge/IdentityBridgeConsumer.ts`. It:

- hashes identifiers **at runtime** — real SHA-256 via `@brain/identity-core`,
  per-brand salt from `SaltProvider` (`ResolveIdentityUseCase.ts:18`, `:7`);
- writes **only hashes** to Neo4j, which is the identity SoR (`:93`), never any
  raw PII in logs or outcomes (`:15`, I-S02/D-3);
- consumes the **streaming event payload**, committing the Kafka offset only
  after a clean return (`:13`) — it does not scan a Bronze Iceberg table.

The proposed "hashed Silver columns" are therefore redundant: the hashing seam
is runtime and store-agnostic, and Silver already carries the pre-hashed interop
identifiers it needs (see G2, `silver_session_identity.py:32-36`). There is no
column to add and no Bronze read to introduce.

### G4 — Unified `brain_bronze.events` table: REGRESSION (contradicts ADR-0010)

A single unified `brain_bronze.events` table **existed and was deliberately
DROPPED on 2026-07-05** under **ADR-0010**
(`docs/adr/0010-kafka-connect-iceberg-bronze-reinstated.md:97-101`,
also `:67`). Bronze landing is now the Kafka Connect Iceberg sink writing
**per-lane** tables: the collector lane → `collector_events_connect` and the
**9 raw lanes** → `brain_bronze.<lane>_raw_connect` (ADR-0010 `:31-34`).

The per-lane split is **mandated** by three ratified constraints:

1. **Mixed Kafka Connect converters** — the collector lane uses
   StringConverter+HoistField (truly-raw), the 9 raw lanes use schemaless
   JsonConverter (exploded envelope). One table cannot host both converter
   schemas (ADR-0010 `:31-34`).
2. **The RTBF payload contract** — per-subject erasure is column-equality on the
   `*_raw_connect` lanes (`erasure_raw_delete.py`, ADR-0010 `:100-101`); a
   blended table breaks the erasure predicate.
3. **The 8 normalize jobs** were built against the per-provider exploded-envelope
   struct schema (ADR-0010 `:34`); collapsing lanes would break them.

Rebuilding a single `events` table reverses a ratified ADR and is CI-forbidden by
`tools/lint/v4-naming-guard.sh`. **Rejected.**

### G5 — `event_category` + `silver_version`: ALREADY DONE

- **`event_category`** is a Silver UDF, computed on every good row:
  `db/iceberg/duckdb/silver/_silver_technical_ports.py:19`
  (`def event_category(event_type)`), documented at `:6` as "Gap A, stored on
  every good row" — a verbatim port of `_silver_technical.event_category`.
- **`silver_version`** is a monotonic version bumped **only on genuine payload
  change**: `db/iceberg/duckdb/silver/_normalize_base.py:152` — the MERGE's
  `WHEN MATCHED AND payload genuinely CHANGED → overwrite + bump silver_version`
  clause (column declared at `:52`; semantics at `:23-24`).

Both already exist. **Implemented.**

### G6 — Cross-source composite dedup: ALREADY DONE (deliberately flag-only)

Cross-source composite detection is built in
`db/iceberg/duckdb/silver/silver_touchpoint.py`: an additive LEFT JOIN to
`silver_order_state` (`:22`, `:78`) tags a pixel purchase-class touchpoint that
matches an order within the **60s window** (`COMPOSITE_ORDER_WINDOW_SECONDS = 60`,
`:98`; predicate `:396`) with **`is_composite`** and **`composite_order_key`**
(columns `:133-134`; flag set `:398`).

This is **deliberately flag-only — it tags, it does not collapse rows** (`:22-24`
"no row removal, no fan-out"; `:386-387` "additive flag, no row removal / no
touch_seq change"). Row-collapsing a touchpoint would destroy journey grain
(touch_seq, sessionization). The audit's "dedup by removal" is precisely what the
design rejects on purpose. **Implemented; row-collapse intentionally not done.**

### G7 — `<tenant>-YYYYMMDD-<random>` public id: REJECTED (inferior + breaks parity)

The existing scheme is a UUID `brain_id` (internal SoR, typed `uuid` across ~12
PG tables + ~14 contracts) plus a deterministic public surrogate `customer_ref`:
`db/iceberg/duckdb/silver/_identity_ref.py` —
`BRN-` prefix + **Crockford base32** of the UUID bytes (`:8`, `:28-30`), a pure
deterministic function of `brain_id` (`:11`), collision-free and reversible in
principle (`:15`), with **golden-locked py/ts parity** (`:21`, test
`packages/contracts/src/identity/brain-ref.test.ts`).

The proposed `<tenant>-YYYYMMDD-<random>` pattern is strictly worse:

- **Leaks creation-date PII** — embedding `YYYYMMDD` exposes when a customer was
  first seen, a residency/privacy regression.
- **Not deterministic / not reversible** — a `<random>` suffix cannot be
  recomputed from the `brain_id`, so it can't be regenerated or reconciled.
- **Breaks parity tests** — the py/ts golden vectors for `brain_ref` (`:21`)
  assert byte-exact output; a new scheme fails them.

**Rejected.** The current `BRN-` Crockford `customer_ref` is retained.

### G8 — Extract a standalone analytics gateway: ALREADY DONE in-process

The analytics gateway the audit wants **already exists as an in-process seam** —
cache + Trino build + brand-predicate injection + result formatting are isolated
in **`@brain/metric-engine`** (`packages/metric-engine/`) and named/ratified by
**ADR-0007** (`docs/adr/0007-analytics-gateway.md`):

- cache-aside over Redis with the metric-engine as the single chokepoint
  (`serving-cache.ts`, `analytics-cache.ts` — ADR-0007 §D1);
- the app/BFF/metric-engine read ONLY `brain_serving.mv_*`, never a bare
  Gold/Silver table (ADR-0007);
- the boundary is **mechanically fenced** in ESLint —
  `eslint.config.mjs:71` declares the `metric-engine` element and `:98-124`
  restricts it so the serving seam is importable only by the analytics /
  measurement modules (the boundary rule the audit asks for is already enforced
  in CI).

A **standalone** `analytics-gateway` service was **deliberately removed** in the
repo-cleanup program (the orphan gateway was pruned). Re-extracting it adds a
network latency hop and a new pod for **no functional gain** — every invariant
the audit cites (money-never-blended, `brand_id`-first, Gold-never-hit-directly)
is already enforced inside the in-process seam. **Implemented in-process;
extraction rejected on cost/latency.**

> Note on ADR-0007 wording: the ADR predates the Spark→DuckDB and
> StarRocks→Trino cutovers and still names Spark/StarRocks in places. The
> load-bearing facts cited here (the metric-engine chokepoint, the Redis
> cache-aside, the `mv_*`-only rule, the ESLint fence) are unchanged by those
> cutovers.

---

## G1 — the one genuine improvement: query-time revenue on the identity spine

**Verdict: genuine.** This is the single audit item worth building. It proposes
folding revenue onto the identity spine **at query time** (rather than relying
solely on the pre-materialized revenue marts), so a freshly-stitched customer's
revenue is reflected without waiting for the next full mart rebuild.

Constraints for taking it forward (matches every Brain operating standard):

- **Additive** — it adds a query-time fold path alongside the existing marts; it
  removes nothing and changes no served number when the flag is OFF.
- **Flag-gated** — new per-brand flag **`identity.revenue_querytime`**, default
  **OFF, fail-closed** (same shape as `stitch.v2` / `measurement.marts_migration`).
  OFF = today's mart-served numbers, byte-identical.
- **ADR-recorded** — a new ADR captures the decision, the money invariants (bigint
  minor units + sibling `currency_code`, never blended, never a float), and the
  `${BRAND_PREDICATE}` isolation seam it must thread.
- **Parity-gated** — enable per-brand behind the flag, run the golden/parity
  harness (see precedent below), verify byte-exact reconciliation, then widen.

This is **not yet in the code** (no `identity.revenue_querytime` reference exists
today) — it is the forward action item from this review.

---

## Prerequisites the audit asks for already EXIST

The audit lists three prerequisites for a safe flag-gated parallel-run rollout.
All three are already in the repo:

1. **Per-brand feature flags** — `@brain/platform-flags`
   (`packages/platform-flags/package.json` → `"@brain/platform-flags"`), with the
   DuckDB-side gate `db/iceberg/duckdb/_platform_flags.py` (`is_flag_enabled`,
   `FLAG_*` registry). This is exactly the mechanism `stitch.v2` uses.

2. **Golden dataset harness** — `@brain/testing-golden`
   (`packages/testing-golden/package.json` → `"@brain/testing-golden"`;
   `src/cli.ts`, `generator.ts`, `scenarios.ts`, seeded PRNG in `prng.ts`),
   producing deterministic, sha256-checksummed envelopes for parity checks.

3. **Flag-gated parallel-run + parity precedent** — two shipped seams already
   prove the exact pattern G1 needs:
   - **`semantic.serving`** — per-brand flag, read + echoed for auditability;
     `apps/core/src/modules/frontend-api/internal/routes/semantic-metrics.routes.ts:40`.
   - **`measurement.marts_migration`** — per-brand flag (default OFF, fail-closed)
     that swaps the CAC/ROAS/executive spend serving-view between the legacy and
     new marts, **byte-identical either way**, with a published parity note
     (`packages/metric-engine/src/measurement-migration.ts:6-19`; callers in
     `apps/core/.../attribution.routes.ts:41`,
     `.../analytics-marketing.routes.ts:44`; parity note
     `knowledge-base/gates/wave-c-c4-parity-note.md`).

G1 should follow the `measurement.marts_migration` blueprint verbatim: per-brand
flag, default OFF → legacy mart numbers, ON → query-time fold, parity-verified
before widening.
