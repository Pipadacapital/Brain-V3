/**
 * Neo4jIdentityRepository — the identity graph SYSTEM-OF-RECORD on Neo4j (Epic 3 / ADR-0004).
 *
 * MEDALLION REALIGNMENT: identity STORAGE moves from PostgreSQL to Neo4j, where stitching is its
 * natural shape. Drop-in replacement for the PG IdentityRepository — SAME readState / writeOutcome
 * contract — so the pure IdentityResolver (phone-guard, cycle-guard, union-find merge) is UNCHANGED.
 *
 * HYBRID (per ADR-0004): the live identity GRAPH (customer, identity_link edges, merge events, aliases,
 * shared-utility phone-guard state, merge-review queue) lives in Neo4j; the IMMUTABLE COMPLIANCE LEDGER
 * identity_audit + the raw-PII vault contact_pii STAY in PostgreSQL (operational/legal records), and the
 * brand phone-guard config is read from the PG brand table. Crypto is unchanged: identifiers arrive
 * ALREADY hashed (per-brand salt) — NO raw PII reaches the graph; raw PII only ever goes to contact_pii.
 *
 * GRAPH MODEL (per-brand subgraph — brand_id on every node; isolation is app-layer, Neo4j has no RLS):
 *   (:Identifier {brand_id, type, hash}) -[:IDENTIFIES {tier, is_active, created_at}]-> (:Customer {brand_id, brain_id, lifecycle_state, merged_into, first_identified_at, created_at})
 *   (:Customer {merged}) -[:ALIAS_OF {merge_id, valid_from, valid_to}]-> (:Customer {canonical})
 *   (:MergeEvent {merge_id, brand_id, canonical_brain_id, merged_brain_id, ...})
 *   (:SharedUtility {brand_id, identifier_type, identifier_value, profile_count, suppressed_until, ...})  // phone-guard
 *   (:MergeReview {brand_id, review_id, brain_id_a, brain_id_b, trigger_reason, evidence, status})
 *
 * Timestamps are stored as epoch-millis numbers (graph-native, comparison-friendly).
 * Idempotent: MERGE on stable keys → replay-safe (3× replay → one node/edge).
 */
import neo4j, { type Driver } from 'neo4j-driver';
import { Pool } from 'pg';
import { encryptPii } from '@brain/identity-core';
import type { VaultKeyProvider } from '@brain/pii-vault';
import type {
  ExtractedIdentifier,
  ExistingLink,
  SharedUtilityState,
  BrandPhoneGuardConfig,
  ResolveOutcome,
} from '../../domain/identity/IdentityResolver.js';
import type { ConfidenceVerdict } from '@brain/contracts';
import type { IdentityReadState, ReviewQueueItem } from '../../domain/identity/IdentityStore.js';
import { RULE_VERSION } from '../../domain/identity/IdentityResolver.js';

const STRONG_TIERS = ['strong', 'strong_on_link'];

// ── Structured confidence / provenance stamped on every graph edge + merge node ──────────────
// Deterministic-first (D-5): the ONLY live matcher is the union-find resolver, so every committed
// IDENTIFIES / ALIAS_OF edge and MergeEvent node carries an EXACT verdict — a NUMERIC confidence
// (the integer 100, never a float, never blended with money), the matcher id, the coarse band, and
// the schema/rule version. Stamped additively (ON CREATE SET) so the writes stay idempotent and
// non-breaking: pre-existing edges/nodes are untouched on replay, new ones gain the provenance.
const DETERMINISTIC_MATCHER_ID = 'deterministic-union-find';
const DETERMINISTIC_CONFIDENCE_SCORE = 100; // integer 0-100 (graph-native number), band 'exact'
const DETERMINISTIC_CONFIDENCE_BAND = 'exact';
const IDENTITY_SCHEMA_VERSION = '1'; // doc-07 envelope schema_version (graph-side mirror)

// ── F2: ALIAS-RESOLUTION — chase the live merged_into chain to the CANONICAL brain_id ─────────────
// A merge tombstones the merged Customer (lifecycle='merged', merged_into=<canonical>) and links it
// (m)-[:ALIAS_OF {valid_to:null}]->(canonical). The merged node's IDENTIFIES edges are NOT re-pointed,
// so an identifier that still IDENTIFIES the merged node must resolve THROUGH the alias chain to the
// canonical — otherwise a post-merge identifier (and its orders/LTV) resolves to the DEAD brain_id and
// the merge is defeated. This OPTIONAL-MATCH fragment (parameterised on a bound `c:Customer`) follows
// the LIVE (valid_to IS NULL) ALIAS_OF chain to its terminal canonical node:
//   - multi-hop: variable-length `*1..50` walks A→B→C; Neo4j never traverses a relationship twice in
//     one path, so an accidental cycle cannot infinite-loop, and 50 caps practical merge depth (the
//     bounded cycle guard).
//   - live-only: `all(rel ... valid_to IS NULL)` ignores stale (un-merged) alias edges.
//   - terminal: the canon node itself has NO live outgoing ALIAS_OF (it is the survivor).
// `coalesce(canon.brain_id, c.brain_id)` then yields the canonical brain_id for a merged node, or the
// node's own brain_id when it is already canonical (no path matched). Bind the alias var `c` first.
const CANONICAL_OF_C = `
        OPTIONAL MATCH _cano = (c)-[:ALIAS_OF*1..50]->(canon:Customer)
        WHERE all(rel IN relationships(_cano) WHERE rel.valid_to IS NULL)
          AND NOT EXISTS { MATCH (canon)-[ra:ALIAS_OF]->() WHERE ra.valid_to IS NULL }`;
const CANONICAL_BRAIN_ID = 'coalesce(canon.brain_id, c.brain_id)';

export class Neo4jIdentityRepository {
  private readonly driver: Driver;
  private readonly pgPool: Pool;

  /**
   * @param neo4jUri/User/Password  Neo4j Bolt connection (the identity graph SoR).
   * @param pgConnectionString      brain_app DSN — for brandConfig (brand table) + identity_audit +
   *                                contact_pii (the two records that stay PG per ADR-0004).
   * @param keyProvider             per-brand DEK provider for contact_pii encryption (best-effort).
   */
  constructor(
    neo4jUri: string,
    neo4jUser: string,
    neo4jPassword: string,
    pgConnectionString: string,
    private readonly keyProvider?: VaultKeyProvider,
  ) {
    this.driver = neo4j.driver(neo4jUri, neo4j.auth.basic(neo4jUser, neo4jPassword));
    this.pgPool = new Pool({
      connectionString: pgConnectionString,
      max: 5,
      idleTimeoutMillis: 30_000,
      statement_timeout: 15_000,
    });
  }

  /** Idempotent schema: per-brand-unique Identifier + Customer keys. Run once at startup. */
  async bootstrap(): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run(
        'CREATE CONSTRAINT identity_identifier_key IF NOT EXISTS FOR (i:Identifier) REQUIRE (i.brand_id, i.type, i.hash) IS UNIQUE',
      );
      await session.run(
        'CREATE CONSTRAINT identity_customer_key IF NOT EXISTS FOR (c:Customer) REQUIRE (c.brand_id, c.brain_id) IS UNIQUE',
      );
      await session.run(
        'CREATE CONSTRAINT identity_mergeevent_key IF NOT EXISTS FOR (m:MergeEvent) REQUIRE m.merge_id IS UNIQUE',
      );
      await session.run(
        'CREATE CONSTRAINT identity_sharedutil_key IF NOT EXISTS FOR (s:SharedUtility) REQUIRE (s.brand_id, s.identifier_type, s.identifier_value) IS UNIQUE',
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Read pre-resolution state for a brand + set of identifier hashes (mirrors the PG repo exactly):
   * existing links, phone-guard state, alias chain — from the GRAPH; brand config — from PG.
   */
  async readState(
    brandId: string,
    identifierHashes: Array<{ type: string; hash: string }>,
    now: Date = new Date(),
  ): Promise<IdentityReadState> {
    // Brand phone-guard config — PG (brand table is operational state, stays PG). The brand table is
    // RLS-FORCED → set the brand GUC in-txn before the read (mirrors the PG repo).
    const brandConfig = await this.readBrandConfig(brandId);

    const session = this.driver.session({ defaultAccessMode: neo4j.session.READ });
    try {
      const existingLinks: ExistingLink[] = [];
      if (identifierHashes.length > 0) {
        const pairs = identifierHashes.map((i) => [i.type, i.hash]);
        // F2 ALIAS-RESOLVE: return the CANONICAL brain_id (follow the live ALIAS_OF chain), so a
        // post-merge identifier resolves to the survivor — a subsequent event then LINKS to the
        // canonical node, not the dead alias (and the resolver never re-merges an already-merged pair).
        const res = await session.run(
          `MATCH (i:Identifier {brand_id:$brand})-[r:IDENTIFIES]->(c:Customer)
           WHERE r.is_active = true AND [i.type, i.hash] IN $pairs${CANONICAL_OF_C}
           RETURN ${CANONICAL_BRAIN_ID} AS brain_id, i.type AS identifier_type, i.hash AS identifier_value, r.is_active AS is_active`,
          { brand: brandId, pairs },
        );
        for (const rec of res.records) {
          existingLinks.push({
            brain_id: rec.get('brain_id'),
            identifier_type: rec.get('identifier_type'),
            identifier_value: rec.get('identifier_value'),
            is_active: rec.get('is_active'),
          });
        }
      }

      const phoneHashes = identifierHashes.filter((i) => i.type === 'phone').map((i) => i.hash);
      const sharedUtilityMap = new Map<string, SharedUtilityState>();
      const phoneCount = new Map<string, number>();

      if (phoneHashes.length > 0) {
        const suiRes = await session.run(
          `MATCH (s:SharedUtility {brand_id:$brand, identifier_type:'phone'})
           WHERE s.identifier_value IN $hashes
           RETURN s.identifier_type AS identifier_type, s.identifier_value AS identifier_value,
                  s.profile_count AS profile_count, s.suppressed_until AS suppressed_until`,
          { brand: brandId, hashes: phoneHashes },
        );
        for (const rec of suiRes.records) {
          const su = rec.get('suppressed_until');
          sharedUtilityMap.set(rec.get('identifier_value'), {
            identifier_type: rec.get('identifier_type'),
            identifier_value: rec.get('identifier_value'),
            profile_count: toNum(rec.get('profile_count')),
            suppressed_until: su == null ? null : new Date(toNum(su)),
          });
        }

        // Windowed distinct brain_id count per phone hash (last suppression_window_days days).
        const cutoffMs = now.getTime() - brandConfig.suppression_window_days * 86_400_000;
        for (const hash of phoneHashes) {
          const cRes = await session.run(
            `MATCH (i:Identifier {brand_id:$brand, type:'phone', hash:$hash})-[r:IDENTIFIES]->(c:Customer)
             WHERE r.is_active = true AND r.created_at > $cutoff
             RETURN count(DISTINCT c.brain_id) AS cnt`,
            { brand: brandId, hash, cutoff: cutoffMs },
          );
          phoneCount.set(hash, toNum(cRes.records[0]?.get('cnt') ?? 0));
        }
      }

      // Alias chain: all live (valid_to IS NULL) observed brain_ids (cycle detection).
      const aliasRes = await session.run(
        `MATCH (o:Customer {brand_id:$brand})-[a:ALIAS_OF]->(:Customer)
         WHERE a.valid_to IS NULL
         RETURN DISTINCT o.brain_id AS observed`,
        { brand: brandId },
      );
      const aliasChain = new Set(aliasRes.records.map((r) => r.get('observed') as string));

      return { existingLinks, sharedUtilityMap, phoneCount, aliasChain, brandConfig };
    } finally {
      await session.close();
    }
  }

  /**
   * Fetch candidate customers that share any of the event's WEAK-signal hashes — the active
   * tier='weak' IDENTIFIES edges (device_fingerprint / cookie_id / session_id / ip). These edges
   * carry NO merge authority (weak is never in STRONG_TIERS); they exist SOLELY to feed the
   * review-gated ProbabilisticMatcher, which can at most ROUTE TO REVIEW. brand_id-first, hash-only.
   */
  async findCandidatesByWeakSignals(
    brandId: string,
    weakHashes: Array<{ type: string; hash: string }>,
  ): Promise<ExistingLink[]> {
    if (weakHashes.length === 0) return [];
    const session = this.driver.session({ defaultAccessMode: neo4j.session.READ });
    try {
      const pairs = weakHashes.map((i) => [i.type, i.hash]);
      const res = await session.run(
        `MATCH (i:Identifier {brand_id:$brand})-[r:IDENTIFIES]->(c:Customer)
         WHERE r.is_active = true AND r.tier = 'weak' AND [i.type, i.hash] IN $pairs
         RETURN c.brain_id AS brain_id, i.type AS identifier_type, i.hash AS identifier_value, r.is_active AS is_active`,
        { brand: brandId, pairs },
      );
      return res.records.map((rec) => ({
        brain_id: rec.get('brain_id'),
        identifier_type: rec.get('identifier_type'),
        identifier_value: rec.get('identifier_value'),
        is_active: rec.get('is_active'),
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * Enqueue a probabilistic weak-signal pair to the human review queue (a MergeReview node), the
   * graph-side review surface. Idempotent on the deterministic review_id (MERGE key) → a replay
   * re-enqueues nothing. status='pending' + source flags it as a probabilistic (never-auto-merge)
   * review, distinct from the deterministic cycle-guard reviews. brand_id-first, hash-only evidence.
   */
  async enqueueReview(brandId: string, item: ReviewQueueItem): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run(
        `MERGE (mr:MergeReview {brand_id:$brand, review_id:$reviewId})
         ON CREATE SET mr.brain_id_a=$a, mr.brain_id_b=$b, mr.trigger_reason=$reason,
                       mr.evidence=$evidence, mr.status='pending', mr.created_at=$nowMs,
                       mr.source='probabilistic-fellegi-sunter'`,
        {
          brand: brandId,
          reviewId: item.review_id,
          a: item.brain_id_a,
          b: item.brain_id_b,
          reason: item.reason,
          evidence: JSON.stringify(item.evidence),
          nowMs: Date.now(),
        },
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Write the resolution outcome. The identity GRAPH (customer / links / merge / alias / phone-guard /
   * review) is one Neo4j write transaction; identity_audit + contact_pii are written to PG (ADR-0004).
   * Idempotent: MERGE on stable keys; deterministic ids → replay-safe.
   */
  async writeOutcome(
    brandId: string,
    outcome: ResolveOutcome,
    identifiers: ExtractedIdentifier[],
    verdict?: ConfidenceVerdict,
  ): Promise<{ written: boolean }> {
    const nowMs = Date.now();
    // The structured confidence/provenance to stamp on the committed edges/nodes. DETERMINISTIC
    // outcomes only ever reach here (a probabilistic verdict routes to review, never commits) — so
    // `verdict` is the deterministic grade (exact for strong/merge, sub-exact 'medium' for a
    // cross-device adoption). Falls back to the deterministic exact constants for back-compat callers.
    const confScore = verdict?.score ?? DETERMINISTIC_CONFIDENCE_SCORE;
    const confBand = verdict?.band ?? DETERMINISTIC_CONFIDENCE_BAND;
    const matcherIdStamp = verdict?.matcher_id ?? DETERMINISTIC_MATCHER_ID;
    const ruleVersionStamp = verdict?.rule_version ?? RULE_VERSION;
    const session = this.driver.session();
    try {
      await session.executeWrite(async (tx) => {
        // ── customer node ──
        await tx.run(
          `MERGE (c:Customer {brand_id:$brand, brain_id:$brainId})
           ON CREATE SET c.lifecycle_state='active', c.created_at=$nowMs,
                         c.ai_processing_consent=false, c.resolution_consent=false, c.anonymous_id=null`,
          { brand: brandId, brainId: outcome.brainId, nowMs },
        );

        // ── identity_link edges (new identifiers) ──
        for (const id of outcome.newLinks) {
          await tx.run(
            // Structured confidence/provenance is stamped ON CREATE only (additive, idempotent,
            // non-breaking): a replayed link keeps its original stamp; ON MATCH only re-activates.
            `MERGE (i:Identifier {brand_id:$brand, type:$t, hash:$h})
             WITH i
             MATCH (c:Customer {brand_id:$brand, brain_id:$brainId})
             MERGE (i)-[r:IDENTIFIES]->(c)
             ON CREATE SET r.tier=$tier, r.is_active=true, r.created_at=$nowMs,
                           r.confidence_score=$confScore, r.confidence_band=$confBand,
                           r.matcher_id=$matcherId, r.rule_version=$ruleVersion,
                           r.schema_version=$schemaVersion
             ON MATCH SET r.is_active=true`,
            {
              brand: brandId, brainId: outcome.brainId, t: id.type, h: id.hash, tier: id.tier, nowMs,
              confScore, confBand,
              matcherId: matcherIdStamp, ruleVersion: ruleVersionStamp,
              schemaVersion: IDENTITY_SCHEMA_VERSION,
            },
          );
        }

        // ── H6: first_identified_at — set once when a strong/durable identifier first attaches ──
        await tx.run(
          `MATCH (c:Customer {brand_id:$brand, brain_id:$brainId})
           WHERE c.first_identified_at IS NULL
             AND EXISTS {
               MATCH (:Identifier)-[r:IDENTIFIES]->(c)
               WHERE r.is_active = true AND r.tier IN $strong
             }
           SET c.first_identified_at = $nowMs`,
          { brand: brandId, brainId: outcome.brainId, strong: STRONG_TIERS, nowMs },
        );

        // ── merge: merged customer + MergeEvent + ALIAS_OF + first_identified_at inheritance ──
        if (outcome.action === 'merged' && outcome.merge) {
          const { canonicalBrainId, mergedBrainId, mergeId } = outcome.merge;
          await tx.run(
            // The MergeEvent node + the ALIAS_OF edge both carry the structured deterministic verdict
            // (numeric confidence + matcher + band + rule/schema version). Stamped ON CREATE only —
            // idempotent on replay (MERGE keys: merge_id / the alias pair), non-breaking, tenant-scoped.
            `MERGE (m:Customer {brand_id:$brand, brain_id:$merged})
             SET m.lifecycle_state='merged', m.merged_into=$canonical
             MERGE (mev:MergeEvent {merge_id:$mergeId})
               ON CREATE SET mev.brand_id=$brand, mev.canonical_brain_id=$canonical,
                             mev.merged_brain_id=$merged, mev.rule_version=$ruleVersion, mev.committed_at=$nowMs,
                             mev.confidence_score=$confScore, mev.confidence_band=$confBand,
                             mev.matcher_id=$matcherId, mev.schema_version=$schemaVersion
             WITH m
             MATCH (can:Customer {brand_id:$brand, brain_id:$canonical})
             MERGE (m)-[a:ALIAS_OF]->(can)
               ON CREATE SET a.merge_id=$mergeId, a.rule_version=$ruleVersion, a.valid_from=$nowMs, a.valid_to=null,
                             a.confidence_score=$confScore, a.confidence_band=$confBand,
                             a.matcher_id=$matcherId, a.schema_version=$schemaVersion`,
            {
              brand: brandId, canonical: canonicalBrainId, merged: mergedBrainId, mergeId, nowMs,
              confScore, confBand,
              matcherId: matcherIdStamp, ruleVersion: ruleVersionStamp,
              schemaVersion: IDENTITY_SCHEMA_VERSION,
            },
          );
          // Canonical inherits the EARLIEST identification across the merge.
          await tx.run(
            `MATCH (c:Customer {brand_id:$brand, brain_id:$canonical}), (m:Customer {brand_id:$brand, brain_id:$merged})
             WHERE m.first_identified_at IS NOT NULL
               AND (c.first_identified_at IS NULL OR m.first_identified_at < c.first_identified_at)
             SET c.first_identified_at = m.first_identified_at`,
            { brand: brandId, canonical: canonicalBrainId, merged: mergedBrainId },
          );
        }

        // ── phone-guard: SharedUtility upserts (keep the GREATEST profile_count) ──
        for (const update of outcome.phoneGuardUpdates) {
          if (!update.suppress) continue;
          await tx.run(
            `MERGE (s:SharedUtility {brand_id:$brand, identifier_type:$type, identifier_value:$value})
             SET s.profile_count = CASE WHEN s.profile_count IS NULL OR $pc > s.profile_count THEN $pc ELSE s.profile_count END,
                 s.suppressed_until = $suppressedUntil, s.flagged_at = $nowMs,
                 s.window_days = 30, s.reason = 'phone_guard_threshold_exceeded'`,
            {
              brand: brandId, type: update.identifier_type, value: update.identifier_value,
              pc: update.profile_count,
              suppressedUntil: update.suppressed_until ? update.suppressed_until.getTime() : null,
              nowMs,
            },
          );
        }

        // ── merge_review_queue (cycle-guard or suppressed-phone conflict) ──
        if (outcome.routeToReview && outcome.reviewReason) {
          await tx.run(
            `CREATE (:MergeReview {
               brand_id:$brand, review_id:randomUUID(), brain_id_a:$brainId, brain_id_b:$brainId,
               trigger_reason:$reason, evidence:$evidence, status:'pending', created_at:$nowMs })`,
            {
              brand: brandId, brainId: outcome.brainId, reason: outcome.reviewReason,
              evidence: JSON.stringify({ reason: outcome.reviewReason, rule_version: 'v1-deterministic' }),
              nowMs,
            },
          );
        }
      });

      // ── identity_audit + contact_pii → PostgreSQL (ADR-0004: these stay in PG) ──
      await this.writePgAuditAndPii(brandId, outcome, identifiers);

      return { written: true };
    } finally {
      await session.close();
    }
  }

  /** Brand phone-guard config from PG (RLS-forced → set the brand GUC in-txn before the read). */
  private async readBrandConfig(brandId: string): Promise<BrandPhoneGuardConfig> {
    const client = await this.pgPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_brand_id', $1, true)", [brandId]);
      const rows = await client.query<{ phone_guard_threshold: number; suppression_window_days: number }>(
        'SELECT phone_guard_threshold, suppression_window_days FROM brand WHERE id = $1',
        [brandId],
      );
      await client.query('COMMIT');
      return rows.rows[0] ?? { phone_guard_threshold: 10, suppression_window_days: 30 };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** The two records that stay in PG: the immutable audit ledger + the encrypted raw-PII vault. */
  private async writePgAuditAndPii(
    brandId: string,
    outcome: ResolveOutcome,
    identifiers: ExtractedIdentifier[],
  ): Promise<void> {
    const client = await this.pgPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_brand_id', $1, true)", [brandId]);

      await client.query(
        `INSERT INTO identity_audit (brand_id, brain_id, action, merge_id, detail)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
          brandId,
          outcome.brainId,
          outcome.action === 'minted' ? 'mint'
            : outcome.action === 'linked' ? 'link'
            : outcome.action === 'merged' ? 'merge'
            : 'link',
          outcome.merge?.mergeId ?? null,
          JSON.stringify({
            rule_version: 'v1-deterministic',
            identifier_types: identifiers.map((i) => i.type),
            action: outcome.action,
            store: 'neo4j', // the graph is the SoR; this PG row is the immutable audit trail
          }),
        ],
      );

      if (outcome.contactPiiWrites.length > 0 && this.keyProvider) {
        const key = await this.keyProvider.getDek(brandId).catch(() => null);
        if (key) {
          await client.query("SELECT set_config('app.role', 'send_service', true)");
          for (const pii of outcome.contactPiiWrites) {
            const env = encryptPii(key.dek, pii.raw_value);
            await client.query(
              `INSERT INTO contact_pii
                 (brand_id, brain_id, pii_type, identifier_hash,
                  pii_ciphertext, pii_iv, pii_auth_tag, key_version, pii_value)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL)
               ON CONFLICT (brand_id, brain_id, pii_type) DO NOTHING`,
              [brandId, pii.brain_id, pii.pii_type, pii.identifier_hash, env.ciphertext, env.iv, env.authTag, key.keyVersion],
            );
          }
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Delete an entire brand subgraph (test cleanup / brand offboarding / crypto-shred). */
  async purgeBrand(brandId: string): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run('MATCH (n) WHERE n.brand_id = $b DETACH DELETE n', { b: brandId });
    } finally {
      await session.close();
    }
  }

  async end(): Promise<void> {
    await this.driver.close();
    await this.pgPool.end();
  }
}

/** neo4j-driver returns Integer for numeric values; coerce to a JS number safely. */
function toNum(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (neo4j.isInt(v)) return (v as neo4j.Integer).toNumber();
  return Number(v);
}
