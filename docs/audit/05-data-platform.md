# Brain Engineering Excellence Audit — PASS 7: Data Platform

**Auditor posture:** independent principal-level reviewer, no attachment to the codebase. Every finding cites repository evidence (file:line / migration / config). Theoretical concerns excluded.

**Scope:** Redpanda/Kafka topic + consumer-group design (stream-worker), Iceberg/Bronze table design, StarRocks Silver schema + JDBC external catalog + read-shim views, dbt models (db/dbt), replayability (same-code-path live+backfill), schema evolution (Apicurio/Avro), exactly-once vs at-least-once + dedup, lineage, partitioning/clustering. Compared against `docs/requirements/03,07,08` and `docs/data-collection-platform/10`.

**Headline:** the documented lakehouse (Iceberg-as-source-of-truth, Redpanda→Iceberg topic-materialization, StarRocks-reads-Iceberg) is **not wired**. Bronze is a Postgres table written by a hand-rolled TypeScript writer; the "Avro on Redpanda" wire format is actually JSON; Apicurio is registered-but-bypassed; the dbt Silver tier reads the OLTP ledger (not Bronze) via a superuser JDBC catalog and is not run in CI. Much of this is *honestly self-documented in the code as a Phase-1 "D-4 fallback,"* which downgrades several items from "broken" to "divergence-from-architecture-doc that is undisclosed at the doc layer." The dbt Silver models themselves and the dedup/offset-commit discipline are genuinely well-engineered.

---

## CRITICAL

### C1 — Bronze is Postgres, not Iceberg; the documented "source of truth" lakehouse does not exist
**Severity:** Critical | **Category:** Architecture divergence / lakehouse

**Evidence:**
- Stack doc promises Iceberg-as-SoR: `docs/requirements/03_…Stack.md:189` ("Apache Iceberg … **The heart of the data plane**"), `:191` ("Bronze = raw events as received (replay truth, 24-month retention)"), `:132` ("Bronze writer = **Redpanda → Iceberg topic-materialization** … without hand-rolled TS Iceberg writers"), `:239` ("Redpanda materializes Bronze into Iceberg/S3 … immutable and retained 24 months").
- Event-contracts doc asserts the same: `docs/requirements/07_…Event_Contracts.md:83` ("Bronze (Iceberg/S3) — replay SoR, 24mo"), `:341` ("Written by Redpanda → Iceberg topic-materialization (no hand-rolled writers)"), `:344` ("`PARTITIONED BY (bucket(N, brand_id), days(occurred_at))`").
- Reality — Bronze is a Postgres table: `db/migrations/0016_bronze_events.sql:1-2` ("**DEV/M1 STAGING MIRROR** … Phase-3 → Iceberg"), `:5-7` ("no production-grade TS Iceberg writer exists; Nessie REST is catalog-only … Postgres bronze_events is the explicitly pre-authorised **D-4 fallback** for M1"), `:20` ("this table is **NOT yet an immutable SoR**").
- Written by a hand-rolled TS writer: `apps/stream-worker/src/infrastructure/pg/BronzeRepository.ts:106-131` (`INSERT INTO bronze_events … ON CONFLICT (brand_id, event_id) DO NOTHING`). No Redpanda→Iceberg materialization exists anywhere — `grep -rln iceberg apps/ packages/ --include=*.ts` returns only a type file and DQ stub, no writer.
- Nessie/MinIO/Iceberg are present in compose only under the **optional** `lakehouse` profile (`docker-compose.yml:211-213` `nessie: profiles: ["lakehouse"]`), explicitly "NOT part of the default dev" run; the ingest apps "write Bronze to Postgres, not S3" (compose comment near `minio`).

**Impact (production):** The central architectural claim — an open, immutable, 24-month, time-travelling Iceberg lakehouse that makes data portable and replay-safe — is unbuilt. Bronze in Postgres is mutable at the storage layer (append-only is enforced only by `GRANT`, `0016:53-54`, not by an immutable table format), has no partition-expiry/24-month TTL, no compaction/snapshot-expiry job (contradicting `07:345`), and no S3/open-format export. The "brand owns its data / no hostage data" BRD promise and the 24-month replay-SoR guarantee are not satisfiable from the current store. Postgres will also not hold 24 months of festival-peak behavioral volume (`07:538` plans ~30k EPS pixel peak) the way Iceberg/S3 would.
**Root cause:** Phase-1 scope deferral (immature Node Iceberg-write tooling) taken as a pre-authorised fallback (D-4), but the requirement docs (03/07) were never annotated to reflect that Bronze-on-Iceberg is deferred — they still read as shipped.
**Recommended fix:** (1) Reconcile docs 03/07 to state Bronze-on-Iceberg is Phase-3, with Postgres as the disclosed M1 sink. (2) Make the Postgres Bronze sink honestly behave as an interim SoR: add a partition-by-month + scheduled retention job, and a periodic S3/Parquet export so the "portable data" promise has a path. (3) Hold the `bucket(N,brand_id)/days(occurred_at)` Iceberg DDL and the Redpanda→Iceberg connector config under test so the Phase-3 flip is mechanical.
**Priority:** P1 | **Tenant impact:** multi-tenant (every brand's raw truth + replay guarantee); blast radius = platform-wide. **Detection:** would surface as a Phase-3 migration "where is Bronze?" incident, or a customer data-export request that cannot be served.

---

### C2 — Events are produced as JSON, not Avro; Apicurio registration is decorative (schema governance not enforced on the wire)
**Severity:** Critical | **Category:** Schema evolution / wire contract

**Evidence:**
- The collector registers an Avro schema with Apicurio on startup: `apps/collector/src/main.ts:47-54` (loads `…/generated/avro/brain.collector.event.v1.avsc`, registers with backoff).
- But the actual Kafka producer writes **`JSON.stringify(rawBody)`** with no Avro encoding and no schema-id framing: `apps/collector/src/infrastructure/kafka-producer.ts:85` (`value: JSON.stringify(rawBody)`).
- The consumer correspondingly does `JSON.parse(rawValue.toString('utf8'))` then Zod-validates — no Avro decode, no Apicurio fetch: `apps/stream-worker/src/application/ProcessEventUseCase.ts:84-95`, with the in-code admission at `:17` and `:76-77` ("M1: local Zod parse … **NOT Apicurio fetch**").
- Doc 07 mandates Avro + FULL_TRANSITIVE as the binding contract: `07:152` ("Avro record in Apicurio"), `07:261` ("compatibility = FULL_TRANSITIVE for all Bronze-materialized streams"), `07:329` ("schema rejections … runtime decode failure → page"). `infra/redpanda/topics.yml:89-94` declares `compatibility: FULL_TRANSITIVE`.

**Impact (production):** No runtime schema enforcement exists. A producer can emit any JSON shape; FULL_TRANSITIVE compatibility (the whole point of the registry) is never checked at produce or consume time — only a local Zod parse on the consumer, which can drift independently from the registered `.avsc`. The "runtime decode failure → page" alert (`07:329`) can never fire because there is no decode step. Schema-evolution safety, the no-PII schema-lint at the wire boundary, and producer-single-ownership-via-schema are all unenforced. This silently invalidates the schema-governance section of doc 07.
**Root cause:** M1 simplification (Zod-local validate) shipped without the M2 Apicurio decode wiring, and the Avro registration was left in as a no-op so it "looks" governed.
**Recommended fix:** Either (a) Avro-encode at the producer with the Apicurio schema-id wire framing and Avro-decode at the consumer (the documented end state), or (b) if JSON-on-the-wire is the deliberate M1 choice, remove the misleading Apicurio Avro registration and document JSON+Zod as the M1 contract, then gate the JSON shape against the registered schema in CI. Add a CI contract-drift check (doc 07 §26 promises one) that fails if the Zod schema and `.avsc` diverge.
**Priority:** P1 | **Tenant impact:** multi-tenant (a malformed/cross-shape event from any producer reaches every downstream consumer unguarded). **Detection:** today, none — a contract break surfaces as a downstream Zod/parse error or corrupt Bronze row, not a registry rejection.

---

## HIGH

### H1 — Topic design collapsed to one collector topic; the documented per-event-type topic catalogue is unbuilt
**Severity:** High | **Category:** Topic design

**Evidence:**
- Doc 07 §6 specifies ~25 typed topics (`prod.collection.purchase.v2`, `prod.connector.order.upserted.v1`, `prod.finance.ledger.*`, `prod.identity.*`, `prod.attribution.credit.*`, etc.) each with its own partition count and Bronze-materialization flag (`07:213-238`).
- Reality: exactly **one** event topic family exists — `{env}.collector.event.v1` + its `.backfill`/`.dlq`/`.quarantine` siblings and one `collector.order.backfill.v1` lane: `infra/redpanda/topics.yml:8-70`, `docker-compose.yml` redpanda-init creates only `dev.collector.event.v1[.backfill|.dlq|.quarantine]`.
- All commerce/finance/identity flow is multiplexed onto the single live topic, routed by an `event_type`/`event_name` field and distinguished only by **consumer group**: `apps/stream-worker/src/main.ts:118-234` wires 9 consumer groups (Bronze, identity, consent, capi, backfill, live-ledger, settlement, spend, gokwik-awb) all on the **same `topic`**. The finance/identity/attribution producers named in `07:213-238` do not exist as distinct topic producers.
- Doc 10 (`data-collection-platform/10:93`) actually *blesses* the single-topic collapse for SDK/behavioral events (F6 "don't over-granularize"), but it does **not** sanction folding finance/identity/attribution facts onto the collector topic — doc 07 §3 lists them as separately-produced typed events.

**Impact (production):** Per-topic retention, partition sizing, schema, and independent scaling (the stated rationale in `07:211`) are lost — a behavioral-volume spike shares partitions/retention with low-volume high-stakes finance events. Per-topic Bronze-materialization rules (`07:213` "Materialize→Bronze" column) cannot be applied. Capacity planning in `07:538-545` (which sizes `collection.*` at 32 partitions vs `finance.*` at 16 for *per-order ordering*) is inapplicable; everything inherits the single topic's 12 partitions (`topics.yml:11`), so per-order ordering for finance is not guaranteed independently of pixel load.
**Root cause:** Phase-1 minimization (one envelope, one topic) extended past behavioral events onto domains doc 07 keeps separate.
**Recommended fix:** Split at least the finance/ledger and identity topics from the behavioral collector topic so per-order ordering and per-topic retention/scaling hold; or amend doc 07 §6 to formally collapse them with an explicit ordering/retention analysis. Do not leave the doc and the wiring contradicting.
**Priority:** P2 | **Tenant impact:** multi-tenant (shared-topic head-of-line + retention coupling across all brands' finance + behavioral streams). **Detection:** consumer-lag dashboards would show finance consumers lagging during pixel spikes; no alert maps cause to topic-collapse.

---

### H2 — Partition key is `brand_id:event_id`, not the documented per-ordering-unit composite — per-order/per-customer ordering is not delivered
**Severity:** High | **Category:** Partitioning / ordering correctness

**Evidence:**
- Doc 07 §7 (`07:248-255`, "Aligns with doc 04 §6.6 binding") requires the partition key be the **brand-prefixed composite per the topic's ordering unit**: order/ledger/finance → `hash(brand_id, order_id)`; identity → `hash(brand_id, brain_id)`; behavioral → `hash(brand_id, visitor_id|session_id)`. Rationale: "an order's placed→delivered→RTO land on the same partition in order."
- Reality: the only partition key is `brand_id:event_id`: `packages/events/src/index.ts:140-142` (`buildPartitionKey = `${brandId}:${eventId}``), used by the producer at `apps/collector/src/infrastructure/kafka-producer.ts:77`. `event_id` is unique per event, so **every event for an order lands on a (effectively) random partition** — there is no per-order, per-customer, or per-visitor co-location at all.
- Doc 10 reconciles to this (`data-collection-platform/10:97`: "Partition key = `brand_id:event_id`"), so the divergence is internal-doc-vs-doc as well as code-vs-07.

**Impact (production):** The doc-07 ordering guarantee for the mutable commerce lifecycle (placed→delivered→RTO on the same partition, in order) does not hold. The design defends this by claiming correctness comes from `occurred_at`+`sequence`+idempotent LWW (`07:255`), and the dbt fold is indeed event-time-ordered (see H-note in C4) — so this is *survivable* for the Postgres-Bronze + dbt-fold path. But it means the Redpanda layer provides **no ordering**, the documented hot-partition-avoidance mechanism is different from what shipped, and any future consumer that assumes per-order partition ordering (a natural Kafka pattern) will be wrong.
**Root cause:** single-topic collapse (H1) makes a single uniform key convenient; `event_id` maximises spread but discards ordering.
**Recommended fix:** If single-topic stays, document that Redpanda provides no per-entity ordering and that all ordering is event-time-in-the-transform (make it a stated invariant, not an accident). If/when finance/identity topics split (H1), key them on `brand_id:order_id` / `brand_id:brain_id` per doc 07 §7.
**Priority:** P2 | **Tenant impact:** multi-tenant. **Detection:** silent; would surface as out-of-order processing if any consumer relied on partition order.

---

### H3 — Silver `silver_order_state` is built from the OLTP ledger, not Bronze — the "rebuildable from the event backbone" / Bronze-replay-SoR claim is broken for the order mart
**Severity:** High | **Category:** Lineage / replayability

**Evidence:**
- Doc 07 §9 (`07:282-284`) and the lakehouse architecture require Silver to be rebuildable from Bronze: behavioral/connector replay = "re-run stream-worker over **Bronze** partitions → Silver/Gold". Stack doc `03:195` ("dbt transforms **Bronze → Silver/Gold**").
- Reality: `silver_order_state` reads `realized_revenue_ledger` (a Postgres OLTP table), not Bronze: `db/dbt/models/staging/stg_order_ledger_events.sql:36` (`from {{ source('oltp', 'realized_revenue_ledger') }}`), `_sources.yml:27-31` (`realized_revenue_ledger` → shim `silver_order_ledger_src`). The intermediate + mart chain (`int_order_lifecycle.sql:24` → `silver_order_state.sql:47`) never references Bronze.
- By contrast `silver_touchpoint` **does** read Bronze (`bronze_touchpoint_src`, `_sources.yml:55-65`), so lineage is inconsistent between the two marts.
- The ledger itself is written by stream-worker consumers (`main.ts:188-234` live-ledger/settlement/spend/gokwik bridges) from the live topic, *not* re-derived from Bronze on replay — so a Bronze replay (`07:284` "append-only ledger rebuilt; as-of math reproduces history") has no code path: there is no consumer that re-reads Bronze order events to rebuild `realized_revenue_ledger`.

**Impact (production):** For orders/finance — the highest-stakes domain — Silver is a projection of a derived OLTP table, not of the immutable event log. The doc-07 replay guarantee ("re-run over Bronze → identical Silver") is unmet for the order mart: replaying Bronze does not rebuild the ledger, and the ledger is the dbt source. If the ledger is lost/corrupted there is no event-sourced rebuild path. The reconciliation DQ check (C4) compares Bronze order count to this ledger-derived Silver, papering over the fact that they come from different lineages.
**Root cause:** the Postgres-Bronze fallback (C1) shipped before the Bronze→ledger replay consumer; ledger writers consume the live stream directly and persist to OLTP, short-circuiting Bronze.
**Recommended fix:** Make `realized_revenue_ledger` derivable from Bronze (a replay consumer that rebuilds the ledger from `order.*`/`settlement.*` Bronze rows on the backfill lane — the "same code path" law), or point the order-state staging model at Bronze order events directly. Until then, document that the order mart's SoR is the ledger, not Bronze, and that order replay-from-Bronze is unbuilt.
**Priority:** P1 | **Tenant impact:** multi-tenant (financial truth rebuildability). **Detection:** would surface during a ledger-corruption recovery drill — replay would not reproduce the numbers.

---

### H4 — The dbt Silver tier and the StarRocks↔Bronze parity oracle are not run in CI; "same number everywhere" is not gated
**Severity:** High | **Category:** Data quality / CI gates

**Evidence:**
- Stack doc `03:207` + `03:232` make the **parity oracle** a CI gate: "continuous StarRocks-vs-Bronze reconciliation + the hot-vs-finalized convergence check … enforced, not aspirational"; "metric-parity oracle (so 'same finalized number everywhere' is enforced and a cross-brand regression fails the build)". Doc 07 §26 promises contract-testing CI gates.
- Reality: CI runs lint/unit/isolation-fuzz only. `grep -rln "dbt\|starrocks\|silver" .github/workflows/` returns **no** dbt/StarRocks job; `.github/workflows/pr.yml:66-67` runs `test:isolation` (isolation-fuzz) but no `silver-run`/`silver-verify`/`dbt test`. The dbt build is a developer-local `make silver-build`/`silver-verify` target (`Makefile:42-57`), not CI-wired.
- The reconciliation that *does* exist is a **runtime** stream-worker DQ loop (`main.ts:253-280`, default 5-min interval), not a CI gate, and it grades rather than blocks.
- The dbt replay tests (`assert_order_state_replay.sql`, `assert_touchpoint_replay.sql`) and `make silver-verify` (double-run checksum) are real and good — but they only run if a human runs them.

**Impact (production):** A change that breaks Silver math, the deterministic fold's replay-stability, or Bronze↔Silver parity ships without CI catching it. The headline "same question, same number" guarantee (`BRD §14.6`) has no automated enforcement at merge. A cross-brand leak in a Silver model would only be caught if it happened to hit the isolation-fuzz Silver tables, not via the parity oracle.
**Root cause:** the dbt/StarRocks tier requires a StarRocks+Postgres service matrix in CI that was not stood up; the parity-oracle CI gate was specified but deferred.
**Recommended fix:** Add a CI job that spins StarRocks + Postgres (compose `core` profile), runs `make silver-build` + `dbt test` + `make silver-verify` + the reconciliation check on golden fixtures, and fails the build on any non-zero test or parity delta beyond tolerance.
**Priority:** P1 | **Tenant impact:** multi-tenant. **Detection:** today a parity break is caught (if at all) by the runtime DQ grade dropping to C/D post-deploy, not at PR.

---

## MEDIUM

### M1 — Reconciliation DQ check compares mismatched grains with a flat 100-order tolerance and different lineages
**Severity:** Medium | **Category:** Data quality

**Evidence:** `apps/stream-worker/src/jobs/dq/reconciliation-check.ts:49-90`. Bronze side = `COUNT(DISTINCT order_id)` over `bronze_events WHERE event_type LIKE 'order.%'`; Silver side = `COUNT(DISTINCT order_id)` over `brain_silver.silver_order_state`. But Silver derives from `realized_revenue_ledger` (H3), not from those Bronze `order.*` rows — so the two counts measure different populations (Bronze has all observed order events incl. placed-only; Silver order-state only has orders with ledger rows). Tolerance is a frozen flat `MAX_ROW_DELTA = 100` (`:29`), absolute not relative — meaningless across a 50-order brand and a 50,000-order brand.
**Impact:** the reconciliation grade is structurally noisy: a healthy brand can show a large delta purely from placed-only orders not in the ledger-derived mart, and a flat 100 tolerance over-passes whales and over-fails small brands. The "Bronze↔Silver agree" assurance the check is meant to provide is weak.
**Root cause:** built on top of the H3 lineage split; tolerance not scaled to brand volume.
**Recommended fix:** reconcile like-for-like (Bronze orders that should reach the ledger vs Silver), and make tolerance a relative fraction of brand order count, not an absolute row count.
**Priority:** P2 | **Tenant impact:** multi-tenant (per-brand grade correctness). **Detection:** DQ grade dashboard; currently mis-grades silently.

### M2 — Silver reads Postgres as superuser via JDBC, bypassing RLS, with a uuid→text read-shim view as a permanent dev crutch
**Severity:** Medium | **Category:** Isolation / catalog design

**Evidence:** `db/starrocks/oltp_jdbc_catalog.sql:50-53` connects the StarRocks JDBC catalog as `"user" = "brain"` (superuser) which **bypasses Postgres RLS** (self-documented `:17-25`); the read-shim `db/starrocks/oltp_pg_read_shim.sql:28-38` casts `brand_id/brain_id` uuid→text because "StarRocks' JDBC catalog cannot read Postgres uuid columns". This makes the entire dbt staging read **cross-brand by construction** (`_sources.yml:14-18`). The design is defensible (dbt is the ETL writer; isolation is enforced at the Silver READ seam I-ST01), and it is honestly labelled — but it means tenant isolation in the Silver build path depends entirely on the downstream metric-engine read seam, with no defense-in-depth at the transform layer, and the read-shim is a hand-maintained parallel surface that must be kept in sync with base tables.
**Impact:** any bug in the Silver READ seam (metric-engine) is a cross-brand leak with no upstream backstop; the uuid→text shim must be re-applied on every column add and is a silent drift surface. The prod-swap to Iceberg (which the comments promise removes the shim) is unbuilt (C1), so the crutch is load-bearing indefinitely.
**Recommended fix:** keep the ETL-writer posture but add a StarRocks row-policy/test that fails if a Silver table is queryable cross-brand at the read seam (the bootstrap notes the row-policy is enterprise-only and unenforced in dev — `bootstrap.sql:52-65`); generate the read-shim from the base schema rather than hand-maintaining it.
**Priority:** P2 | **Tenant impact:** multi-tenant (isolation defense-in-depth). **Detection:** isolation-fuzz tests at the read seam; none at the transform layer.

### M3 — StarRocks tenant row-policy is unenforced in dev and gated to "enterprise/managed"; the fourth isolation layer is absent locally
**Severity:** Medium | **Category:** Isolation

**Evidence:** `db/starrocks/bootstrap.sql:52-65` — "CREATE ROW POLICY is an enterprise/managed StarRocks feature. StarRocks 3.3.2 allin1 (open-source, used in local dev) does NOT support it." Stack doc `03:228` lists "StarRocks row policies" as one of the four isolation layers. So in dev (and on any open-source StarRocks), the engine-level tenant isolation the architecture relies on does not exist; isolation is purely the application read seam. The bootstrap claims the isolation-fuzz negative-control test "will FAIL LOUD" without it (`:63-64`) — good — but the policy is simply not applied anywhere automatically.
**Impact:** one of four documented isolation layers is a no-op outside a paid StarRocks tier; the platform is one read-seam bug away from a cross-brand leak in Silver/Gold.
**Recommended fix:** confirm the prod StarRocks tier supports row policies and wire `starrocks-init` to apply them there; until then, treat the read seam as the sole Silver isolation control and test it exhaustively.
**Priority:** P2 | **Tenant impact:** multi-tenant. **Detection:** isolation-fuzz `starrocks.test.ts` (per the bootstrap note).

### M4 — Dedup is at-least-once with a 7-day Redis TTL backed by a PK; "exactly-once" is not claimed but the durability window is narrower than the replay horizon
**Severity:** Medium | **Category:** Exactly-once / idempotency

**Evidence:** Two dedup layers: Redis `SET NX EX 604800` (7 days, `RedisDedupAdapter.ts:51-52`, `DEDUP_TTL_SECONDS`) and the Bronze PK `ON CONFLICT (brand_id,event_id) DO NOTHING` (`BronzeRepository.ts:116`). Offset commit is correctly after-write (`CollectorEventConsumer.ts:51-119`, manual commit, D-7) — this is properly idempotent at-least-once, well done. **But:** the durable dedup is the Bronze PK, which only protects the **Bronze** sink. The *downstream ledger/identity/consent consumers* (`main.ts:188-234`) consume the same live topic in their own groups and rely on their own `ON CONFLICT` keys — a replay older than the Redis 7-day window re-delivers to those consumers and their idempotency is per-consumer, not centrally guaranteed. The doc-07 replay horizon is 24 months (`07:282`) but Redis dedup only covers 7 days, so a Bronze-replay over a >7-day window depends entirely on each sink's own ON CONFLICT correctness (the spend/gokwik/settlement writers).
**Impact:** correctness on long replays is only as good as each individual downstream writer's idempotency key; there is no single dedup authority across the multiplexed consumers. A sink whose ON CONFLICT key is incomplete double-counts money on a replay.
**Recommended fix:** verify every ledger/identity/consent consumer's idempotency key is deterministic and replay-safe (audit each `LedgerWriter` ON CONFLICT), and document that exactly-once is "idempotent at-least-once per sink", not a global guarantee.
**Priority:** P2 | **Tenant impact:** multi-tenant (financial double-count risk on replay). **Detection:** `collector_dedup_conflict_total` counter (`CollectorEventConsumer.ts:109`) covers Bronze only, not the ledger sinks.

### M5 — Schema version is hard-coded to literal `1`; Apicurio `schema_id` / version resolution is unbuilt
**Severity:** Medium | **Category:** Schema evolution

**Evidence:** `ProcessEventUseCase.ts:173-174` hard-codes `schema_name: 'brain.collector.event.v1'` and `schema_version: 1` ("M1 literal; Apicurio-resolved in M2"). `bronze_events.schema_version` (`0016:29`) stores the literal. Doc 07 envelope requires `schema_id` (Apicurio global id) + real `schema_version` (`07:160-161`). The Bronze table has no `schema_id` column at all (`0016:23-37`), so the exact-registered-schema pin doc 07 mandates is unrepresentable.
**Impact:** Bronze rows cannot be tied to the exact schema that validated them; schema evolution / replay-against-old-schema (`07:261` "old events stay replayable forever across all intermediate versions") cannot be reconstructed from Bronze. A `.v2` migration has no per-row version provenance.
**Recommended fix:** when C2 (Avro decode) lands, persist the resolved Apicurio `schema_id` + version per Bronze row; add the `schema_id` column.
**Priority:** P3 | **Tenant impact:** multi-tenant. **Detection:** none until a multi-version replay is attempted.

### M6 — Order backfill lane is single-partition by design; festival-scale historical rebuilds will be throughput-capped
**Severity:** Medium | **Category:** Backfill / replayability

**Evidence:** `infra/redpanda/topics.yml:31-40` — `{env}.collector.order.backfill.v1` has `partitions: 1` with the comment "Single partition = natural throughput cap (ADR-BF-7/D-3)". The backfill consumer group is single (`:81-83`). This deliberately isolates backfill from the live lane (good) but caps a full 24-month order rebuild for a whale brand to one partition's serial throughput.
**Impact:** a large historical backfill (onboarding a high-GMV brand, or a post-incident full rebuild) is serialized and slow; the 24-month replay horizon (`07:282`) is impractical to exercise at scale through this lane.
**Root cause:** intentional live-lane protection traded against backfill parallelism.
**Recommended fix:** allow per-brand partition scaling on the backfill lane (keyed by `brand_id:order_id`) while keeping it a separate topic/group from live; or document the backfill throughput ceiling and onboarding-time expectations.
**Priority:** P3 | **Tenant impact:** single-brand (the brand being backfilled), but onboarding-blocking. **Detection:** backfill job duration metrics.

---

## LOW

### L1 — Dual collector-envelope shapes (Zod `event_name`/ISO-string vs Avro/Bronze `event_type`/millis) remain unreconciled
**Severity:** Low | **Category:** Contract consistency
**Evidence:** `data-collection-platform/10:15-20` flags this as "the highest-risk decision in the cluster": Zod `CollectorEventV1Schema` uses `event_name` + ISO-8601 strings + `schema_version:'1'` (string); the Avro/`bronze_events`/fixture wire shape uses `event_type` + millis + `schema_version` int. The consumer bridges them ad hoc (`ProcessEventUseCase.ts:104` destructures `event_name`, writes `event_type: event_name` at `:174`). Doc 10 rules they must be byte-aligned additively on the next contract change; not yet done. Since the wire is JSON+Zod today (C2), this is currently latent, but it is a documented trap that will bite the SDK contract change.
**Impact:** a future SDK/Avro alignment that picks the wrong field name silently breaks Bronze idempotency / dedup keying.
**Recommended fix:** execute the doc-10 reconciliation (rename Zod `event_name`→add `event_type`, accept millis) before any real browser event ships.
**Priority:** P3 | **Tenant impact:** multi-tenant. **Detection:** would surface as a Bronze dedup/parse regression on the SDK contract change.

### L2 — `event_id` documented as UUID v7 (envelope) but the Avro schema doc-string says v4; dedup/ordering assumptions diverge
**Severity:** Low | **Category:** Contract consistency
**Evidence:** Doc 07 envelope: `event_id … (uuid v7)` (`07:156`). Avro schema: `"event_id" … "UUID v4"` (`infra/redpanda/schemas/collector.event.v1.avsc:10`). v7 is time-ordered (useful for any id-ordered tiebreak); v4 is random. The discrepancy is undocumented.
**Impact:** any code assuming `event_id` is time-sortable (a v7 property) is wrong against a v4 generator. Minor today (ordering comes from `occurred_at`), but a latent trap.
**Recommended fix:** pick one (v7 preferred for the envelope's stated dedup/ordering intent) and align the doc-string + generator.
**Priority:** P3 | **Tenant impact:** none/multi-tenant. **Detection:** none.

### L3 — No compaction / snapshot-expiry / retention job exists for the Bronze sink (Postgres)
**Severity:** Low | **Category:** Lakehouse maintenance
**Evidence:** Doc 07 §12 (`07:345`) requires an "Argo compaction + snapshot-expiry job from Phase 1" and 24-month partition-expiry TTL. `bronze_events` (`0016`) is an unpartitioned Postgres table with no TTL/retention job; no compaction job exists (none in `apps/stream-worker/src/jobs/`, none in infra). Doc 10 D10.3 explicitly lists "retention TTL/Iceberg partition-expiry" as Gated/not-yet (`data-collection-platform/10:70`), so this is disclosed at the doc-10 layer but contradicts doc 07's "from Phase 1".
**Impact:** Bronze grows unbounded in Postgres; no 24-month enforcement; no small-file/compaction story (it's a heap table). Operationally fine short-term, unsustainable at the documented scale.
**Recommended fix:** add a scheduled retention/partition job for the Postgres Bronze sink as an interim, and reconcile doc 07 §12's "Phase 1" against doc 10's "gated".
**Priority:** P3 | **Tenant impact:** multi-tenant (storage growth). **Detection:** Postgres table-size growth alerts.

---

## What is genuinely solid (counter-evidence, to be fair)

- **Offset-commit discipline** is correct: manual commit only after Bronze write / dedup / DLQ confirmed, per-`(partition,offset)` retry counter, MAX_RETRY→DLQ (`CollectorEventConsumer.ts:51-160`). No commit-before-write loss.
- **The dbt Silver models are well-engineered and genuinely replay-safe by construction**: the deterministic latest-state fold (`silver_order_state.sql:51-71`), server-side 30-min sessionization re-derived from event-time rather than trusting client `session_id` (`int_touchpoint_sessionized.sql:35-72`), deterministic channel CASE ladder (no model), and the replay-stability tests + `make silver-verify` double-run checksum (`assert_order_state_replay.sql`, `assert_touchpoint_replay.sql`). The "additive-only marts, all non-additive math in metric-engine" discipline (ADR-004) is followed.
- **DQ grading is correctly Tier-0 deterministic** (`dq/grade.ts`): frozen band lookup, fail-closed to D on NaN/negative/unreachable, honest "estimated/untrusted" semantics — exactly the data-quality skill's estimated→authoritative gate, no model where a threshold fits.
- **Tenant isolation on the Bronze write path is real**: brain_app (not superuser) + per-txn `set_config` GUC + FORCE RLS + append-only GRANT + `(brand_id,event_id)` PK (`0016:43-54`, `BronzeRepository.ts:101-104`). The cross-brand-claim quarantine (derive brand from install_token server-side, never trust the client's brand_id) is a strong R2 control (`ProcessEventUseCase.ts:120-157`).
- **Backfill uses the same `ProcessEventUseCase` code path as live** (`main.ts:173`), honouring the "no separate backfill codebase" law — the lane differs, the code does not.

---

## Verdict

The data plane's *transform discipline* (deterministic replay-safe dbt folds, Tier-0 DQ grading, append-only ledgers, fail-closed isolation on writes, single-code-path backfill) is principal-grade and largely matches the canon. The *substrate* does not: the documented Iceberg lakehouse — the "heart of the data plane" — is a Postgres table written by a hand-rolled writer (C1); the Avro/Apicurio schema-governance layer is registered-but-bypassed JSON (C2); the typed-topic catalogue is collapsed to one JSON topic routed by consumer group (H1/H2); the order Silver mart is built from the OLTP ledger rather than Bronze, with no Bronze→ledger replay path (H3); and the parity oracle that is supposed to enforce "same number everywhere" is not in CI (H4). Critically, much of this is *honestly self-documented in code as a Phase-1 D-4 fallback* — the engineering team knows — but the requirement docs (03/07) still present the lakehouse as shipped, so the gap is invisible at the artifact layer and will surface as a hard Phase-3 migration. **Pass result: FAIL** — not because the code is sloppy (it largely isn't), but because the auditable system diverges materially from the documented data architecture on its load-bearing claims (open Iceberg SoR, schema governance, Bronze-replay, parity-in-CI), and those divergences are undisclosed in the governing requirement docs.
