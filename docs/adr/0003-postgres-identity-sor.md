# ADR-0003 — Postgres is the identity system-of-record; the Neo4j dual-write is retired

Status: **Accepted** (2026-06-22)
Resolves the identity finding in the Brain audit remediation: a best-effort Neo4j dual-write was minting
**divergent** brain_ids that nothing read.

## Context

Brain's identity layer resolves hashed identifiers (email / phone / storefront_customer_id, and — as of
this remediation — device_id / anon_id) to a stable `brain_id` per brand. Two write paths existed:

1. **Postgres** (`identity.identity_link`, `identity.customer`, `identity.identity_merge_event`,
   `brain_id_alias`, `shared_utility_identifier`, `merge_review_queue`, `identity_audit`), written by
   `apps/stream-worker` via `IdentityRepository` under `brain_app` with RLS forced and the brand GUC,
   in one transaction. The resolver (`IdentityResolver`) is a deterministic union-find: **mint** =
   `randomUUID()`, **link** = attach to the single matched brain_id, **merge** = fold ≥2 strong-matched
   brain_ids into the lowest UUID with a deterministic `merge_id` and an append-only alias/audit trail.

2. **Neo4j** (`@brain/identity-graph`, re-platform "Phase D" experiment), dual-written best-effort from
   `ResolveIdentityUseCase` when `NEO4J_URI` was set. Its mint is `deterministicBrainId(brand, minHash)`
   — a v5-style UUID derived from the lexicographically-smallest identifier hash.

### The problem

The two paths mint **different brain_ids for the same person** (`randomUUID()` vs a hash-derived UUID),
so the graph could never be at parity with the SoR. Critically, **every reader** — Customer 360
(`get-customer-360.ts`), customer list (`list-customers.ts`), merge-admin, erase-customer, the analytics
marts (`silver_customers`, `gold_customer_*`), and attribution — reads **Postgres**. Nothing reads Neo4j.
The dual-write therefore produced a parity-free shadow graph for **no consumer**, while adding write
latency, an operational dependency, and a standing "is identity consistent?" question with no answer.

Brain's principles are **deterministic-first**, **preserve tenant isolation**, and **append-only
ledgers**. Postgres already satisfies all three for identity: RLS + brand GUC give hard per-brand
isolation, the merge/alias/audit tables are append-only, and the union-find is fully deterministic and
replayable from Bronze. A graph store earns its place only when a reader needs graph traversal — there is
no such reader today.

## Decision

1. **Postgres is the declared identity system-of-record.** All identity reads and writes go through PG.
   The deterministic union-find resolver and its RLS-isolated, append-only tables are authoritative.

2. **Retire the Neo4j dual-write.** It is **default-OFF**. `NEO4J_URI` alone no longer triggers it; an
   operator must additionally set `IDENTITY_NEO4J_DUAL_WRITE=true` to enable it, and when enabled it is
   explicitly logged and treated as a **non-authoritative, parity-free projection** that nothing reads.

3. **Preserve, do not delete, the code.** `@brain/identity-graph`, `Neo4jIdentityWriter`, and the
   mirror branch in `ResolveIdentityUseCase` are kept and relabelled. If a future feature genuinely needs
   graph traversal over identity, it starts from this code behind a real parity gate (mirroring
   `ADR-0002`'s parity-gated cut-over discipline) — not from a silent divergent dual-write.

## Consequences

- One source of truth for identity (PG); no divergent brain_id minting; no parity question with no answer.
- Identity resolution has one fewer external dependency on the hot path; a Neo4j outage is irrelevant.
- The forward order path (`LiveLedgerBridge` → `BrainIdResolver`) and the C2 medium-tier inputs
  (device_id / anon_id) all resolve against the PG SoR, so attribution and Customer 360 stay consistent.
- Reversible: flip `IDENTITY_NEO4J_DUAL_WRITE=true` to re-enable the projection for experimentation; a
  real migration to a graph SoR would require a new ADR + a parity oracle, exactly as Bronze did.
