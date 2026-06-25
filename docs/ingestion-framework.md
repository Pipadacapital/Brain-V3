# Ingestion Framework Foundation

> Data is the soul of Brain. **No event loss. No duplicate ingestion. Bronze is the source of truth.**

This document describes the connector-agnostic ingestion framework that lives in
`@brain/connector-core`. It is the foundation that lets **every** connector pull **everything** the
upstream platform offers — all REST resources, all webhook/event topics, all stream subjects — with
up to **2 years** of historical backfill (or the platform's maximum), **resumably / in chunks**
(can run in intervals or be picked up later), with **strict dedup** and **zero data loss**.

It does NOT yet rewrite the individual connectors. It ships the **contracts + a reference
implementation + a per-resource backfill registry** that a later slice onboards each connector onto.

---

## The four contracts

| Contract | File | Brain rule it enforces |
| --- | --- | --- |
| **IngestionManifest** | `contracts/IngestionManifest.ts` | "pull EVERYTHING, up to the platform's max window" — expressed as data, not per-connector prose |
| **Backfill driver** | `contracts/Backfill.ts` + `domain/entities/ResourceBackfillState.ts` | resumable / chunked / idempotent historical backfill |
| **Dedup** | `contracts/Dedup.ts` | "no duplicate ingestion" — same fact → same `event_id` |
| **NoLoss** | `contracts/NoLoss.ts` | "no event loss" — bounded retry → DLQ spool, never drop |

They compose: the **Backfill driver** walks a resource declared by the **Manifest**, derives each
record's `event_id` via **Dedup**, and delivers it via **NoLoss**. Because the id is deterministic
and the cursor is checkpointed after every chunk, the whole thing is idempotent, resumable, and
crash-safe.

---

## 1. IngestionManifest — the resource registry

A connector **declares** one `IngestionManifest`: its provider id plus a `ResourceDescriptor` for
**every** resource it can ingest. This is the Single-Primitive Rule applied to ingestion breadth —
ONE manifest shape, every connector conforms to it.

A `ResourceDescriptor` declares, per resource:

- `name` — stable resource key, **also** the `resource` column on `connector_cursor` and on the new
  `resource_backfill_state` table (durable — renaming it orphans cursors).
- `kind` — `rest` (polled, backfillable) | `webhook` (pushed, real-time) | `stream` (subscription).
- `emits` — the canonical Brain `event_name`(s) this resource produces.
- `backfillSupported` + `maxBackfillWindowMs` — does it backfill, and how far back does the
  **platform** allow? `resolveBackfillFloor()` clamps a requested window to
  `min(requested, maxBackfillWindowMs)`, so a connector can never claim more depth than the platform
  can serve. Defaults: `TWO_YEARS_MS` (Brain's target) or `UNBOUNDED_BACKFILL_WINDOW_MS`
  (finite sentinel — survives JSON/DB round-trips and date math without `NaN`).
- `cursorStrategy` — `since_id` | `updated_at` | `page_token` | `page_number` | `date_window`.
- `dedupKeyStrategy` (+ `dedupKeyFields` for `composite`) — how a raw record reduces to a stable
  identity.

`assertManifestValid()` fail-fasts at **registration time** (startup), never at ingest time:
unique non-empty names, backfillable REST resources must declare a `cursorStrategy`, composite
dedup must declare fields, positive finite window.

---

## 2. Backfill — resumable, chunked, idempotent

The separation of concerns is the key move:

- The **connector** implements only `IResourcePageFetcher`: *"given a cursor, return the next page of
  raw records + the next cursor."* It knows nothing about checkpointing, resumption, dedup, retries,
  or DB state — just how to page its own API.
- The **driver** (`runResumableBackfill`) owns the loop: clamp the window → resume from the persisted
  cursor → fetch a page → derive each record's deterministic `event_id` → deliver with no-loss →
  **checkpoint the cursor + deepest `reachedAt` after the chunk**.

Because the cursor is persisted after **every** chunk and every `event_id` is deterministic, the
driver is:

- **Resumable / chunked** — `maxChunksThisRun` lets a backfill run in bounded intervals (a cron
  slice of N pages, then `paused`). The next run resumes from the persisted cursor — it does not
  restart.
- **Crash-safe** — a mid-run crash resumes from the last checkpoint.
- **Idempotent** — re-running a partially-done backfill re-emits already-seen records; Bronze drops
  them on `event_id`. No duplicates, no loss.

Stop reasons: `completed` (reached the floor / no more pages) · `paused` (hit the chunk budget) ·
`failed` (auth/reconnect — **cursor preserved** for a manual resume, never restarted).

`ResourceBackfillState` (the entity) carries the window (`anchorAt → floorAt`), the checkpointed
`cursor`, the deepest `reachedAt` (monotonic — a newer record never moves the frontier forward),
the lifetime `recordsProcessed`, and the resumable `status`.

### Why a new table (`jobs.resource_backfill_state`, migration 0111)

The existing tables are **insufficient for the multi-resource resumable case**:

- `jobs.backfill_job` (0022) tracks at most **one** active job per `connector_instance` (its
  active-lock partial index is keyed on `connector_instance_id` alone) and has **no `resource`
  column**. It cannot represent "orders 80% backfilled AND customers 30% backfilled" at once.
- `connectors.connector_cursor` (0006) is the **live/repull** watermark per resource (newest seen),
  **not** the historical backfill frontier (oldest reached). Overloading it would conflate the two.

`resource_backfill_state` is the missing third thing: **per-(brand, connector_instance, resource)**
resumable backfill state, upsert-keyed on the same triple `connector_cursor` uses. It is born-secure
(RLS **enabled + forced**, two-arg `current_setting` fail-closed, `SELECT/INSERT/UPDATE` only — no
`DELETE`). A scheduler enumerates resumable rows via the `list_resumable_backfill_states()`
SECURITY DEFINER fn (mirrors 0023's `list_queued_backfill_jobs()`): at poll time no brand GUC is
known, so the fn bypasses FORCE RLS for the **enumeration step only** and returns dispatch metadata
(no tenant data). `backfill_job` stays as-is — it is the immutable dispatch ledger; this is the
mutable frontier.

---

## 3. Dedup — same fact → same id

The no-duplicate guarantee is an **id-derivation** problem, not a "have I seen this?" lookup — there
is no per-record state to keep, which is what makes it survive replays, backfills, and multi-worker
concurrency.

`buildDedupNamespace()` builds a **tenant-led** (`brandId` first) namespace from the resource's
declared `dedupKeyStrategy`:

- `provider_id` → `${brandId}:${provider}:${resource}:${providerId}`
- `provider_id+kind` → `…:${providerId}:${eventName}` (one upstream id that fans out into several
  event kinds — each kind gets its own stable id)
- `composite` → `…:${field0} ${field1}…` (NUL-joined so value boundaries cannot alias)

`DeterministicDedupKeyDeriver` hashes the namespace through the **same** `hashToUuidShaped`
algorithm every existing mapper already uses, so framework-derived ids are byte-for-byte compatible
with the ids already in Bronze. Tenant-led namespacing means two brands with the same upstream id
**never** collide.

---

## 4. NoLoss — retry → DLQ, never drop

"Zero loss" = at-least-once delivery **paired with** deterministic dedup (so at-least-once is safe).

`deliverWithNoLoss()` attempts `IEventSink.deliver(event)` up to `RetryPolicy.maxAttempts` with
exponential backoff (`DEFAULT_RETRY_POLICY` = 5 attempts, 200ms → 10s cap). If every attempt fails,
the event is **spooled to the `IDeadLetterSink`** (the `dlq_record` table / a DLQ topic) **with its
deterministic `event_id`** — never dropped — and can be replayed later (idempotently). If the DLQ
spool **itself** fails, the error **propagates** so the worker crashes loudly; the upstream source is
replayable, so a loud crash is correct — a silent swallow there would be the only place an event
could truly be lost.

The kernel stays free of `kafkajs`/`pg`: `IEventSink` (a Kafka idempotent producer onto the ingest
topic) and `IDeadLetterSink` (the DLQ table) are **interfaces** the runtime implements.

---

## How a connector onboards (the later slice)

1. **Declare a manifest** — one `IngestionManifest` listing every resource the platform offers
   (`assertManifestValid()` at startup).
2. **Implement `IResourcePageFetcher`** — page each backfillable resource's API; map raw → one or
   more `CanonicalEventDraft` (no `event_id` — the driver stamps it).
3. **Wire the runtime sinks** — an `IEventSink` (idempotent Kafka producer → Bronze) and an
   `IDeadLetterSink` (→ `dlq_record`), plus a `IResourceBackfillStateRepository` over
   `jobs.resource_backfill_state`.
4. **Run** `runResumableBackfill(...)` per resource — optionally with `maxChunksThisRun` to run in
   cron-sliced intervals. Live/webhook resources reuse the same Dedup + NoLoss path.

The Shopify 24-month order backfill (`apps/stream-worker/src/jobs/shopify-backfill`) is the
reference behaviour this generalises: its page-loop → page-fetcher, its `cursor_value` checkpoint →
`ResourceBackfillState`, its `uuidV5FromOrderBackfill` → the Dedup deriver. Onboarding it (and the
other 7 connectors, each pulling its **full** resource set) is the next slice — this foundation
makes that a data + page-fetcher change, not new bespoke job code per resource.

---

## Files

- `packages/connector-core/src/contracts/IngestionManifest.ts`
- `packages/connector-core/src/contracts/Backfill.ts`
- `packages/connector-core/src/contracts/Dedup.ts`
- `packages/connector-core/src/contracts/NoLoss.ts`
- `packages/connector-core/src/domain/entities/ResourceBackfillState.ts`
- `packages/connector-core/src/domain/repositories/IResourceBackfillStateRepository.ts`
- `packages/connector-core/src/__tests__/ingestion-framework.test.ts` (31 unit tests)
- `db/migrations/0111_resource_backfill_state.sql`
