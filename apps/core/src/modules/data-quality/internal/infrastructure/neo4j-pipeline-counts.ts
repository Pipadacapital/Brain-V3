/**
 * Neo4jPipelineCountsReader — the CHEAP, brand-agnostic identity-tier count port for the
 * medallion-journey observability read (get-medallion-journey.ts).
 *
 * WHY a dedicated reader (not IdentityReader): IdentityReader is tenant-scoped (every method carries a
 * brand_id — Neo4j has no RLS). The medallion journey wants PIPELINE-WIDE totals across all brands
 * (how many Customer nodes / Identifier nodes / identity edges exist at all), which is an ops/health
 * signal, not a tenant read. This reader issues exactly the 2 cheap counts that answer that:
 *   • MATCH (c:Customer) RETURN count(c)              — canonical brain_ids
 *   • MATCH (i:Identifier) RETURN count(i)            — identifiers
 *   • MATCH ()-[r:IDENTIFIES|ALIAS_OF]->() RETURN count(r) — identity edges (total)
 * (folded into one round-trip). count(*) over a label/relationship-type is a cheap graph count.
 *
 * FAIL-SOFT: the getMedallionJourney caller try/catches readCounts — a throw here (Neo4j down /
 * auth error) becomes reachable:false in the response, never a 500. Labels/relationships match the
 * Neo4j identity SoR (Neo4jIdentityRepository / Neo4jIdentityReader): Customer, Identifier, IDENTIFIES, ALIAS_OF.
 */
import neo4j, { type Driver } from 'neo4j-driver';
import type { Neo4jPipelineCounts } from '../application/queries/get-medallion-journey.js';

function toNum(v: unknown): number {
  if (v == null) return 0;
  if (neo4j.isInt(v)) return (v as neo4j.Integer).toNumber();
  return Number(v);
}

export class Neo4jPipelineCountsReader implements Neo4jPipelineCounts {
  private readonly driver: Driver;

  constructor(uri: string, user: string, password: string) {
    this.driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  }

  async readCounts(): Promise<{ brainIds: number; identifiers: number; edges: number }> {
    const s = this.driver.session({ defaultAccessMode: neo4j.session.READ });
    try {
      // One round-trip: three cheap label/relationship counts (no data scan).
      const res = await s.run(
        `CALL {
           MATCH (c:Customer) RETURN count(c) AS brainIds
         }
         CALL {
           MATCH (i:Identifier) RETURN count(i) AS identifiers
         }
         CALL {
           MATCH ()-[r:IDENTIFIES|ALIAS_OF]->() RETURN count(r) AS edges
         }
         RETURN brainIds, identifiers, edges`,
      );
      const rec = res.records[0];
      return {
        brainIds: toNum(rec?.get('brainIds') ?? 0),
        identifiers: toNum(rec?.get('identifiers') ?? 0),
        edges: toNum(rec?.get('edges') ?? 0),
      };
    } finally {
      await s.close();
    }
  }

  async end(): Promise<void> {
    await this.driver.close();
  }
}
