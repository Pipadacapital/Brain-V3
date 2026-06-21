/**
 * @brain/identity-graph — the customer IDENTITY GRAPH on Neo4j (re-platform Phase D).
 *
 * Moves identity STORAGE from Postgres (identity_link / customer / identity_merge_event) to a graph,
 * where stitching is its natural shape. The crypto is unchanged: identifiers arrive ALREADY hashed
 * (per-brand salt, via @brain/identity-core) — NO raw PII ever reaches this layer.
 *
 * GRAPH MODEL (per-brand subgraph — brand_id on every node):
 *   (:Identifier {brand_id, type, hash}) -[:IDENTIFIES]-> (:Customer {brand_id, brain_id})
 *
 * RESOLVE = deterministic union-find stitching:
 *   - minted: no identifier in the set is known → create a Customer with a DETERMINISTIC brain_id
 *     (uuid derived from brand + the lexicographically-smallest hash in the set), connect all ids.
 *   - linked: exactly one Customer is already connected → attach any new ids to it.
 *   - merged: the ids span ≥2 Customers → fold them into the canonical (min brain_id), repoint all
 *     ids, delete the absorbed Customers (and stamp merged_into for audit).
 *
 * brain_id is deterministic so a rebuild-from-Bronze replays to the same graph (the C-3 guarantee).
 * Isolation: every node carries brand_id and every query is brand-scoped — cross-brain stitching is
 * impossible (a P0 invariant). The writer is async off Bronze (idempotent), never a synchronous gate.
 */
import neo4j, { type Driver } from 'neo4j-driver';
import { createHash } from 'node:crypto';

export type IdentifierType = 'email' | 'phone' | 'device_id' | 'external_id';
export interface HashedIdentifier {
  readonly type: IdentifierType;
  readonly hash: string;
}
export type ResolveOutcome = 'minted' | 'linked' | 'merged' | 'skipped';
export interface ResolveResult {
  readonly brainId: string | null;
  readonly outcome: ResolveOutcome;
}

/** Deterministic brain_id: a v5-style uuid from sha256(brand:anchorHash). Stable across replays. */
export function deterministicBrainId(brandId: string, anchorHash: string): string {
  const h = createHash('sha256').update(`${brandId}:${anchorHash}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export class IdentityGraph {
  private readonly driver: Driver;

  constructor(uri: string, user: string, password: string) {
    this.driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  }

  /** Idempotent schema: per-brand-unique Identifier + Customer keys. Run once at startup. */
  async bootstrap(): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run(
        'CREATE CONSTRAINT identifier_key IF NOT EXISTS FOR (i:Identifier) REQUIRE (i.brand_id, i.type, i.hash) IS UNIQUE',
      );
      await session.run(
        'CREATE CONSTRAINT customer_key IF NOT EXISTS FOR (c:Customer) REQUIRE (c.brand_id, c.brain_id) IS UNIQUE',
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Resolve (and stitch) a brain_id for a set of hashed identifiers within one brand.
   * Idempotent: replaying the same identifiers yields the same brain_id.
   */
  async resolve(brandId: string, identifiers: readonly HashedIdentifier[]): Promise<ResolveResult> {
    if (identifiers.length === 0) return { brainId: null, outcome: 'skipped' };
    const idPairs = identifiers.map((i) => [i.type, i.hash]);
    const anchorHash = [...identifiers].map((i) => i.hash).sort()[0]!;
    const mintedBrainId = deterministicBrainId(brandId, anchorHash);

    const session = this.driver.session();
    try {
      return await session.executeWrite(async (tx) => {
        // 1. Ensure all identifier nodes exist (brand-scoped).
        await tx.run(
          `UNWIND $idPairs AS p
           MERGE (:Identifier {brand_id: $brand, type: p[0], hash: p[1]})`,
          { brand: brandId, idPairs },
        );

        // 2. Which Customers are already connected to any of these identifiers?
        const connected = await tx.run(
          `MATCH (i:Identifier {brand_id: $brand})-[:IDENTIFIES]->(c:Customer)
           WHERE [i.type, i.hash] IN $idPairs
           RETURN collect(DISTINCT c.brain_id) AS brainIds`,
          { brand: brandId, idPairs },
        );
        const brainIds: string[] = (connected.records[0]?.get('brainIds') ?? []).sort();

        if (brainIds.length === 0) {
          // MINT — new Customer, connect every identifier.
          await tx.run(
            `MERGE (c:Customer {brand_id: $brand, brain_id: $brainId})
             WITH c
             UNWIND $idPairs AS p
             MATCH (i:Identifier {brand_id: $brand, type: p[0], hash: p[1]})
             MERGE (i)-[:IDENTIFIES]->(c)`,
            { brand: brandId, brainId: mintedBrainId, idPairs },
          );
          return { brainId: mintedBrainId, outcome: 'minted' as const };
        }

        const canonical = brainIds[0]!; // deterministic canonical = min brain_id
        const absorbed = brainIds.slice(1);

        if (absorbed.length > 0) {
          // MERGE — repoint absorbed Customers' identifiers to canonical, then delete them.
          await tx.run(
            `MATCH (c:Customer {brand_id: $brand, brain_id: $canonical})
             UNWIND $absorbed AS oid
             MATCH (other:Customer {brand_id: $brand, brain_id: oid})
             OPTIONAL MATCH (i:Identifier)-[r:IDENTIFIES]->(other)
             MERGE (i)-[:IDENTIFIES]->(c)
             DELETE r
             WITH DISTINCT other, c
             SET c.merged_in = coalesce(c.merged_in, []) + other.brain_id
             DETACH DELETE other`,
            { brand: brandId, canonical, absorbed },
          );
        }

        // LINK — attach this event's identifiers to the canonical Customer (idempotent).
        await tx.run(
          `MATCH (c:Customer {brand_id: $brand, brain_id: $canonical})
           UNWIND $idPairs AS p
           MATCH (i:Identifier {brand_id: $brand, type: p[0], hash: p[1]})
           MERGE (i)-[:IDENTIFIES]->(c)`,
          { brand: brandId, canonical, idPairs },
        );

        return { brainId: canonical, outcome: absorbed.length > 0 ? ('merged' as const) : ('linked' as const) };
      });
    } finally {
      await session.close();
    }
  }

  /**
   * Delete an entire brand subgraph (every node carrying this brand_id). Used for test cleanup and
   * for brand offboarding / crypto-shred (per-brand isolation makes this a clean, total wipe).
   */
  async purgeBrand(brandId: string): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run('MATCH (n) WHERE n.brand_id = $b DETACH DELETE n', { b: brandId });
    } finally {
      await session.close();
    }
  }

  /** Liveness probe — resolves if Neo4j is reachable, throws otherwise. */
  async verifyConnectivity(): Promise<void> {
    await this.driver.getServerInfo();
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}
