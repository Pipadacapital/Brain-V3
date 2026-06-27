/**
 * identity/repository.ts — the IdentityGraphRepository port: the read/commit seam over the
 * identity graph (Neo4j = the system of record, ADR-0004).
 *
 * BINDS THE EXISTING ADAPTER, DOES NOT REPLACE IT. This port is the domain-contract twin of
 * the `IdentityStore` interface in apps/stream-worker/src/domain/identity/IdentityStore.ts,
 * which the `Neo4jIdentityRepository` already satisfies. `@brain/contracts` is a LEAF package
 * and may not import from apps/* — so the binding is structural + documented, not a code
 * import. The mapping is intentional and 1:1:
 *
 *   IdentityStore.readState(brandId, hashes, now) ─────► IdentityGraphRepository.readState(...)
 *   IdentityStore.writeOutcome(brandId, outcome, ids) ─► IdentityGraphRepository.applyDecision(...)
 *
 * Crucially this is the NEO4J graph port — NOT a new Postgres store. The legacy PG
 * IdentityRepository was removed when the PG identity tables were dropped (Epic 3 / ADR-0004);
 * PG is operational-only. Do not implement this against a `brain_*` PG table.
 *
 * Pure types only — no IO here. Implementations live in the stream-worker infrastructure layer.
 */
import type { Identifier } from './identifier.js';
import type { IdentityDecision, Compensation } from './decision.js';

/**
 * The pre-fetched graph read-state a matcher/resolver needs to decide. Hash-only, brand-scoped.
 * Mirrors the role of `IdentityReadState` (IdentityStore.ts) — the existing adapter's richer
 * phone-guard/alias-chain state is its concrete implementation of this contract-level shape.
 */
export interface IdentityGraphReadState {
  brand_id: string;
  /** Already-known identifiers overlapping the query (the merge candidates). */
  existingIdentifiers: Identifier[];
  /** brain_ids already observed in a live alias chain (cycle-guard input). */
  aliasChain: string[];
}

/** Receipt of a committed (or idempotently no-op) IdentityDecision. */
export interface IdentityDecisionReceipt {
  /** True when the graph was mutated; false on an idempotent replay (e.g. ON CONFLICT no-op). */
  committed: boolean;
  /** The brain_id the decision resolved to (canonical/minted), when applicable. */
  brain_id?: string;
  /** The compensation needed to reverse this commit — echoed for the saga/undo log. */
  compensation: Compensation;
}

/**
 * IdentityGraphRepository — the Neo4j-backed identity graph port.
 *
 * `readState` loads the resolution inputs; `applyDecision` commits a reversible
 * IdentityDecision (and returns its compensation for the undo log). Both are brand_id-scoped
 * and hash-only. This is the SAME seam the existing `Neo4jIdentityRepository` fulfils — a new
 * implementation must target the graph SoR, never a PG identity table.
 */
export interface IdentityGraphRepository {
  /** Load the (hash-only) read-state for a set of tenant-scoped identifiers. */
  readState(args: {
    brand_id: string;
    identifiers: Identifier[];
    now?: Date;
  }): Promise<IdentityGraphReadState>;

  /** Commit a reversible IdentityDecision to the graph; returns its receipt + compensation. */
  applyDecision(args: {
    brand_id: string;
    decision: IdentityDecision;
  }): Promise<IdentityDecisionReceipt>;

  /**
   * Reverse a previously-applied decision using its compensation descriptor (the saga undo
   * path). brand_id-scoped; idempotent on replay.
   */
  compensate(args: {
    brand_id: string;
    compensation: Compensation;
  }): Promise<{ reversed: boolean }>;
}
