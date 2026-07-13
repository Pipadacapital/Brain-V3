# ADR-0012 — Idempotent ingest: no duplicate events in Brain (live, re-pull, backfill, replay)

Status: **Proposed** (2026-07-13)
Relates to: ADR-0010 (Bronze landing writer), ADR-0002/0006 (Bronze contract), ADR-0008 (ingest scheduler).
Amends: the ratified invariant *"Bronze is append-only; dedup lives in Silver"* (CLAUDE.md) — see Consequences.
Driver: explicit user requirement (2026-07-13) — *"There should not be any duplicate event coming in Brain"*, including during backfill.

## Context

The current contract (ADR-0006 D2, restated in ADR-0010) makes **Bronze append-only**: every arrival
is landed verbatim, and de-duplication happens downstream in **Silver** on a per-lane `dedup_key`.
That was chosen for replay-safety and "Bronze is source of truth."

The cost of that choice surfaced as a live prod incident (2026-07-13): a **Shiprocket shipment
re-pull** for one test brand (Sugandh Lok, `e43be5e6…`) re-emitted its 45-day shipment window
continuously at **~105 events/s → 8.5M events / 6.8M-event identity backlog**, all resolving to the
same `brain_id`. Every duplicate was accepted into Bronze and paid the **full identity-resolution
cost in Neo4j** (the ~110/s single-node ceiling) *before* Silver would have collapsed it. Duplicates
were structurally invisible until Silver — so a re-pull, a retry storm, or a backfill overlap can
saturate the platform with work that is thrown away one stage later.

The operator requirement is that **duplicates never enter Brain at all** — from pixels, connectors,
re-pulls, retries, and **backfills** — not that they are cleaned up after the fact.

## Key enabler: events already carry a deterministic identity

Every event carries a **deterministic `event_id`** (uuidv5 over the event's natural key) and a
per-lane `dedup_key`. The same logical event (a given shipment status, order, or pixel action)
produces the **byte-identical** `event_id` whether it arrives live, via a re-pull, or via a backfill
months later. This is the idempotency key that makes a single dedup rule cover every duplicate
source. Its correctness is a **precondition** (see Decision §3).

## Decision

Enforce **idempotent (effectively-once) ingest at the front door**, so a duplicate `event_id` is
dropped before it is produced to Kafka / landed in Bronze. One rule — *"have I already ingested this
`event_id`?"* — covers live, re-pull, backfill, retry, and replay uniformly.

1. **Durable dedup index (not a TTL cache).** A persistent, full-history store of ingested ids —
   `ingest_dedup(brand_id, event_id)` keyed unique, written `INSERT … ON CONFLICT DO NOTHING`; the
   `RETURNING`/rowcount decides new-vs-seen. **A TTL cache is insufficient for backfill**: a backfill
   re-ingesting 6-month-old events must still be recognized as seen, so the index must span the full
   retained history (partition by month + retention aligned to the longest backfill window; a
   bloom-filter fast-path in front is optional at scale). `brand_id`-first (tenant isolation).

2. **Placement at the ingest boundary.** The check runs where events enter — the collector (pixel +
   webhook connectors) and the connector re-pull/backfill emitters — *before* the Kafka produce. New
   ids proceed; seen ids are dropped and counted (`ingest_dedup_dropped_total{source,provider}`) so
   duplicate volume is observable, never silent.

3. **`event_id` determinism audit (precondition).** Before enabling drop-on-duplicate, audit **every**
   connector mapper and the pixel to prove `event_id` is derived **only** from the logical natural key
   — never from fetch time, run id, or ingest time. Any non-deterministic derivation is a correctness
   bug that must be fixed first, or that source's duplicates will slip through with fresh ids.

4. **Backfill is cursor/watermark-incremental (efficiency, paired with §1's guarantee).** Backfills
   and re-pulls fetch only records **changed since the last cursor**, not a fixed overlapping window
   (the 45-day re-blast is the anti-pattern that triggered the incident). Incrementality minimizes how
   much the dedup index must reject; the index (§1) remains the guarantee for the unavoidable overlaps
   (late-arriving updates, cursor resets, connector pagination quirks, at-least-once producers).

## Consequences

**Positive**
- Duplicates never reach Bronze/identity — the Neo4j identity tier stops paying for re-pull/backfill
  overlap; the incident class is eliminated at the source.
- Replay-from-Bronze and backfill become **idempotent by construction** (re-deriving the same ids is a
  no-op), which *strengthens* the "no event loss / no duplication" guarantees rather than weakening
  them.
- Silver's per-lane dedup becomes a defense-in-depth backstop, not the primary control.

**Trade-offs / risks (on the record)**
- **Amends "Bronze append-only."** Bronze now holds *unique* events, not every raw arrival. "Bronze is
  source of truth" still holds (it is the unique-event system of record), but re-derivation now depends
  on the dedup index being correct/durable — the index becomes a critical-durability component (backup +
  the `INSERT … ON CONFLICT` must be transactionally coupled to the produce/land, or a crash between
  them can drop or double an event; prefer transactional-outbox or land-then-mark semantics).
- **Index growth** scales with total unique events; needs partitioning + retention (≥ longest backfill
  window) and possibly a bloom-filter fast-path so the hot-path check stays O(1) at high volume.
- **Determinism debt**: any connector whose `event_id` is not purely natural-key-derived must be fixed
  first (§3), else effectively-once degrades to at-least-once for that lane.
- Adds a synchronous store lookup to the ingest hot path — must be low-latency (co-located PG/Redis) so
  it doesn't cap collector throughput below the identity ceiling it protects.

## Rollout (proposed, not yet implemented)

1. Land the `ingest_dedup` store + `event_id` determinism audit across all connectors + pixel (fix any
   non-deterministic derivations) — **shadow mode first**: record would-drop counts, drop nothing.
2. Verify the shadow drop-rate matches the Silver-dedup-rate (proves the index catches exactly the
   duplicates Silver was collapsing) → then flip to enforce (drop-on-duplicate).
3. Convert connector re-pulls/backfills to cursor-incremental (§4).
4. Retire Silver per-lane dedup to a backstop role once ingest enforcement is proven.

Until this ships, the operational mitigation for a runaway re-pull is to pause the offending
connector's schedule (`connectors.connector_instance.next_repull_at`) — see the 2026-07-13 incident.
