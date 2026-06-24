# ADR-0004 — Neo4j becomes the identity system-of-record (supersedes ADR-0003)

Status: **Accepted** (2026-06-24)
Supersedes: **ADR-0003** (Postgres is the identity SoR; Neo4j dual-write retired).

Part of the **medallion realignment** program (see `docs/strategy/medallion-realignment-program.md`):
PostgreSQL holds **operational app state only**; the identity *graph* is canonical analytical/relational
state and belongs in the graph store, not in PG. This ADR records the binding product decision (decision
**C**) to make **Neo4j the identity system-of-record** and the **safe sequence** to get there without
ever dropping a proven SoR prematurely.

## Context

ADR-0003 (2026-06-22) made Postgres the identity SoR and retired the best-effort Neo4j dual-write. That
was the correct call **at the time**: the Neo4j path minted **divergent** brain_ids
(`deterministicBrainId(brand, minHash)` — a hash-derived v5 UUID) versus PG's `randomUUID()`, it had **no
readers**, and there was no parity oracle. ADR-0003 explicitly stated that a real migration to Neo4j
"would require a new ADR and a parity oracle like the Bronze flip did." This is that ADR.

The medallion target architecture is unambiguous: identity resolution is a **graph** problem (union-find
over identifier↔customer edges, merge/unmerge as graph re-pointing, traversal for journey stitching). A
relational store models it only by emulation (`identity_link` + `brain_id_alias` union-find tables +
SECURITY DEFINER merge/erase functions). Per the governing directive — *align the implementation to the
Brain architecture, not the reverse* — identity belongs in Neo4j.

### Why this is hard (the constraints the migration must honour)

1. **Tenant isolation without RLS.** PG enforces per-brand isolation with forced RLS + the
   `app.current_brand_id` GUC — a *database-level* guarantee. Neo4j has no row policies. Isolation
   becomes **application-layer**: every node carries `brand_id`, every Cypher query is brand-scoped, and a
   single seam (mirroring `withSilverBrand`) must inject the brand predicate so a caller *cannot* forget
   it. This is a security-sensitive downgrade from a DB guarantee to an app guarantee — it needs a
   non-inert isolation-fuzz proof (disabling the predicate MUST leak cross-brand) before cutover.
2. **DPDP compliance.** `erase_customer()` (right-to-deletion) and the immutable merge/audit trail are
   compliance-load-bearing. The Neo4j path must hard-delete PII edges + tombstone identifiers atomically,
   and preserve an **append-only audit**. Decision: `identity_audit` (immutable ledger) stays in
   **Postgres** (operational/legal record) even after the graph moves — audit is operational state, not
   graph state. The graph holds the live resolution; PG holds the immutable "what happened" log.
3. **Deterministic, replayable mint.** Resolution must be replayable from Bronze (same identifiers → same
   brain_id). The current PG `randomUUID()` mint is *not* replayable; the retired Neo4j
   `deterministicBrainId` *was* — that determinism is desirable and is retained.
4. **brain_id format change (product ask).** brain_id moves from an opaque UUID to a **human-identifiable
   pattern** — `brn_<brand-short>_<base32(seq|hash)>` (exact format TBD in the build) — so support/ops can
   eyeball it. This is cross-cutting: brain_id is stamped on orders, the gold revenue ledger, the customer
   marts, identity_link, CAPI subject joins, and journey stitch. The format change ships **with** the SoR
   swap (one disruption, not two) and is covered by the same parity oracle.

## Decision

1. **Neo4j is the declared identity system-of-record.** The resolver writes the graph; all readers read
   the graph (directly, or via a brain_id stamped on orders upstream).
2. **brain_id is minted deterministically** from the resolved identity anchor and rendered in the new
   human-identifiable pattern. Same person → same brain_id on replay.
3. **`identity_audit` remains in Postgres** as the immutable compliance ledger. Everything else in the
   `identity` schema (customer, identity_link, identity_merge_event, brain_id_alias,
   shared_utility_identifier, merge_review_queue, contact_pii) moves to / is superseded by the graph.
   `contact_pii` (raw PII vault) stays a PG vault table (encrypted, elevated RLS) — the graph holds
   **hashes only**, never raw PII.
4. **Per-brand isolation is enforced at a single application seam** (`withGraphBrand`, the Neo4j analogue
   of `withSilverBrand`) with a non-inert mutation proof in the isolation-fuzz suite.

## The safe sequence (NON-NEGOTIABLE — never drop a SoR before its replacement is proven)

This mirrors the Bronze flip discipline exactly:

1. **Build** the Neo4j-SoR write path (deterministic mint, link, merge/unmerge, phone-guard, cycle-guard,
   erase) + the brand-scoped read seam. Resolver logic (`IdentityResolver`, pure domain) is reused as-is;
   only the repository adapter swaps PG→Neo4j.
2. **Dual-write + parity oracle.** Run PG (current SoR) and Neo4j (candidate) in lockstep over live
   Bronze; a parity oracle asserts the same person resolves to the same identity set in both, the same
   merges happen, and erase is honoured in both. Reconcile divergences until parity is green (the Bronze
   flip's `610099183`-style fingerprint discipline).
3. **Cut over readers**, lowest-risk first: Customer 360 → list-customers → CAPI subject join →
   BrainIdResolver (order stamping) → journey-stitch → merge-admin → erase. Each reader migrates behind a
   flag with a dual-read parity check.
4. **Flip the mint** to the new brain_id pattern once all readers read the graph (the stamped brain_id on
   new orders changes format; historical orders keep their old id or are backfilled — decided at build).
5. **DELETE** the PG identity tables (except `identity_audit` + `contact_pii`) + the SECURITY DEFINER
   merge/erase functions + the dual-write scaffolding, and retire ADR-0003.

## Consequences

- Identity is modelled in its natural store; journey stitching becomes a graph traversal, not a
  cross-store join.
- **Tenant isolation moves from a DB guarantee to an app-layer guarantee** — accepted, mitigated by the
  single-seam predicate + non-inert fuzz proof, and revisited if/when managed Neo4j offers row-level
  controls.
- The migration is **reversible until step 5**: the parity oracle + dual-write mean PG remains the live
  SoR until the graph is proven and readers are cut over.
- **Status of this work (2026-06-24):** decision recorded; the revenue/attribution read-plane realignment
  (Epics 1–2) is done and committed on `feat/pixel-install-checkout-status`. The identity build (steps
  1–5 above) is **not yet started** — it is the largest remaining epic and is gated on the parity oracle
  per this ADR. Until step 5 completes, ADR-0003 remains operationally in force (PG is still the live SoR).
