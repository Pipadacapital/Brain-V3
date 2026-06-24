/**
 * Neo4jIdentityReader — the read/admin surface over the Neo4j identity SoR (Epic 3 / ADR-0004).
 *
 * MEDALLION REALIGNMENT: the identity GRAPH (customers, identifier→brain_id edges, merge events,
 * aliases, merge-review queue) is the Neo4j system-of-record. This is the apps/core read/admin client
 * the identity surfaces use in place of the dropped PG identity tables + their SECURITY DEFINER
 * functions (customer_list_for_brand / resolve_merge_review / admin_unmerge_customer / erase_customer).
 *
 * HYBRID per ADR-0004: the immutable identity_audit ledger + the encrypted contact_pii vault stay in
 * PostgreSQL — erase hard-deletes contact_pii + writes the audit row in PG; the graph mutation
 * (tombstone edges, mark erased) is Neo4j. Per-brand isolation is application-layer (every Cypher
 * carries brand_id — Neo4j has no RLS). Timestamps are epoch-millis in the graph; returned as Date.
 */
import neo4j, { type Driver } from 'neo4j-driver';
import type { Pool } from 'pg';

function msToDate(v: unknown): Date | null {
  if (v == null) return null;
  const n = neo4j.isInt(v) ? (v as neo4j.Integer).toNumber() : Number(v);
  return Number.isFinite(n) ? new Date(n) : null;
}
function toNum(v: unknown): number {
  if (v == null) return 0;
  if (neo4j.isInt(v)) return (v as neo4j.Integer).toNumber();
  return Number(v);
}

export interface Customer360Row {
  customer: {
    brain_id: string; anonymous_id: string | null; merged_into: string | null;
    lifecycle_state: string; ai_processing_consent: boolean; resolution_consent: boolean; created_at: Date | null;
  } | null;
  identifiers: Array<{ identifier_type: string; tier: string; is_active: boolean; created_at: Date | null; identifier_hash_prefix: string }>;
  merges: Array<{ canonical_brain_id: string; merged_brain_id: string; confidence: string; rule_version: string; identifier_combo: string[]; committed_at: Date | null }>;
}

export interface CustomerListRow {
  brain_id: string; anonymous_id: string | null; lifecycle_state: string; merged_into: string | null;
  ai_processing_consent: boolean; resolution_consent: boolean; identifier_count: number;
  last_identifier_at: Date | null; created_at: Date | null;
}

export class Neo4jIdentityReader {
  private readonly driver: Driver;

  constructor(uri: string, user: string, password: string, private readonly pgPool: Pool) {
    this.driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  }

  /** Customer 360: the customer node + its identifier edges + merge-event history. */
  async getCustomer360(brandId: string, brainId: string): Promise<Customer360Row> {
    const s = this.driver.session({ defaultAccessMode: neo4j.session.READ });
    try {
      const cRes = await s.run(
        `MATCH (c:Customer {brand_id:$b, brain_id:$id})
         RETURN c.anonymous_id AS anonymous_id, c.merged_into AS merged_into, c.lifecycle_state AS lifecycle_state,
                coalesce(c.ai_processing_consent,false) AS ai, coalesce(c.resolution_consent,false) AS res, c.created_at AS created_at`,
        { b: brandId, id: brainId },
      );
      if (cRes.records.length === 0) return { customer: null, identifiers: [], merges: [] };
      const c = cRes.records[0]!;

      const idRes = await s.run(
        `MATCH (i:Identifier {brand_id:$b})-[r:IDENTIFIES]->(:Customer {brand_id:$b, brain_id:$id})
         RETURN i.type AS identifier_type, r.tier AS tier, r.is_active AS is_active, r.created_at AS created_at,
                left(i.hash, 12) AS prefix
         ORDER BY r.is_active DESC, i.type ASC, r.created_at ASC`,
        { b: brandId, id: brainId },
      );
      const mRes = await s.run(
        `MATCH (mev:MergeEvent {brand_id:$b})
         WHERE mev.canonical_brain_id = $id OR mev.merged_brain_id = $id
         RETURN mev.canonical_brain_id AS canonical, mev.merged_brain_id AS merged,
                coalesce(mev.confidence,'1.0') AS confidence, coalesce(mev.rule_version,'v1-deterministic') AS rule_version,
                mev.committed_at AS committed_at
         ORDER BY mev.committed_at DESC`,
        { b: brandId, id: brainId },
      );

      return {
        customer: {
          brain_id: brainId,
          anonymous_id: c.get('anonymous_id') ?? null,
          merged_into: c.get('merged_into') ?? null,
          lifecycle_state: c.get('lifecycle_state'),
          ai_processing_consent: c.get('ai') === true,
          resolution_consent: c.get('res') === true,
          created_at: msToDate(c.get('created_at')),
        },
        identifiers: idRes.records.map((r) => ({
          identifier_type: r.get('identifier_type'),
          tier: r.get('tier'),
          is_active: r.get('is_active') === true,
          created_at: msToDate(r.get('created_at')),
          identifier_hash_prefix: r.get('prefix') ?? '',
        })),
        merges: mRes.records.map((r) => ({
          canonical_brain_id: r.get('canonical'),
          merged_brain_id: r.get('merged'),
          confidence: String(r.get('confidence')),
          rule_version: String(r.get('rule_version')),
          identifier_combo: [],
          committed_at: msToDate(r.get('committed_at')),
        })),
      };
    } finally {
      await s.close();
    }
  }

  /** Customer browse: filter by lifecycle + optional identifier-hash search; paginated with total. */
  async listCustomers(
    brandId: string,
    opts: { lifecycle: string | null; identifierHashes: string[]; limit: number; offset: number },
  ): Promise<{ items: CustomerListRow[]; total: number }> {
    const s = this.driver.session({ defaultAccessMode: neo4j.session.READ });
    try {
      // Base match: customers for the brand, optional lifecycle filter, optional identifier-hash search.
      const lifeFilter = opts.lifecycle ? 'AND c.lifecycle_state = $lifecycle' : '';
      const searchMatch = opts.identifierHashes.length > 0
        ? `MATCH (si:Identifier {brand_id:$b})-[:IDENTIFIES]->(c)
           WHERE si.hash IN $hashes WITH DISTINCT c`
        : '';
      const base = `
        MATCH (c:Customer {brand_id:$b})
        WHERE 1=1 ${lifeFilter}
        ${searchMatch ? 'WITH c ' + searchMatch : ''}
      `;
      const params = { b: brandId, lifecycle: opts.lifecycle, hashes: opts.identifierHashes, limit: neo4j.int(opts.limit), offset: neo4j.int(opts.offset) };

      const totalRes = await s.run(`${base} RETURN count(c) AS total`, params);
      const total = toNum(totalRes.records[0]?.get('total') ?? 0);

      const rowsRes = await s.run(
        `${base}
         OPTIONAL MATCH (i:Identifier {brand_id:$b})-[r:IDENTIFIES]->(c) WHERE r.is_active = true
         WITH c, count(r) AS id_count, max(r.created_at) AS last_id_at
         RETURN c.brain_id AS brain_id, c.anonymous_id AS anonymous_id, c.lifecycle_state AS lifecycle_state,
                c.merged_into AS merged_into, coalesce(c.ai_processing_consent,false) AS ai,
                coalesce(c.resolution_consent,false) AS res, id_count, last_id_at, c.created_at AS created_at
         ORDER BY c.created_at DESC
         SKIP $offset LIMIT $limit`,
        params,
      );
      const items: CustomerListRow[] = rowsRes.records.map((r) => ({
        brain_id: r.get('brain_id'),
        anonymous_id: r.get('anonymous_id') ?? null,
        lifecycle_state: r.get('lifecycle_state'),
        merged_into: r.get('merged_into') ?? null,
        ai_processing_consent: r.get('ai') === true,
        resolution_consent: r.get('res') === true,
        identifier_count: toNum(r.get('id_count')),
        last_identifier_at: msToDate(r.get('last_id_at')),
        created_at: msToDate(r.get('created_at')),
      }));
      return { items, total };
    } finally {
      await s.close();
    }
  }

  /** Pending merge-review candidates for the brand. */
  async listMergeReviews(brandId: string): Promise<Array<{ review_id: string; brain_id_a: string; brain_id_b: string; trigger_reason: string; created_at: Date | null }>> {
    const s = this.driver.session({ defaultAccessMode: neo4j.session.READ });
    try {
      const r = await s.run(
        `MATCH (mr:MergeReview {brand_id:$b, status:'pending'})
         RETURN mr.review_id AS review_id, mr.brain_id_a AS a, mr.brain_id_b AS b,
                mr.trigger_reason AS reason, mr.created_at AS created_at
         ORDER BY mr.created_at ASC`,
        { b: brandId },
      );
      return r.records.map((x) => ({
        review_id: x.get('review_id'), brain_id_a: x.get('a'), brain_id_b: x.get('b'),
        trigger_reason: x.get('reason'), created_at: msToDate(x.get('created_at')),
      }));
    } finally {
      await s.close();
    }
  }

  /** Approve (merge b→a) or reject a pending review. */
  async resolveMergeReview(brandId: string, reviewId: string, decision: 'approve' | 'reject'): Promise<{ resolved: boolean; reason?: string }> {
    const s = this.driver.session();
    try {
      return await s.executeWrite(async (tx) => {
        const found = await tx.run(
          `MATCH (mr:MergeReview {brand_id:$b, review_id:$id, status:'pending'}) RETURN mr.brain_id_a AS a, mr.brain_id_b AS b`,
          { b: brandId, id: reviewId },
        );
        if (found.records.length === 0) return { resolved: false, reason: 'not_found' };
        if (decision === 'reject') {
          await tx.run(`MATCH (mr:MergeReview {brand_id:$b, review_id:$id}) SET mr.status='rejected'`, { b: brandId, id: reviewId });
          return { resolved: true };
        }
        const a = found.records[0]!.get('a');
        const bId = found.records[0]!.get('b');
        const now = Date.now();
        await tx.run(
          `MATCH (m:Customer {brand_id:$b, brain_id:$merged})
           SET m.lifecycle_state='merged', m.merged_into=$canonical
           WITH m MATCH (can:Customer {brand_id:$b, brain_id:$canonical})
           MERGE (m)-[al:ALIAS_OF]->(can) ON CREATE SET al.rule_version='v1-admin', al.valid_from=$now, al.valid_to=null
           WITH m MATCH (mr:MergeReview {brand_id:$b, review_id:$id}) SET mr.status='merged'`,
          { b: brandId, canonical: a, merged: bId, id: reviewId, now },
        );
        return { resolved: true };
      });
    } finally {
      await s.close();
    }
  }

  /** Split a previously-merged customer back out (reverses a merge). */
  async unmergeCustomer(brandId: string, mergedBrainId: string): Promise<{ unmerged: boolean; reason?: string; brain_id?: string }> {
    const s = this.driver.session();
    try {
      return await s.executeWrite(async (tx) => {
        const res = await tx.run(
          `MATCH (m:Customer {brand_id:$b, brain_id:$id}) WHERE m.merged_into IS NOT NULL
           OPTIONAL MATCH (m)-[a:ALIAS_OF]->() SET a.valid_to=$now
           SET m.lifecycle_state='split', m.merged_into=null
           RETURN m.brain_id AS id`,
          { b: brandId, id: mergedBrainId, now: Date.now() },
        );
        if (res.records.length === 0) return { unmerged: false, reason: 'not_found' };
        return { unmerged: true, brain_id: res.records[0]!.get('id') };
      });
    } finally {
      await s.close();
    }
  }

  /**
   * DPDP/GDPR erase: tombstone the customer's identifier edges + mark 'erased' (Neo4j), and hard-delete
   * the contact_pii vault rows + write the identity_audit row (PostgreSQL, ADR-0004). Counts only — no PII.
   */
  async eraseCustomer(brandId: string, brainId: string): Promise<{ erased: boolean; contact_pii_deleted: number; links_tombstoned: number }> {
    const s = this.driver.session();
    let linksTombstoned = 0;
    let existed = false;
    try {
      await s.executeWrite(async (tx) => {
        const res = await tx.run(
          `MATCH (c:Customer {brand_id:$b, brain_id:$id})
           OPTIONAL MATCH (i:Identifier {brand_id:$b})-[r:IDENTIFIES]->(c) WHERE r.is_active = true
           SET r.is_active = false
           WITH c, count(r) AS tombstoned
           SET c.lifecycle_state='erased'
           RETURN tombstoned`,
          { b: brandId, id: brainId },
        );
        if (res.records.length > 0) {
          existed = true;
          linksTombstoned = toNum(res.records[0]!.get('tombstoned'));
        }
      });
    } finally {
      await s.close();
    }
    if (!existed) return { erased: false, contact_pii_deleted: 0, links_tombstoned: 0 };

    // PG: hard-delete contact_pii + write the audit row (both stay PG per ADR-0004).
    const client = await this.pgPool.connect();
    let piiDeleted = 0;
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_brand_id', $1, true)", [brandId]);
      await client.query("SELECT set_config('app.role', 'send_service', true)");
      const del = await client.query('DELETE FROM contact_pii WHERE brand_id = $1 AND brain_id = $2', [brandId, brainId]);
      piiDeleted = del.rowCount ?? 0;
      await client.query(
        `INSERT INTO identity_audit (brand_id, brain_id, action, detail)
         VALUES ($1, $2, 'erase', $3::jsonb)`,
        [brandId, brainId, JSON.stringify({ links_tombstoned: linksTombstoned, contact_pii_deleted: piiDeleted, store: 'neo4j' })],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    return { erased: true, contact_pii_deleted: piiDeleted, links_tombstoned: linksTombstoned };
  }

  /** Total customer count for the brand (the vault-coverage denominator). */
  async customerCount(brandId: string): Promise<number> {
    const s = this.driver.session({ defaultAccessMode: neo4j.session.READ });
    try {
      const r = await s.run(`MATCH (c:Customer {brand_id:$b}) RETURN count(c) AS n`, { b: brandId });
      return toNum(r.records[0]?.get('n') ?? 0);
    } finally {
      await s.close();
    }
  }

  async end(): Promise<void> {
    await this.driver.close();
  }
}
