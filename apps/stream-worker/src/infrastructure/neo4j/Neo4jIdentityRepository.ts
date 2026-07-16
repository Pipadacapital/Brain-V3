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
  IdentityPriorityConfig,
  IdentityPriorityClass,
} from '../../domain/identity/IdentityResolver.js';
import type { ConfidenceVerdict } from '@brain/contracts';
import type {
  IdentityReadState,
  IdentityBatchReadState,
  BatchOutcomeItem,
  ReviewQueueItem,
} from '../../domain/identity/IdentityStore.js';
import { RULE_VERSION, DEFAULT_IDENTITY_PRIORITY } from '../../domain/identity/IdentityResolver.js';

/** The identity-priority classes that may appear in a stored order (validated on read). */
const KNOWN_PRIORITY_CLASSES: ReadonlySet<string> = new Set<string>(DEFAULT_IDENTITY_PRIORITY);

/**
 * All-zero UUID — the fail-closed sentinel for the workspace/user GUCs on this SYSTEM (brand-scoped)
 * write path. These identity txns only ever scope by brand, but tables like `brand` carry a SECOND
 * permissive RLS policy (`brand_self_read`) whose predicate casts `app.current_user_id::uuid`.
 * Postgres evaluates EVERY permissive policy, so on a pgbouncer connection whose session GUCs were
 * RESET to '' at checkout, that unset user GUC cast `''::uuid` → 22P02 (`invalid input syntax for
 * type uuid: ""`) — crashing the identity-bridge consumer and wedging the partition in a rebalance
 * loop, EVEN THOUGH app.current_brand_id was set correctly. Defaulting workspace + user to NIL_UUID
 * (a valid, matches-nothing uuid) keeps every policy's cast legal; brand_isolation still governs
 * access. Mirrors @brain/db buildContextGucSql / the metric-engine withBrandTxn fix.
 */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Set the RLS GUC context for a SYSTEM brand-scoped identity txn: the real brand id, plus
 * workspace/user pinned to NIL_UUID so no other permissive policy casts an empty GUC (see NIL_UUID).
 * txn-local (set_config is_local=true) — resets on COMMIT/ROLLBACK, cannot leak across pool conns.
 */
async function setBrandRlsContext(
  client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  brandId: string,
): Promise<void> {
  await client.query(
    `SELECT set_config('app.current_brand_id', $1, true),
            set_config('app.current_workspace_id', $2, true),
            set_config('app.current_user_id', $2, true)`,
    [brandId, NIL_UUID],
  );
}

const STRONG_TIERS = ['strong', 'strong_on_link'];
// SPEC: A.2.3.4 — the identity_link identifier_TYPES that carry strong (person-defining) authority. A
// brain owning any active edge of these types is "strong-owned"; the resolver's shared-device guard uses
// that to refuse folding a NEW strong id into it via a shared medium (anon/device) signal.
const STRONG_LINK_TYPES = ['email', 'phone', 'storefront_customer_id', 'pre_hashed_email', 'pre_hashed_phone'];

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

/**
 * Every node label the identity graph writes (AUD-IMPL-028). purgeBrand deletes per-label so each
 * MATCH is label-scoped (index/label-scan backed) instead of an AllNodesScan. Keep this list in
 * sync with every `CREATE (:X …)` / `MERGE (:X …)` in the graph writers (this repo + core's
 * neo4j-identity-reader unmerge path); the purge's final label-less sweep still catches drift.
 */
export const IDENTITY_GRAPH_LABELS = [
  'Identifier',
  'Customer',
  'MergeEvent',
  'MergeReview',
  'SharedUtility',
  'UnmergeEvent',
] as const;

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

  /** Idempotent schema: per-brand-unique Identifier + Customer keys + hot-lookup indexes. Run once at startup. */
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
      // Hot-lookup indexes (AUD-PERF-017) — without these every 5-min identity-export incremental cycle
      // scans ALL :IDENTIFIES edges (its watermark filters on r.created_at / r.is_active — relationship
      // properties the uniqueness constraints above cannot serve), and the core reader label-scans
      // MergeEvent / MergeReview by brand-scoped properties. All additive + idempotent.
      await session.run(
        'CREATE INDEX identity_identifies_created_at IF NOT EXISTS FOR ()-[r:IDENTIFIES]-() ON (r.created_at)',
      );
      await session.run(
        'CREATE INDEX identity_identifies_is_active IF NOT EXISTS FOR ()-[r:IDENTIFIES]-() ON (r.is_active)',
      );
      await session.run(
        'CREATE INDEX identity_mergeevent_brand_canonical IF NOT EXISTS FOR (m:MergeEvent) ON (m.brand_id, m.canonical_brain_id)',
      );
      await session.run(
        'CREATE INDEX identity_mergeevent_brand_merged IF NOT EXISTS FOR (m:MergeEvent) ON (m.brand_id, m.merged_brain_id)',
      );
      await session.run(
        'CREATE INDEX identity_mergereview_brand_status IF NOT EXISTS FOR (mr:MergeReview) ON (mr.brand_id, mr.status)',
      );
      await session.run(
        'CREATE INDEX identity_customer_lifecycle IF NOT EXISTS FOR (c:Customer) ON (c.lifecycle_state)',
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

      // SPEC: A.2.3.4 — of the brains those identifiers resolve to, which ALREADY own an active STRONG
      // identifier. The resolver's shared-device guard consults this to refuse pulling a NEW strong id
      // into a brain owned by a DIFFERENT strong identity via a shared medium (anon/device) bridge — the
      // shared_device_family merge. Scoped to the (small) resolved-brain set, so it is cheap per event.
      const strongOwnedBrainIds = new Set<string>();
      const candidateBrains = [...new Set(existingLinks.map((l) => l.brain_id))];
      if (candidateBrains.length > 0) {
        const ownRes = await session.run(
          `MATCH (c:Customer {brand_id:$brand}) WHERE c.brain_id IN $brains
           MATCH (si:Identifier {brand_id:$brand})-[sr:IDENTIFIES]->(c)
           WHERE sr.is_active = true AND si.type IN $strongTypes
           RETURN DISTINCT c.brain_id AS brain_id`,
          { brand: brandId, brains: candidateBrains, strongTypes: STRONG_LINK_TYPES },
        );
        for (const rec of ownRes.records) strongOwnedBrainIds.add(rec.get('brain_id') as string);
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

      return { existingLinks, sharedUtilityMap, phoneCount, aliasChain, brandConfig, strongOwnedBrainIds };
    } finally {
      await session.close();
    }
  }

  /**
   * BATCH BACKFILL (GAP-A batched path) — readState over the UNION of a whole batch's identifier
   * hashes in ONE read session (one brandConfig PG txn + 5 graph queries per BATCH instead of per
   * EVENT). Reproduces readState's five sub-reads with the SAME Cypher shapes:
   *   1. existing links (alias-RESOLVED via the live ALIAS_OF chain) — the per-event query already
   *      takes a $pairs list, so the union IS the same query;
   *   2. strong-owned brains over the resolved-brain candidates;
   *   3. shared-utility phone-guard rows for every phone hash;
   *   4. the windowed distinct-brain phone counts — batched into ONE query (collect(DISTINCT ...)
   *      per hash instead of one count query per hash), returning the raw brain SETS the batch
   *      overlay needs (phoneBrainIdsInWindow; phoneCount[h] = set size by construction);
   *   5. the live alias chain (brand-wide, identical query).
   * Superset-safe by the resolver's (type, hash)-scoped matching — see IdentityStore contract.
   */
  async readStateBatch(
    brandId: string,
    identifierHashes: Array<{ type: string; hash: string }>,
    now: Date = new Date(),
  ): Promise<IdentityBatchReadState> {
    const brandConfig = await this.readBrandConfig(brandId);

    const session = this.driver.session({ defaultAccessMode: neo4j.session.READ });
    try {
      // ── 1. existing links (alias-resolved) — same Cypher as readState over the union pairs ──
      const existingLinks: ExistingLink[] = [];
      if (identifierHashes.length > 0) {
        const pairs = identifierHashes.map((i) => [i.type, i.hash]);
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

      // ── 2. strong-owned brains (SPEC A.2.3.4) — same query over the union's resolved brains ──
      const strongOwnedBrainIds = new Set<string>();
      const candidateBrains = [...new Set(existingLinks.map((l) => l.brain_id))];
      if (candidateBrains.length > 0) {
        const ownRes = await session.run(
          `MATCH (c:Customer {brand_id:$brand}) WHERE c.brain_id IN $brains
           MATCH (si:Identifier {brand_id:$brand})-[sr:IDENTIFIES]->(c)
           WHERE sr.is_active = true AND si.type IN $strongTypes
           RETURN DISTINCT c.brain_id AS brain_id`,
          { brand: brandId, brains: candidateBrains, strongTypes: STRONG_LINK_TYPES },
        );
        for (const rec of ownRes.records) strongOwnedBrainIds.add(rec.get('brain_id') as string);
      }

      const phoneHashes = identifierHashes.filter((i) => i.type === 'phone').map((i) => i.hash);
      const sharedUtilityMap = new Map<string, SharedUtilityState>();
      const phoneCount = new Map<string, number>();
      const phoneBrainIdsInWindow = new Map<string, Set<string>>();

      if (phoneHashes.length > 0) {
        // ── 3. shared-utility phone-guard rows — same query, all phone hashes at once ──
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

        // ── 4. windowed distinct-brain phone counts — ONE query for every hash; the raw brain SETS
        // are returned so the overlay can advance the count exactly like a per-event re-read (the
        // per-event count query is the same MATCH with count(DISTINCT c.brain_id) per single hash;
        // NO alias resolution — raw edge targets, deliberately identical).
        const cutoffMs = now.getTime() - brandConfig.suppression_window_days * 86_400_000;
        const cntRes = await session.run(
          `MATCH (i:Identifier {brand_id:$brand, type:'phone'})-[r:IDENTIFIES]->(c:Customer)
           WHERE i.hash IN $hashes AND r.is_active = true AND r.created_at > $cutoff
           RETURN i.hash AS hash, collect(DISTINCT c.brain_id) AS brains`,
          { brand: brandId, hashes: phoneHashes, cutoff: cutoffMs },
        );
        for (const rec of cntRes.records) {
          const brains = new Set((rec.get('brains') as string[]) ?? []);
          phoneBrainIdsInWindow.set(rec.get('hash') as string, brains);
          phoneCount.set(rec.get('hash') as string, brains.size);
        }
        // Hashes with no in-window edges: 0 / empty set (per-event readState also writes the 0).
        for (const hash of phoneHashes) {
          if (!phoneCount.has(hash)) {
            phoneCount.set(hash, 0);
            phoneBrainIdsInWindow.set(hash, new Set());
          }
        }
      }

      // ── 5. alias chain — identical brand-wide query ──
      const aliasRes = await session.run(
        `MATCH (o:Customer {brand_id:$brand})-[a:ALIAS_OF]->(:Customer)
         WHERE a.valid_to IS NULL
         RETURN DISTINCT o.brain_id AS observed`,
        { brand: brandId },
      );
      const aliasChain = new Set(aliasRes.records.map((r) => r.get('observed') as string));

      return {
        existingLinks,
        sharedUtilityMap,
        phoneCount,
        aliasChain,
        brandConfig,
        strongOwnedBrainIds,
        phoneBrainIdsInWindow,
      };
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

  /**
   * BATCH BACKFILL (GAP-A batched path) — apply a batch's resolve outcomes IN ORDER in ONE Neo4j
   * write transaction (+ ONE PG txn for the audit/contact_pii records), observably equivalent to
   * calling writeOutcome(item) sequentially (timestamps excepted: one batch clock).
   *
   * The per-event statements are UNWIND-bulked phase by phase, in the SAME statement order a
   * per-event sequence produces (customers → links → first_identified_at → merges → phone-guard →
   * reviews). Phase-grouping is safe because outcomes carry FULLY-RESOLVED brain_ids (no write
   * re-reads state to decide targets) and the only state-conditional writes are timestamp-shaped:
   *   • H6 first_identified_at is a set-once conditional on "has an active strong edge" — running it
   *     once per brain AFTER all the batch's links yields the same final value (the batch clock)
   *     that per-event interleaving yields, because every candidate timestamp in the batch IS the
   *     batch clock.
   *   • merge fia-inheritance compares fia values that, within the batch, all equal the batch clock
   *     (pre-existing older values behave identically in both orders). Merges are executed as a
   *     per-item loop (NOT one UNWIND) so a chained merge (A→B then B→C) inherits strictly in event
   *     order without relying on intra-statement write visibility. Merges are rare; links dominate.
   *   • SharedUtility folds are pre-folded in JS (max profile_count — associative; last
   *     suppressed_until wins — item order), one row per node, avoiding same-node multi-row
   *     visibility subtleties entirely.
   * Link rows are deduped keep-FIRST per (brain, type, hash): a later duplicate per-event write
   * would only ON MATCH SET is_active=true on an edge this batch just created active — a no-op.
   *
   * DETERMINISTIC outcomes only (same contract as writeOutcome). Idempotent: same MERGE keys.
   */
  async writeOutcomesBatch(brandId: string, items: BatchOutcomeItem[]): Promise<{ written: number }> {
    if (items.length === 0) return { written: 0 };
    const nowMs = Date.now(); // one batch clock (contract: timestamps excepted)

    // ── Pre-shape the phase rows in EVENT ORDER ─────────────────────────────────────────────────
    const customerRows: Array<{ brainId: string }> = [];
    const customerSeen = new Set<string>();
    const linkRows: Array<{
      brainId: string; t: string; h: string; tier: string;
      confScore: number; confBand: string; matcherId: string; ruleVersion: string;
    }> = [];
    const linkSeen = new Set<string>();
    const h6Rows: Array<{ brainId: string }> = [];
    const h6Seen = new Set<string>();
    const mergeRows: Array<{ canonical: string; merged: string; mergeId: string }> = [];
    const phoneGuardFold = new Map<string, { type: string; value: string; pc: number; suppressedUntil: number | null }>();
    const reviewRows: Array<{ brainId: string; reason: string; evidence: string }> = [];

    for (const item of items) {
      const { outcome, verdict } = item;
      // Same per-item verdict fallback as writeOutcome (backfill passes undefined → deterministic exact).
      const confScore = verdict?.score ?? DETERMINISTIC_CONFIDENCE_SCORE;
      const confBand = verdict?.band ?? DETERMINISTIC_CONFIDENCE_BAND;
      const matcherId = verdict?.matcher_id ?? DETERMINISTIC_MATCHER_ID;
      const ruleVersion = verdict?.rule_version ?? RULE_VERSION;

      if (!customerSeen.has(outcome.brainId)) {
        customerSeen.add(outcome.brainId);
        customerRows.push({ brainId: outcome.brainId });
      }
      for (const id of outcome.newLinks) {
        const key = `${outcome.brainId}|${id.type}:${id.hash}`;
        if (linkSeen.has(key)) continue; // keep-FIRST: the dup's per-event write is a no-op re-activation
        linkSeen.add(key);
        linkRows.push({ brainId: outcome.brainId, t: id.type, h: id.hash, tier: id.tier, confScore, confBand, matcherId, ruleVersion });
      }
      if (!h6Seen.has(outcome.brainId)) {
        h6Seen.add(outcome.brainId);
        h6Rows.push({ brainId: outcome.brainId });
      }
      if (outcome.action === 'merged' && outcome.merge) {
        mergeRows.push({
          canonical: outcome.merge.canonicalBrainId,
          merged: outcome.merge.mergedBrainId,
          mergeId: outcome.merge.mergeId,
        });
      }
      for (const u of outcome.phoneGuardUpdates) {
        if (!u.suppress) continue;
        const k = `${u.identifier_type}:${u.identifier_value}`;
        const prev = phoneGuardFold.get(k);
        phoneGuardFold.set(k, {
          type: u.identifier_type,
          value: u.identifier_value,
          // max is associative → folding N sequential CASE-max SETs into one row is exact.
          pc: prev ? Math.max(prev.pc, u.profile_count) : u.profile_count,
          // last write wins (per-event SET is unconditional) → item order.
          suppressedUntil: u.suppressed_until ? u.suppressed_until.getTime() : null,
        });
      }
      if (outcome.routeToReview && outcome.reviewReason) {
        reviewRows.push({
          brainId: outcome.brainId,
          reason: outcome.reviewReason,
          evidence: JSON.stringify({ reason: outcome.reviewReason, rule_version: 'v1-deterministic' }),
        });
      }
    }

    const session = this.driver.session();
    try {
      await session.executeWrite(async (tx) => {
        // ── customers (per-event statement, UNWIND-bulked) ──
        await tx.run(
          `UNWIND $rows AS row
           MERGE (c:Customer {brand_id:$brand, brain_id:row.brainId})
           ON CREATE SET c.lifecycle_state='active', c.created_at=$nowMs,
                         c.ai_processing_consent=false, c.resolution_consent=false, c.anonymous_id=null`,
          { brand: brandId, rows: customerRows, nowMs },
        );

        // ── identity_link edges (per-event statement, UNWIND-bulked; stamps per item's verdict) ──
        if (linkRows.length > 0) {
          await tx.run(
            `UNWIND $rows AS row
             MERGE (i:Identifier {brand_id:$brand, type:row.t, hash:row.h})
             WITH i, row
             MATCH (c:Customer {brand_id:$brand, brain_id:row.brainId})
             MERGE (i)-[r:IDENTIFIES]->(c)
             ON CREATE SET r.tier=row.tier, r.is_active=true, r.created_at=$nowMs,
                           r.confidence_score=row.confScore, r.confidence_band=row.confBand,
                           r.matcher_id=row.matcherId, r.rule_version=row.ruleVersion,
                           r.schema_version=$schemaVersion
             ON MATCH SET r.is_active=true`,
            { brand: brandId, rows: linkRows, nowMs, schemaVersion: IDENTITY_SCHEMA_VERSION },
          );
        }

        // ── H6: first_identified_at (per-event statement, UNWIND-bulked; set-once conditional) ──
        await tx.run(
          `UNWIND $rows AS row
           MATCH (c:Customer {brand_id:$brand, brain_id:row.brainId})
           WHERE c.first_identified_at IS NULL
             AND EXISTS {
               MATCH (:Identifier)-[r:IDENTIFIES]->(c)
               WHERE r.is_active = true AND r.tier IN $strong
             }
           SET c.first_identified_at = $nowMs`,
          { brand: brandId, rows: h6Rows, strong: STRONG_TIERS, nowMs },
        );

        // ── merges: per-item loop IN EVENT ORDER (rare; chained merges need strict sequencing) ──
        for (const m of mergeRows) {
          await tx.run(
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
              brand: brandId, canonical: m.canonical, merged: m.merged, mergeId: m.mergeId, nowMs,
              // Backfill outcomes carry no verdict → the deterministic exact stamp, same as writeOutcome.
              confScore: DETERMINISTIC_CONFIDENCE_SCORE, confBand: DETERMINISTIC_CONFIDENCE_BAND,
              matcherId: DETERMINISTIC_MATCHER_ID, ruleVersion: RULE_VERSION,
              schemaVersion: IDENTITY_SCHEMA_VERSION,
            },
          );
          await tx.run(
            `MATCH (c:Customer {brand_id:$brand, brain_id:$canonical}), (m:Customer {brand_id:$brand, brain_id:$merged})
             WHERE m.first_identified_at IS NOT NULL
               AND (c.first_identified_at IS NULL OR m.first_identified_at < c.first_identified_at)
             SET c.first_identified_at = m.first_identified_at`,
            { brand: brandId, canonical: m.canonical, merged: m.merged },
          );
        }

        // ── phone-guard SharedUtility (pre-folded in JS: one row per node; same CASE-max SET) ──
        if (phoneGuardFold.size > 0) {
          await tx.run(
            `UNWIND $rows AS row
             MERGE (s:SharedUtility {brand_id:$brand, identifier_type:row.type, identifier_value:row.value})
             SET s.profile_count = CASE WHEN s.profile_count IS NULL OR row.pc > s.profile_count THEN row.pc ELSE s.profile_count END,
                 s.suppressed_until = row.suppressedUntil, s.flagged_at = $nowMs,
                 s.window_days = 30, s.reason = 'phone_guard_threshold_exceeded'`,
            { brand: brandId, rows: [...phoneGuardFold.values()], nowMs },
          );
        }

        // ── merge_review_queue (per-event statement, UNWIND-bulked; pure CREATEs) ──
        if (reviewRows.length > 0) {
          await tx.run(
            `UNWIND $rows AS row
             CREATE (:MergeReview {
               brand_id:$brand, review_id:randomUUID(), brain_id_a:row.brainId, brain_id_b:row.brainId,
               trigger_reason:row.reason, evidence:row.evidence, status:'pending', created_at:$nowMs })`,
            { brand: brandId, rows: reviewRows, nowMs },
          );
        }
      });

      // ── identity_audit + contact_pii → PostgreSQL, ONE txn, item order preserved (ADR-0004) ──
      await this.writePgAuditAndPiiBatch(brandId, items);

      return { written: items.length };
    } finally {
      await session.close();
    }
  }

  /** Brand phone-guard config from PG (RLS-forced → set the brand GUC in-txn before the read). */
  private async readBrandConfig(brandId: string): Promise<BrandPhoneGuardConfig> {
    const client = await this.pgPool.connect();
    try {
      await client.query('BEGIN');
      await setBrandRlsContext(client, brandId);
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

  /**
   * SPEC: A.1.5 (WA-12) — the brand's CURRENT ordered identity priority config, or null when the
   * brand has never customized it (⇒ caller uses DEFAULT_IDENTITY_PRIORITY). The store is the
   * append-only, versioned ops.brand_identity_priority (highest version = current). RLS-scoped: set
   * the brand GUC in-txn (fail-closed → 0 rows) exactly like readBrandConfig. Any stored class the
   * running code does not recognize is dropped (forward-compat); an empty/garbage order falls back
   * to the default at the resolver (order.length === 0 ⇒ DEFAULT_IDENTITY_PRIORITY).
   */
  async readPriorityConfig(brandId: string): Promise<IdentityPriorityConfig | null> {
    const client = await this.pgPool.connect();
    try {
      await client.query('BEGIN');
      await setBrandRlsContext(client, brandId);
      const rows = await client.query<{ version: number; priority_order: unknown }>(
        `SELECT version, priority_order
           FROM ops.brand_identity_priority
          WHERE brand_id = $1
          ORDER BY version DESC
          LIMIT 1`,
        [brandId],
      );
      await client.query('COMMIT');
      const row = rows.rows[0];
      if (!row) return null;
      const raw = Array.isArray(row.priority_order) ? row.priority_order : [];
      const order = raw.filter(
        (c): c is IdentityPriorityClass => typeof c === 'string' && KNOWN_PRIORITY_CLASSES.has(c),
      );
      return { version: Number(row.version), order };
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
      await setBrandRlsContext(client, brandId);

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
            // SPEC A.1.5: stamp the per-brand priority config version when the ordered-priority path
            // resolved this outcome (flag ON). Undefined on the legacy fixed-tier path → null (additive).
            priority_config_version: outcome.priorityConfigVersion ?? null,
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

  /**
   * BATCH twin of writePgAuditAndPii — the SAME per-item INSERT statements, item order preserved,
   * in ONE PG transaction (ON CONFLICT DO NOTHING on contact_pii keeps first-wins semantics under
   * that order, exactly like sequential per-event txns). The per-brand DEK is fetched ONCE per
   * batch instead of once per event (same key — the fetch is brand-keyed; same best-effort
   * `.catch(() => null)` skip-on-failure behaviour).
   */
  private async writePgAuditAndPiiBatch(brandId: string, items: BatchOutcomeItem[]): Promise<void> {
    const client = await this.pgPool.connect();
    try {
      await client.query('BEGIN');
      await setBrandRlsContext(client, brandId);

      for (const { outcome, identifiers } of items) {
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
              priority_config_version: outcome.priorityConfigVersion ?? null,
            }),
          ],
        );
      }

      const anyPii = items.some(({ outcome }) => outcome.contactPiiWrites.length > 0);
      if (anyPii && this.keyProvider) {
        const key = await this.keyProvider.getDek(brandId).catch(() => null);
        if (key) {
          await client.query("SELECT set_config('app.role', 'send_service', true)");
          for (const { outcome } of items) {
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
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  // ── DPDP/PDPL erasure lane (AUD-OPS-039 — consumer-side Neo4j purge) ─────────

  /**
   * Erasure-lane brain_id resolution: matches the identifier REGARDLESS of edge is_active
   * (active preferred), following the live ALIAS_OF chain to the canonical survivor (same
   * walk as readState).
   *
   * WHY any-state (replay-safety, D-4): eraseSubjectGraph() tombstones the IDENTIFIES edges.
   * A replayed erasure event (consumer retry after a mid-sequence failure PAST the graph
   * purge) must STILL resolve the subject so the remaining idempotent steps re-run —
   * readState()'s active-only match would return null and the replay would skip as
   * 'no_brain_id', permanently stranding the erasure short of completion. NEVER use this
   * for the resolver/live-identity paths — active-only semantics are correct there.
   */
  async findBrainIdForErasure(
    brandId: string,
    identifierType: string,
    identifierHash: string,
  ): Promise<string | null> {
    const session = this.driver.session({ defaultAccessMode: neo4j.session.READ });
    try {
      const res = await session.run(
        `MATCH (i:Identifier {brand_id:$brand, type:$type, hash:$hash})-[r:IDENTIFIES]->(c:Customer)${CANONICAL_OF_C}
         RETURN ${CANONICAL_BRAIN_ID} AS brain_id, r.is_active AS is_active
         ORDER BY r.is_active DESC
         LIMIT 1`,
        { brand: brandId, type: identifierType, hash: identifierHash },
      );
      return res.records.length > 0 ? (res.records[0]!.get('brain_id') as string) : null;
    } finally {
      await session.close();
    }
  }

  /**
   * Every identifier hash linked to a brain_id (its merged aliases included), ANY edge state.
   * Keys the Bronze raw-PII sweep (erasure STEP 4) for brain_id-only triggers — the UI
   * erase route hard-deletes contact_pii synchronously, so no raw identifier survives to
   * re-derive the hash; the graph is the only remaining source (AUD-OPS-036 residual).
   * Any-state match keeps replays complete after the graph purge tombstones the edges.
   * Hashes only — the graph never holds raw PII, so nothing raw can leave here.
   */
  async listIdentifierHashesForErasure(brandId: string, brainId: string): Promise<string[]> {
    const session = this.driver.session({ defaultAccessMode: neo4j.session.READ });
    try {
      const res = await session.run(
        `MATCH (c:Customer {brand_id:$brand})
         WHERE c.brain_id = $id
            OR EXISTS { MATCH (c)-[:ALIAS_OF*1..50]->(:Customer {brand_id:$brand, brain_id:$id}) }
         MATCH (i:Identifier {brand_id:$brand})-[:IDENTIFIES]->(c)
         RETURN DISTINCT i.hash AS hash`,
        { brand: brandId, id: brainId },
      );
      return res.records.map((r) => r.get('hash') as string);
    } finally {
      await session.close();
    }
  }

  /**
   * Graph-side subject purge — MIRRORS core's Neo4jIdentityReader.eraseCustomer Cypher
   * exactly (one erase shape everywhere): tombstone the active IDENTIFIES edges
   * (is_active=false) + mark the Customer lifecycle_state='erased'. The identifier hashes
   * stay (needed for replay resolution + Bronze sweep keying); raw PII never lived here.
   * Idempotent: re-run matches 0 active edges and re-SETs the same lifecycle_state.
   * Tenant-scoped: (brand_id, brain_id) exact pair — a foreign pair matches 0 nodes.
   */
  async eraseSubjectGraph(
    brandId: string,
    brainId: string,
  ): Promise<{ existed: boolean; linksTombstoned: number }> {
    const session = this.driver.session();
    try {
      let existed = false;
      let linksTombstoned = 0;
      await session.executeWrite(async (tx) => {
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
      return { existed, linksTombstoned };
    } finally {
      await session.close();
    }
  }

  /**
   * Delete an entire brand subgraph (test cleanup / brand offboarding / crypto-shred).
   *
   * AUD-IMPL-028: per-label + batched, NOT one label-less all-nodes scan in a single unbounded
   * DETACH DELETE transaction. The label-less form is an AllNodesScan (none of bootstrap()'s
   * label-scoped indexes apply) and the single transaction accumulates the whole brand subgraph
   * in the fixed 2g heap — on the RTBF/brand-erasure path, running exactly when the tenant's
   * graph is largest, against the single non-replicated neo4j that also serves live per-event
   * resolution. `CALL { … } IN TRANSACTIONS OF 10000 ROWS` (Neo4j 4.4+; we run 5.x) bounds each
   * commit; per-label MATCH keeps every scan label-scoped.
   *
   * NOTE: CALL … IN TRANSACTIONS is only legal in an implicit (auto-commit) transaction —
   * session.run() qualifies; NEVER wrap this in an explicit tx function. The final label-less
   * sweep stays as a drift-catcher: after the label passes it matches (near-)zero nodes, so it
   * is heap-bounded, and it guarantees the crypto-shred is COMPLETE even if a new label is
   * added without updating IDENTITY_GRAPH_LABELS.
   */
  async purgeBrand(brandId: string): Promise<void> {
    const session = this.driver.session();
    try {
      for (const label of IDENTITY_GRAPH_LABELS) {
        await session.run(
          `MATCH (n:${label} {brand_id: $b}) CALL { WITH n DETACH DELETE n } IN TRANSACTIONS OF 10000 ROWS`,
          { b: brandId },
        );
      }
      // Drift-catcher (see doc above): completeness beats scan cost on the erasure path.
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
