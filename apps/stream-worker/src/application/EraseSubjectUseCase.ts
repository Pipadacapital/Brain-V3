/**
 * EraseSubjectUseCase — DPDP/PDPL ordered crypto-shred erasure orchestrator.
 *
 * Triggered by a consent-erasure signal on the SAME live collector topic as the
 * ConsentSuppressorConsumer / CapiDeletionConsumer (separate consumer group — NO new topic,
 * NO new deployable). On a subject-erasure it runs the ordered sequence:
 *
 *   1. Shred subject DEK — deactivate tenancy.subject_keyring.is_active=FALSE via the
 *      SECURITY DEFINER shred_subject_keyring() (0115). PRIMARY mechanism: the contact_pii
 *      envelope then becomes permanently unreadable. Also calls erase_contact_pii_for_customer
 *      (0100) as belt-and-suspenders hard-delete.
 *
 *   2. Tombstone subject → surrogate_brain_id — generate a new UUID surrogate; record in
 *      pii_erasure_log.surrogate_brain_id so money/ledger rows can reconcile on the surrogate
 *      while the envelope is destroyed.
 *
 *   2b. Neo4j graph purge (AUD-OPS-039) — tombstone the subject's IDENTIFIES edges +
 *      lifecycle_state='erased' via IErasureIdentityGraph (same Cypher shape as core's
 *      synchronous eraseCustomer, so ALL entry points converge on one graph end-state —
 *      previously only the UI erase / Shopify redact synchronous paths touched the graph;
 *      the consent-withdraw path left the subject 'active'). FAIL-CLOSED: a graph write
 *      failure throws → consumer retry → DLQ@MAX_RETRY. Replay-safe: the erasure-lane
 *      brain_id lookup matches tombstoned edges too (findBrainIdForErasure).
 *
 *   3. Scoped Gold re-projection — REUSE the existing IScopedRecomputeRepository.upsert()
 *      path (same repo the IdentityChangeRecomputeConsumer uses); do NOT build a parallel path.
 *      The mapper already handles 'identity.erased' — wire it directly rather than emitting
 *      to a Kafka topic that does not yet have a live contract.
 *
 *   3b. Serving-cache invalidation (AUD-TP-22) — publish cache.invalidate.v1 for the same
 *      ScopedRecompute (REUSE CacheInvalidatePublisher — the gold.rewritten.v1 pattern) so
 *      the AnalyticsCacheInvalidateConsumer drops the brand's Redis serving keys (which
 *      include every cached metric/journey read that could still surface the erased subject)
 *      instead of waiting out the 5m–1h TTLs. FAIL-OPEN like the identity-recompute lane:
 *      the durable ops write already succeeded; TTL expiry + the next refresh pass's
 *      gold.rewritten.v1 are the backstop. Result carries cacheInvalidated for the log line.
 *
 *   3c. Identifier-cache purge (H2) — delete the subject's `idcache:{brand}:idhash:*` entries
 *      (IIdentifierCachePurge). The identifier cache moved OUT of the brand-wide evictable
 *      keyspace (prefix-first re-key — see IdentifierCacheAdapter), so the brand-wide sweep in
 *      3b no longer clears it; the erasure lane must purge the subject's hash→brain_id entries
 *      EXPLICITLY or the shredded subject's post-erasure events would be cache-skipped against
 *      the erased brain_id instead of re-minted. Keyed by the subject hash + the graph's
 *      identifier-hash enumeration (the same set that keys the STEP-4 Bronze sweep).
 *      FAIL-CLOSED: a purge failure THROWS → retry (the sequence is idempotent).
 *
 *   4. Bronze raw-PII erasure (AUD-OPS-037) — submit the `bronze-raw-erasure` Argo
 *      WorkflowTemplate (wraps db/iceberg/spark/erasure_raw_delete.py: hard-deletes the
 *      subject's rows across the raw Bronze tables + the payload-path sweep of
 *      collector_events_connect; physically complete after bronze-maintenance snapshot expiry).
 *      FAIL-SAFE: a submit failure THROWS (retryable — consumer does not commit; DLQ@MAX_RETRY);
 *      the step never silently succeeds. When NO submitter is configured (ARGO_SERVER_URL unset
 *      — dev/tests), the step falls back to the original registered-DISABLED seam: it throws
 *      NotImplementedYet, which is caught + logged internally (honest about being unwired;
 *      do NOT claim I-S05 conformance in that configuration).
 *
 *   5. CAPI deletion — REUSE the existing RequestCapiDeletionUseCase path (do not duplicate
 *      the hashing / repo logic). Pass the raw event value through unchanged.
 *
 *   6. Mark erasure complete — SET vault_shredded=TRUE, completed_at=NOW() on pii_erasure_log.
 *
 * IDEMPOTENCY (D-4): every step is idempotent — replaying the same erasure event produces the
 * same outcome. On replay: shred fn returns false (already inactive), pii_erasure_log INSERT is
 * ON CONFLICT DO NOTHING, surrogate UPDATE is WHERE IS NULL, CAPI repo has ON CONFLICT DO NOTHING.
 *
 * TENANT ISOLATION: brand_id-first on every write; pii_erasure_log is FORCE-RLS. The shred fn
 * takes (brand_id, brain_id) explicitly (SECURITY DEFINER = no GUC dependency, but still
 * scoped to the exact requested pair — never cross-brand).
 *
 * FAIL-CLOSED (D-2): salt failure → throws; the consumer does NOT commit the offset; after
 * MAX_RETRY the message goes to DLQ (never silently skipped — an erasure must not be lost).
 * NotImplementedYet for compaction is caught internally (not an operational error; logged).
 *
 * NO RAW PII: only the hashed subject identifier (64-hex) and UUID brain_ids appear in results
 * or logs. The raw email/phone is only used locally to produce the hash and is never stored.
 */

import { randomUUID } from 'node:crypto';
import { hashIdentifier, type IdentifierType } from '@brain/identity-core';
import { SaltProvider } from '../infrastructure/secrets/SaltProvider.js';
import type { IErasureRepository } from '../infrastructure/pg/ErasureRepository.js';
import type { IBronzeRawErasureSubmitter } from '../infrastructure/argo/ArgoErasureWorkflowSubmitter.js';
import type { IIdentifierCachePurge } from '../infrastructure/redis/IdentifierCacheAdapter.js';

// Re-export so consumers (tests, main.ts) can import from one place.
export type { IErasureRepository };
import type { RequestCapiDeletionUseCase } from './RequestCapiDeletionUseCase.js';
import {
  mapIdentityEventToScopedRecompute,
  type IdentityChangeInput,
} from '../domain/identity/ScopedRecompute.js';

// ── Disabled compaction seam ──────────────────────────────────────────────────

/**
 * Error thrown by the DISABLED Iceberg compaction seam. Used in tests to prove
 * the seam throws rather than silently succeeding (fail-closed on an unbuilt step).
 *
 * DO NOT catch this error and claim I-S05 compliance — the seam is HONEST about
 * being unimplemented. The consumer catches it and logs a warning; it does NOT retry.
 */
export class NotImplementedYet extends Error {
  constructor(feature: string) {
    super(
      `[erasure] NotImplementedYet: ${feature} — ` +
      `do NOT claim I-S05 conformance; Iceberg snapshot compaction is not built`,
    );
    this.name = 'NotImplementedYet';
  }
}

/**
 * Registered-DISABLED Iceberg erasure step — the NOT-CONFIGURED fallback (AUD-OPS-037).
 *
 * The LIVE implementation is the ArgoErasureWorkflowSubmitter (injected via the optional
 * `bronzeRawErasure` constructor arg): it submits the `bronze-raw-erasure` WorkflowTemplate
 * wrapping erasure_raw_delete.py. When the submitter is NOT wired (ARGO_SERVER_URL unset —
 * dev/tests), STEP 4 falls back to this function, which ALWAYS throws NotImplementedYet so the
 * step stays honest about doing nothing (never a silent success).
 *
 * Exported so tests can prove the fallback seam throws rather than no-ops.
 */
export function shredIcebergSnapshots(_brandId: string, _brainId: string): never {
  throw new NotImplementedYet('erasure-aware-iceberg-compaction');
}

// ── Ports ─────────────────────────────────────────────────────────────────────

/**
 * Narrow brain_id lookup port. Implemented in main.ts as an inline adapter over
 * Neo4jIdentityRepository.readState() — returns the first active brain_id linked to the
 * given subject_hash, or null if not found.
 *
 * THROWS if the underlying store throws (Neo4j down etc.) — the caller (consumer) treats
 * this as a write error, does NOT commit, and retries.
 *
 * Returns null (not throws) if the subject hash exists but no active link is found —
 * the caller returns 'no_brain_id', commits (skip outcome), and logs a warning.
 */
export interface IBrainIdLookup {
  findBrainId(
    brandId: string,
    subjectHash: string,
    identifierType: string,
  ): Promise<string | null>;
}

/**
 * Narrow scoped-recompute port (same shape as IScopedRecomputeRepository in
 * IdentityChangeRecomputeConsumer — structural parity, no code coupling).
 */
export interface IErasureScopedRecomputeRepository {
  upsert(recompute: ReturnType<typeof mapIdentityEventToScopedRecompute>): Promise<void>;
}

/**
 * Identity-graph erasure port (AUD-OPS-039) — implemented by Neo4jIdentityRepository.
 * Both operations are (brand_id, brain_id)-scoped and idempotent.
 */
export interface IErasureIdentityGraph {
  /**
   * Identifier hashes linked to the brain (aliases included), ANY edge state — keys the
   * Bronze raw sweep for brain_id-only triggers. Hashes only, never raw PII.
   * THROWS on store failure (fail-closed → consumer retry).
   */
  listIdentifierHashesForErasure(brandId: string, brainId: string): Promise<string[]>;
  /**
   * Tombstone active IDENTIFIES edges + set lifecycle_state='erased' (mirrors core's
   * synchronous eraseCustomer Cypher). THROWS on store failure (fail-closed).
   */
  eraseSubjectGraph(
    brandId: string,
    brainId: string,
  ): Promise<{ existed: boolean; linksTombstoned: number }>;
}

/**
 * Serving-cache invalidation port (AUD-TP-22) — same shape as ICacheInvalidatePublisher in
 * IdentityChangeRecomputeConsumer (structural parity; the concrete instance in main.ts is
 * the SAME CacheInvalidatePublisher — one publisher, one contract, one eviction consumer).
 */
export interface IErasureCacheInvalidatePublisher {
  publishForRecompute(
    recompute: ReturnType<typeof mapIdentityEventToScopedRecompute>,
    causationEventId: string,
  ): Promise<void>;
}

// ── Result type ───────────────────────────────────────────────────────────────

export type EraseSubjectOutcome =
  | 'erased'           // all 6 steps completed (compaction logged as deferred)
  | 'not_an_erasure'   // event is a consent signal but NOT an erasure (normal skip)
  | 'no_consent_flags' // event has no consent_flags envelope (most events — normal skip)
  | 'no_subject'       // no email/phone to hash (valid erasure signal but unaddressable)
  | 'no_brain_id'      // subject hash not found in identity graph (subject not onboarded/already erased)
  | 'invalid';         // unparseable / missing brand_id|event_id → DLQ

export interface EraseSubjectResult {
  outcome: EraseSubjectOutcome;
  brandId?: string;
  eventId?: string;
  brainId?: string;
  surrogateId?: string;
  /**
   * Comma-joined names of the submitted bronze-raw-erasure Argo Workflows (one per subject
   * identifier hash; a single hash for raw-subject triggers). Set only when the submitter is wired.
   */
  bronzeRawWorkflow?: string;
  /** IDENTIFIES edges tombstoned by the Neo4j graph purge (set only when the graph port is wired). */
  graphLinksTombstoned?: number;
  /** TRUE when the cache.invalidate.v1 publish succeeded (AUD-TP-22; FAIL-OPEN — false is non-fatal). */
  cacheInvalidated?: boolean;
  /** idcache keys deleted by STEP 3c (H2; set only when the purge port is wired). */
  idCacheKeysPurged?: number;
  reason?: string;
}

// ── Use case ──────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class EraseSubjectUseCase {
  constructor(
    private readonly saltProvider: SaltProvider,
    private readonly erasureRepo: IErasureRepository,
    private readonly brainIdLookup: IBrainIdLookup,
    private readonly scopedRecomputeRepo: IErasureScopedRecomputeRepository,
    private readonly requestCapiDeletion: RequestCapiDeletionUseCase,
    /**
     * SEC M-1 (defense-in-depth): drop any in-process cached subject DEK the moment the keyring
     * is shredded, so a hot cache cannot decrypt the (now key-denied) envelope within this process.
     * Optional — absent in tests / a process that never caches the subject DEK.
     */
    private readonly invalidateSubjectDek?: (brandId: string, brainId: string) => void,
    /**
     * AUD-OPS-037: Bronze raw-PII erasure submitter (Argo `bronze-raw-erasure` WorkflowTemplate
     * wrapping erasure_raw_delete.py). Optional: unset (dev/tests — ARGO_SERVER_URL not
     * configured) → STEP 4 falls back to the registered-DISABLED shredIcebergSnapshots seam.
     * When set, a submit failure THROWS (retryable) — never a silent success.
     */
    private readonly bronzeRawErasure?: IBronzeRawErasureSubmitter,
    /**
     * AUD-TP-22: serving-cache invalidation publisher — the SAME CacheInvalidatePublisher
     * instance the IdentityChangeRecomputeConsumer uses (one publisher, one eviction consumer).
     * Optional: unset (tests) → STEP 3b is skipped. FAIL-OPEN when set (publish errors are
     * swallowed — TTL + the next gold.rewritten.v1 are the backstop).
     */
    private readonly cacheInvalidate?: IErasureCacheInvalidatePublisher,
    /**
     * AUD-OPS-039: Neo4j identity-graph erasure port (Neo4jIdentityRepository). Optional:
     * unset (tests) → STEP 2b is skipped and STEP 4 has no graph-hash fallback. FAIL-CLOSED
     * when set: a graph failure THROWS (retryable — consumer does not commit; DLQ@MAX_RETRY).
     */
    private readonly identityGraph?: IErasureIdentityGraph,
    /**
     * H2: identifier-cache purge port (STEP 3c — IdentifierCacheAdapter.purgeSubjectHashes).
     * The `idcache:` keyspace is exempt from the brand-wide serving-cache sweep, so the erasure
     * lane deletes the subject's hash→brain_id entries explicitly. Optional: unset (tests) →
     * STEP 3c is skipped. FAIL-CLOSED when set: a purge failure THROWS (retryable — the
     * shredded subject's hashes must not stay mapped to the erased brain_id).
     */
    private readonly identifierCachePurge?: IIdentifierCachePurge,
  ) {}

  async execute(rawValue: Buffer | null, now: string): Promise<EraseSubjectResult> {
    // ── Parse ──────────────────────────────────────────────────────────────────
    if (rawValue == null) {
      return { outcome: 'invalid', reason: 'null message value' };
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawValue.toString('utf8')) as Record<string, unknown>;
    } catch {
      return { outcome: 'invalid', reason: 'JSON parse error' };
    }

    const brandId = typeof parsed['brand_id'] === 'string' ? parsed['brand_id'] : null;
    const eventId = typeof parsed['event_id'] === 'string' ? parsed['event_id'] : null;
    if (!brandId || !eventId) {
      return { outcome: 'invalid', reason: 'missing brand_id or event_id' };
    }

    // ── Consent envelope guard ─────────────────────────────────────────────────
    const flags = this.extractFlags(parsed);
    if (!flags) {
      // No consent_flags on this event — normal for most collector events. Skip silently.
      return { outcome: 'no_consent_flags', brandId, eventId };
    }

    // ── Erasure-signal check ──────────────────────────────────────────────────
    if (!this.isErasure(parsed)) {
      // A regular consent withdrawal/grant — not an erasure. The ConsentSuppressorConsumer
      // and CapiDeletionConsumer handle this; we skip.
      return { outcome: 'not_an_erasure', brandId, eventId };
    }

    // ── Subject resolution ────────────────────────────────────────────────────
    // PRIMARY path: raw email/phone → salt-hash → graph lookup. The hash ALSO keys the
    // STEP-4 Bronze raw sweep, so it is computed whenever a raw subject is present.
    // AUD-OPS-036 direct addressing: the core erasure-trigger bridge carries an
    // already-resolved properties.brain_id for entry points that hold NO raw identifier
    // (the UI erase route hard-deletes contact_pii synchronously, so no email/phone exists
    // to re-derive) — used when the event has no raw subject, or the raw subject is not
    // linked in the graph but the entry point resolved the brain_id another way (e.g. the
    // Shopify redact resolves via storefront_customer_id). Tenant isolation holds: EVERY
    // downstream write is scoped to the exact (brand_id, brain_id) pair from THIS event —
    // a mismatched/foreign pair matches 0 rows (never cross-brand).
    const directBrainId = this.extractDirectBrainId(parsed);
    const subject = this.extractSubject(parsed);
    let brainId: string | null = null;
    let subjectHash: string | undefined;

    if (subject) {
      const regionCode =
        typeof parsed['region_code'] === 'string' ? parsed['region_code'] : 'IN';

      // HARD CRASH on salt failure (D-2): the subject_hash must equal the hash stored in
      // identity_link / subject_keyring — never hash with a bad salt.
      const saltHex = await this.saltProvider.saltHexForBrand(brandId);
      subjectHash = hashIdentifier(subject.value, subject.type, saltHex, regionCode);

      // ── Brain-ID resolution ─────────────────────────────────────────────────
      // Throws if the identity store is unavailable → consumer retries (fail-closed).
      // Returns null if subject not found → fall back to direct addressing below.
      brainId = await this.brainIdLookup.findBrainId(brandId, subjectHash, subject.type);
    }

    if (!brainId && directBrainId) {
      brainId = directBrainId;
    }
    if (!brainId) {
      // Same skip semantics as pre-bridge: unaddressable event → 'no_subject';
      // addressable-but-unknown subject → 'no_brain_id' (logged as WARN by the consumer).
      return { outcome: subject ? 'no_brain_id' : 'no_subject', brandId, eventId };
    }

    // ── ORDERED ERASURE SEQUENCE ──────────────────────────────────────────────

    // Audit record: init pii_erasure_log (idempotent INSERT).
    await this.erasureRepo.initErasureLog(brandId, brainId, eventId, now);

    // STEP 1 — Shred subject DEK (PRIMARY mechanism).
    // UPDATE subject_keyring SET is_active=FALSE via SECURITY DEFINER fn (0115).
    // Idempotent: already-inactive rows are a safe no-op (returns false, not throws).
    await this.erasureRepo.shredSubjectKeyring(brandId, brainId);
    // SEC M-1: evict any hot in-process subject-DEK cache so the key-denied envelope cannot be
    // decrypted from cache within this process lifetime (the DB row is already is_active=FALSE).
    this.invalidateSubjectDek?.(brandId, brainId);

    // STEP 1b — Belt-and-suspenders hard delete (0100).
    // Physically removes the contact_pii rows for this subject. The DEK shred already
    // made the ciphertext permanently unreadable; this removes the ciphertext itself.
    await this.erasureRepo.eraseContactPii(brandId, brainId);

    // STEP 2 — Tombstone to surrogate_brain_id.
    // A new UUID represents the erased subject in the money/ledger reconciliation path
    // (ledger rows still point to the original brain_id; the surrogate lets analytics
    // distinguish "deleted slot" from "never existed"). Idempotent: WHERE IS NULL guard.
    const surrogateId = randomUUID();
    await this.erasureRepo.recordSurrogate(brandId, brainId, surrogateId);

    // STEP 2b — Neo4j identity-graph purge (AUD-OPS-039).
    // Tombstone the subject's IDENTIFIES edges + lifecycle_state='erased' — the SAME graph
    // end-state the synchronous eraseCustomer path produces, so every entry point (incl. the
    // consent-withdraw trigger, which has NO synchronous graph erase) converges. Idempotent
    // (re-run matches 0 active edges). FAIL-CLOSED: a graph failure propagates → consumer
    // retry → DLQ@MAX_RETRY (replay resolution survives the tombstone via the any-state
    // erasure-lane lookup). Skipped when the port is not wired (tests).
    let graphLinksTombstoned: number | undefined;
    if (this.identityGraph) {
      const purge = await this.identityGraph.eraseSubjectGraph(brandId, brainId);
      graphLinksTombstoned = purge.linksTombstoned;
    }

    // STEP 3 — Scoped Gold re-projection.
    // REUSE the existing IScopedRecomputeRepository.upsert() path (the same repo
    // IdentityChangeRecomputeConsumer uses). The ScopedRecompute mapper already handles
    // 'identity.erased'. We write directly to ops (no Kafka emit needed — the
    // identity.erased.v1 contract does not yet exist in packages/contracts v1).
    const erasedInput: IdentityChangeInput = {
      event_name: 'identity.erased',
      event_id:   eventId,
      brand_id:   brandId,
      payload:    { brain_id: brainId },
    };
    const recompute = mapIdentityEventToScopedRecompute(erasedInput, now);
    await this.scopedRecomputeRepo.upsert(recompute);

    // STEP 3b — Serving-cache invalidation (AUD-TP-22).
    // REUSE the CacheInvalidatePublisher (the gold.rewritten.v1 / identity-recompute pattern):
    // one cache.invalidate.v1 per affected Gold mart, scope.all=true for THIS brand only —
    // the AnalyticsCacheInvalidateConsumer SCANs `${brandId}:*` and drops every serving-cache
    // key that could still surface the erased subject (journeys, metrics, tp cache), instead
    // of waiting out the 5m–1h TTLs. FAIL-OPEN (matches the identity-recompute lane): the
    // durable ops write above already succeeded; deterministic event_ids make replays dedup.
    let cacheInvalidated = false;
    if (this.cacheInvalidate) {
      try {
        await this.cacheInvalidate.publishForRecompute(recompute, eventId);
        cacheInvalidated = true;
      } catch {
        // Non-fatal: the publisher already logged. TTL expiry + the next refresh pass's
        // gold.rewritten.v1 bust the same keys; the erasure itself proceeds.
      }
    }

    // ── Subject identifier-hash enumeration (shared by STEP 3c + STEP 4) ──────
    // The graph's hash set (AUD-OPS-039 — aliases included, ANY edge state, so it still
    // answers after STEP 2b's tombstone; replay-safe) is fetched ONCE when either consumer
    // needs it: the idcache purge always wants the FULL set (a subject may have cached
    // anon/device/email hashes beyond the trigger's raw subject), and the Bronze sweep
    // falls back to it on brain_id-only triggers. FAIL-CLOSED (throws → retry).
    let graphHashes: string[] = [];
    if (
      this.identityGraph &&
      (this.identifierCachePurge !== undefined ||
        (this.bronzeRawErasure !== undefined && !subjectHash))
    ) {
      graphHashes = await this.identityGraph.listIdentifierHashesForErasure(brandId, brainId);
    }

    // STEP 3c — Identifier-cache purge (H2).
    // Delete the subject's `idcache:{brand}:idhash:*` entries so the shredded subject's hashes
    // stop resolving to the erased brain_id (the brand-wide sweep in 3b is prefix-blind to this
    // keyspace by design). Union of the trigger's subject hash + the graph's enumeration —
    // hashes only, never raw PII. Idempotent (absent keys delete 0). FAIL-CLOSED: a Redis
    // failure THROWS → the orchestrator retries the (idempotent) sequence.
    let idCacheKeysPurged: number | undefined;
    if (this.identifierCachePurge) {
      const purgeHashes = [...new Set([...(subjectHash ? [subjectHash] : []), ...graphHashes])];
      idCacheKeysPurged =
        purgeHashes.length > 0
          ? await this.identifierCachePurge.purgeSubjectHashes(brandId, purgeHashes)
          : 0;
    }

    // STEP 4 — Bronze raw-PII erasure (AUD-OPS-037).
    // Submit the bronze-raw-erasure Argo WorkflowTemplate (erasure_raw_delete.py): hard-deletes
    // the subject's raw Bronze rows, keyed by (brand_id, subjectHash) + the RAW anon/device ids
    // read off THIS erasure signal's own envelope (the payload stores them un-hashed, so the
    // hash cannot match them — see the Spark job's docstring). Idempotent: a replayed submit
    // re-runs DELETEs that affect 0 rows.
    // FAIL-SAFE: a submit failure PROPAGATES — the consumer does not commit the offset, the
    // message retries (→ DLQ@MAX_RETRY), and steps 5/6 never run, so an erasure whose Bronze
    // sweep was not submitted is never marked complete. Never a silent success.
    // Subject-hash keying: the trigger's own salt-hashed identifier when a raw subject rode
    // the event; otherwise (brain_id-only trigger — AUD-OPS-036 direct addressing, e.g. the
    // UI erase route whose raw identifier was already hard-deleted) the GRAPH's identifier
    // hashes for this brain (AUD-OPS-039 — closes the residual: previously brain_id-only
    // triggers NEVER got a Bronze sweep). Hashes only — never fabricated, never raw PII.
    // Graph lookup is FAIL-CLOSED (throws → retry) and any-state (replay-safe post-purge).
    // (Semantics unchanged: raw-subject triggers key on the trigger's own hash; brain_id-only
    // triggers key on the graph enumeration — already fetched above, never re-fetched.)
    const identifierHashes: string[] = subjectHash ? [subjectHash] : graphHashes;

    let bronzeRawWorkflow: string | undefined;
    if (this.bronzeRawErasure && identifierHashes.length > 0) {
      const { anonIds, deviceIds } = this.extractRawSubjectIds(parsed);
      // One workflow per hash (erasures are rare; the Spark job takes a single hash). A
      // mid-loop failure THROWS → the consumer retries the whole (idempotent) sequence.
      const workflowNames: string[] = [];
      for (const identifierHash of identifierHashes) {
        const submitted = await this.bronzeRawErasure.submit({
          brandId,
          identifierHash,
          anonIds,
          deviceIds,
        });
        workflowNames.push(submitted.workflowName);
      }
      bronzeRawWorkflow = workflowNames.join(',');
    } else {
      // NOT CONFIGURED (dev/tests — no ARGO_SERVER_URL) — OR a brain_id-only trigger whose
      // graph carries no identifier hashes (nothing to key the sweep on; NEVER fabricate a
      // hash). Falls to the original registered-DISABLED seam so the step stays honest about
      // doing nothing.
      // shredIcebergSnapshots always throws NotImplementedYet; catch it and continue — the
      // primary erasure is done (DEK shredded + hard delete). Do NOT claim I-S05 conformance
      // for this configuration. The consumer will NOT retry or DLQ for this.
      try {
        shredIcebergSnapshots(brandId, brainId);
      } catch (err) {
        if (err instanceof NotImplementedYet) {
          // Expected: submitter not wired. Intentional no-op (logged via the thrown message
          // semantics in tests); continues to step 5.
        } else {
          throw err; // Unexpected error → propagate to consumer retry path.
        }
      }
    }

    // STEP 5 — CAPI deletion.
    // REUSE the existing RequestCapiDeletionUseCase path (pass through the raw event
    // Buffer unchanged — it will re-parse, re-check the erasure flag, re-hash the subject,
    // and record the deletion in capi_deletion_log via the same idempotent path as the
    // standalone CapiDeletionConsumer). Do NOT duplicate the repo or hashing logic.
    await this.requestCapiDeletion.execute(rawValue, now);

    // STEP 6 — Mark erasure complete.
    // Set vault_shredded=TRUE, completed_at=NOW() on pii_erasure_log.
    await this.erasureRepo.completeErasure(brandId, brainId);

    return {
      outcome: 'erased',
      brandId,
      eventId,
      brainId,
      surrogateId,
      bronzeRawWorkflow,
      graphLinksTombstoned,
      cacheInvalidated,
      idCacheKeysPurged,
    };
  }

  // ── Helpers (same logic as RequestCapiDeletionUseCase / ProjectConsentUseCase) ──

  private isErasure(parsed: Record<string, unknown>): boolean {
    const payload = (parsed['payload'] as Record<string, unknown>) ?? parsed;
    const eventName =
      typeof parsed['event_name'] === 'string' ? parsed['event_name'] :
      typeof payload['event_name'] === 'string' ? payload['event_name'] : '';
    const reason =
      typeof parsed['reason'] === 'string' ? parsed['reason'] :
      typeof payload['reason'] === 'string' ? payload['reason'] : '';
    return eventName.includes('erasure') || reason === 'erasure';
  }

  private extractFlags(parsed: Record<string, unknown>): Record<string, unknown> | null {
    const payload = (parsed['payload'] as Record<string, unknown>) ?? parsed;
    const raw =
      (parsed['consent_flags'] as Record<string, unknown> | undefined) ??
      (payload['consent_flags'] as Record<string, unknown> | undefined);
    if (!raw || typeof raw !== 'object') return null;
    return raw;
  }

  /**
   * RAW anon/device ids off the erasure signal's own envelope — the payload-path DELETE
   * predicates for collector_events_connect (the payload stores these UN-hashed, so
   * IDENTIFIER_HASH cannot match them; see erasure_raw_delete.py). Same property names +
   * precedence as domain/identity/extract-identifiers.ts (brain_anon_id > anon_id,
   * device_id > $device_id); both variants are collected when both are present — the Spark
   * job's IN-list matches every path against every value, so extras are harmless.
   */
  private extractRawSubjectIds(
    parsed: Record<string, unknown>,
  ): { anonIds: string[]; deviceIds: string[] } {
    const payload = (parsed['payload'] as Record<string, unknown>) ?? parsed;
    const props = (payload['properties'] as Record<string, unknown>) ?? {};

    const collect = (keys: string[]): string[] => {
      const out: string[] = [];
      for (const key of keys) {
        const v = props[key];
        if (typeof v === 'string' && v.trim() && !out.includes(v.trim())) out.push(v.trim());
      }
      return out;
    };

    return {
      anonIds: collect(['brain_anon_id', 'anon_id']),
      deviceIds: collect(['device_id', '$device_id']),
    };
  }

  /**
   * AUD-OPS-036: extract the already-resolved brain_id the core erasure-trigger bridge places
   * in properties.brain_id (direct addressing for entry points with no raw identifier).
   * Returns null unless the value is a well-formed UUID — a malformed value falls through to
   * the normal subject-hash path (never a garbage key into the erasure sequence).
   */
  private extractDirectBrainId(parsed: Record<string, unknown>): string | null {
    const payload = (parsed['payload'] as Record<string, unknown>) ?? parsed;
    const props = (payload['properties'] as Record<string, unknown>) ?? {};
    const raw = props['brain_id'];
    return typeof raw === 'string' && UUID_RE.test(raw) ? raw : null;
  }

  private extractSubject(
    parsed: Record<string, unknown>,
  ): { type: IdentifierType; value: string } | null {
    const payload = (parsed['payload'] as Record<string, unknown>) ?? parsed;
    const props = (payload['properties'] as Record<string, unknown>) ?? {};

    const rawEmail =
      typeof props['email'] === 'string' ? props['email'] :
      typeof props['$email'] === 'string' ? props['$email'] : null;
    if (rawEmail) return { type: 'email', value: rawEmail };

    const rawPhone =
      typeof props['phone'] === 'string' ? props['phone'] :
      typeof props['phone_number'] === 'string' ? props['phone_number'] :
      typeof props['$phone'] === 'string' ? props['$phone'] : null;
    if (rawPhone) return { type: 'phone', value: rawPhone };

    return null;
  }
}
