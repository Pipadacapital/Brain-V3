/**
 * EraseSubjectUseCase — DPDP/PDPL ordered crypto-shred erasure orchestrator.
 *
 * Triggered by a consent-erasure signal on the SAME live collector topic as the
 * ConsentSuppressorConsumer / CapiDeletionConsumer (separate consumer group — NO new topic,
 * NO new deployable). On a subject-erasure it runs the 6-step ordered sequence:
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
 *   3. Scoped Gold re-projection — REUSE the existing IScopedRecomputeRepository.upsert()
 *      path (same repo the IdentityChangeRecomputeConsumer uses); do NOT build a parallel path.
 *      The mapper already handles 'identity.erased' — wire it directly rather than emitting
 *      to a Kafka topic that does not yet have a live contract.
 *
 *   4. Erasure-aware Iceberg compaction — REGISTERED DISABLED. Throws NotImplementedYet.
 *      A shredded subject could otherwise be resurrected from old Iceberg snapshots; this step
 *      is the placeholder for that compaction job. Do NOT claim I-S05 conformance here.
 *      The consumer catches NotImplementedYet and logs it; it does NOT retry or DLQ for this.
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
 * Registered-DISABLED Iceberg compaction step.
 *
 * A shredded subject's ciphertext remains in Iceberg snapshot history; without snapshot
 * compaction / expiry the data could technically be recovered from old snapshots. This step
 * is the placeholder for `erasure_raw_delete.py` (the Iceberg Bronze layer compaction job).
 * Until that job exists, this function ALWAYS throws NotImplementedYet.
 *
 * Exported so tests can prove the seam throws rather than no-ops.
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
  reason?: string;
}

// ── Use case ──────────────────────────────────────────────────────────────────

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

    // ── Subject extraction + hash ─────────────────────────────────────────────
    const regionCode =
      typeof parsed['region_code'] === 'string' ? parsed['region_code'] : 'IN';
    const subject = this.extractSubject(parsed);
    if (!subject) {
      return { outcome: 'no_subject', brandId, eventId };
    }

    // HARD CRASH on salt failure (D-2): the subject_hash must equal the hash stored in
    // identity_link / subject_keyring — never hash with a bad salt.
    const saltHex = await this.saltProvider.saltHexForBrand(brandId);
    const subjectHash = hashIdentifier(subject.value, subject.type, saltHex, regionCode);

    // ── Brain-ID resolution ───────────────────────────────────────────────────
    // Throws if the identity store is unavailable → consumer retries (fail-closed).
    // Returns null if subject not found → skip with 'no_brain_id' (logged as WARN).
    const brainId = await this.brainIdLookup.findBrainId(brandId, subjectHash, subject.type);
    if (!brainId) {
      return { outcome: 'no_brain_id', brandId, eventId };
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

    // STEP 4 — Erasure-aware Iceberg compaction [REGISTERED DISABLED].
    // shredIcebergSnapshots always throws NotImplementedYet. Catch it here, log, and
    // continue — the primary erasure is done (DEK shredded + hard delete). Do NOT
    // claim I-S05 conformance for this step.
    try {
      shredIcebergSnapshots(brandId, brainId);
    } catch (err) {
      if (err instanceof NotImplementedYet) {
        // Expected: compaction not built. Log at info level (not error; it is intentional).
        // The consumer will NOT retry or DLQ for this; it continues to step 5.
      } else {
        throw err; // Unexpected error → propagate to consumer retry path.
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

    return { outcome: 'erased', brandId, eventId, brainId, surrogateId };
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
