/**
 * RequestCapiDeletionUseCase — a consent withdrawal/erasure on the 'advertising'
 * category → a capi_deletion_log row (the retroactive ≤15min CAPI deletion request).
 * @effort("deterministic") — pure SHA-256 hashing + a boolean withdrawal predicate +
 *   an idempotent INSERT. No model/ML. A model here would break the deterministic
 *   ≤15min guarantee.
 *
 * Pipeline (mirrors ProjectConsentUseCase):
 *   1. Parse the collector event JSON → require brand_id + event_id + consent_flags.
 *   2. Decide: is this an 'advertising' WITHDRAWAL? Withdrawal = advertising===false
 *      (explicit) OR an all-category erasure signal. Granted advertising / no
 *      advertising key / no consent_flags → NOTHING to delete (skip).
 *   3. Extract + hash the subject (email/phone) via the SAME per-brand SaltProvider as
 *      the consent suppressor (HARD CRASH on salt failure — D-2; the subject_hash must
 *      equal the consent_record / capi_passback_log subject_hash so the deletion targets
 *      the right prior passbacks).
 *   4. Record the deletion request via CapiDeletionRepository (ON CONFLICT DO NOTHING —
 *      idempotent). In dev (no Meta creds) the status is 'would_delete_dev'; NOTHING is
 *      sent to Meta. We NEVER fake a deletion.
 *
 * WHY a SEPARATE consumer from the suppressor: the suppressor records consent STATE
 *   (consent_record/consent_tombstone). This use-case acts on the SAME withdrawal signal
 *   to fire the ad-platform-side retroactive deletion (COMPLIANCE.md: "already-passed-back
 *   conversion data must be deleted from ad platforms"). Both read the same live topic in
 *   independent consumer groups (no new topic, no new deployable — I-E05).
 *
 * FAIL-CLOSED / DEV-HONESTY: this use-case only RECORDS the deletion intent in dev.
 *   The real Meta CAPI deletion POST is the MetaCapiAdapter.delete() prod path (a
 *   default-closed stub in dev → 'would_delete_dev').
 *
 * IDEMPOTENCY (D-4): every row carries source_event_id (the collector event_id); the
 *   repository INSERTs ON CONFLICT DO NOTHING. 3× replay → exactly one deletion request.
 *
 * No raw PII in logs or the result — only the subject_hash (64-hex) and brand/event ids.
 */

import { hashIdentifier, type IdentifierType } from '@brain/identity-core';
import { SaltProvider } from '../infrastructure/secrets/SaltProvider.js';
import {
  CapiDeletionRepository,
  type CapiDeletionStatus,
} from '../infrastructure/pg/CapiDeletionRepository.js';

export type RequestCapiDeletionOutcome =
  | 'deletion_requested' // an advertising withdrawal → a deletion request written (or dedup-confirmed)
  | 'not_a_withdrawal' // advertising granted / not present → nothing to delete
  | 'no_consent_flags' // event carried no consent_flags envelope field
  | 'no_subject' // no email/phone to hash → cannot key a deletion
  | 'invalid'; // unparseable / missing brand_id|event_id

export interface RequestCapiDeletionResult {
  outcome: RequestCapiDeletionOutcome;
  brandId?: string;
  eventId?: string;
  subjectHash?: string;
  status?: CapiDeletionStatus;
  eventCount?: number;
  reason?: string;
}

export class RequestCapiDeletionUseCase {
  constructor(
    private readonly saltProvider: SaltProvider,
    private readonly deletionRepo: CapiDeletionRepository,
    /**
     * Whether real Meta CAPI deletion creds are wired. Dev/default-closed = false →
     * the request is recorded as 'would_delete_dev' (NOTHING sent). Prod with creds
     * would set this true and the MetaCapiAdapter.delete() POST advances to 'deleted'.
     */
    private readonly hasMetaCreds: boolean = false,
  ) {}

  /**
   * Pure decision (no I/O) — exported static for unit testing.
   * An 'advertising' withdrawal is: advertising===false (explicit) OR an all-category
   * erasure (a consent_flags object where advertising is absent is NOT a withdrawal —
   * default-closed at the consent-state layer, but the deletion only fires on an
   * EXPLICIT advertising=false or an erasure signal so we never spam deletions).
   */
  static isAdvertisingWithdrawal(
    flags: Record<string, unknown>,
    erasure: boolean,
  ): boolean {
    if (erasure) return true;
    return flags['advertising'] === false;
  }

  async execute(rawValue: Buffer | null, now: string): Promise<RequestCapiDeletionResult> {
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

    const flags = this.extractFlags(parsed);
    if (!flags) {
      return { outcome: 'no_consent_flags', brandId, eventId };
    }

    // An erasure event (reason='erasure' or event_name='consent.erasure') withdraws ALL
    // categories → always a CAPI deletion. Otherwise only an explicit advertising=false.
    const erasure = this.isErasure(parsed);
    if (!RequestCapiDeletionUseCase.isAdvertisingWithdrawal(flags, erasure)) {
      return { outcome: 'not_a_withdrawal', brandId, eventId };
    }

    const regionCode = typeof parsed['region_code'] === 'string' ? parsed['region_code'] : 'IN';
    const subject = this.extractSubject(parsed);
    if (!subject) {
      return { outcome: 'no_subject', brandId, eventId };
    }

    // HARD CRASH on salt failure (D-2) — the subject_hash MUST equal the consent/passback
    // hash so the deletion targets the correct prior passbacks; never hash with a bad salt.
    const saltHex = await this.saltProvider.saltHexForBrand(brandId);
    const subjectHash = hashIdentifier(subject.value, subject.type, saltHex, regionCode);

    // Default-closed: dev (no creds) → 'would_delete_dev'; prod (creds) → 'requested'
    // (the MetaCapiAdapter.delete() POST then advances it to 'deleted'). NEVER 'deleted'
    // in dev — we never fake a send.
    const status: CapiDeletionStatus = this.hasMetaCreds ? 'requested' : 'would_delete_dev';

    const tombstonedAt =
      typeof parsed['occurred_at'] === 'string' ? parsed['occurred_at'] : now;

    const result = await this.deletionRepo.requestDeletion({
      brandId,
      subjectHash,
      platform: 'meta',
      sourceEventId: eventId,
      status,
      tombstonedAt,
    });

    return {
      outcome: 'deletion_requested',
      brandId,
      eventId,
      subjectHash,
      status,
      eventCount: result.eventCount,
    };
  }

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
