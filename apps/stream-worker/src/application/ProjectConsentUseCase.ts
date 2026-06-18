/**
 * ProjectConsentUseCase — collector event → consent_record / consent_tombstone rows.
 * @effort("deterministic") — pure SHA-256 hashing + boolean projection. No model/ML.
 *
 * Pipeline (mirrors ResolveIdentityUseCase):
 *   1. Parse the collector event JSON → require brand_id + event_id + consent_flags.
 *   2. Extract the subject identifier (email/phone) from the payload.
 *   3. Hash it via @brain/identity-core with the per-brand salt (HARD CRASH on
 *      salt failure — D-2: never project with an empty/default salt).
 *   4. Pure projection: each of the 4 consent_flags → a consent_record row
 *      (granted | withdrawn). marketing=false (an explicit withdrawal signal) ALSO
 *      writes a consent_tombstone for category='marketing' (fast-path suppression).
 *   5. Hand the projected rows to ConsentRepository (one txn, GUC-scoped, brain_app,
 *      ON CONFLICT DO NOTHING — idempotent replay).
 *
 * FAIL-CLOSED: this consumer only RECORDS state. The absence of a granted row is
 *   itself "suppressed" at read time (SuppressionQuery), so a missing/absent flag is
 *   never an "allow" — it is simply no granted row. Withdrawal is recorded as both a
 *   withdrawn consent_record AND a tombstone so suppression is sticky.
 *
 * IDEMPOTENCY (D-4): every row carries source_event_id (the collector event_id); the
 *   repository INSERTs ON CONFLICT DO NOTHING against the dedup unique indexes. 3×
 *   replay of the same event → exactly the same rows.
 *
 * No raw PII in logs or the result — only the subject_hash (64-hex) and brand/event ids.
 */

import { hashIdentifier, type IdentifierType } from '@brain/identity-core';
import { SaltProvider } from '../infrastructure/secrets/SaltProvider.js';
import {
  ConsentRepository,
  type ConsentRecordRow,
  type ConsentTombstoneRow,
} from '../infrastructure/pg/ConsentRepository.js';

export type ProjectConsentOutcome =
  | 'projected' // consent rows written (or dedup-confirmed)
  | 'no_consent_flags' // event carried no consent_flags envelope field — nothing to project
  | 'no_subject' // event carried no email/phone to hash — cannot key a consent row
  | 'invalid'; // unparseable / missing brand_id|event_id

export interface ProjectConsentResult {
  outcome: ProjectConsentOutcome;
  brandId?: string;
  eventId?: string;
  subjectHash?: string;
  recordCount?: number;
  tombstoneCount?: number;
  reason?: string;
}

/** The 4 DPDP lawful-basis categories carried on the consent_flags envelope field. */
const CONSENT_CATEGORIES = [
  'analytics',
  'marketing',
  'personalization',
  'ai_processing',
] as const;
type ConsentCategory = (typeof CONSENT_CATEGORIES)[number];

interface ConsentFlags {
  analytics: boolean;
  marketing: boolean;
  personalization: boolean;
  ai_processing: boolean;
}

export class ProjectConsentUseCase {
  constructor(
    private readonly saltProvider: SaltProvider,
    private readonly consentRepo: ConsentRepository,
  ) {}

  /**
   * Pure projection (no I/O) — exported as a static for unit testing.
   * Given a subject_hash + consent_flags + provenance, produce the rows to write.
   * marketing=false => a withdrawn record AND a tombstone (sticky suppression).
   */
  static project(
    brandId: string,
    subjectHash: string,
    flags: ConsentFlags,
    source: ConsentRecordRow['source'],
    sourceEventId: string | null,
  ): { records: ConsentRecordRow[]; tombstones: ConsentTombstoneRow[] } {
    const records: ConsentRecordRow[] = [];
    const tombstones: ConsentTombstoneRow[] = [];

    for (const category of CONSENT_CATEGORIES) {
      const granted = flags[category] === true;
      records.push({
        brandId,
        subjectHash,
        category,
        state: granted ? 'granted' : 'withdrawn',
        source,
        policyVersion: 'v1',
        sourceEventId,
      });

      // An explicit withdrawal of a marketing-bearing category → a tombstone so the
      // fast-path suppression is sticky (DPDP <15min withdrawal propagation).
      if (!granted) {
        tombstones.push({
          brandId,
          subjectHash,
          category,
          reason: 'withdrawal',
          source: source === 'collector' ? 'collector' : source as ConsentTombstoneRow['source'],
          sourceEventId,
        });
      }
    }

    return { records, tombstones };
  }

  async execute(rawValue: Buffer | null, _now: string): Promise<ProjectConsentResult> {
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

    // consent_flags is a first-class envelope field; absent => nothing to project.
    const flags = this.extractFlags(parsed);
    if (!flags) {
      return { outcome: 'no_consent_flags', brandId, eventId };
    }

    // Extract the subject identifier (email preferred, else phone) to key the consent row.
    const regionCode = typeof parsed['region_code'] === 'string' ? parsed['region_code'] : 'IN';
    const subject = this.extractSubject(parsed);
    if (!subject) {
      return { outcome: 'no_subject', brandId, eventId };
    }

    // HARD CRASH on salt failure (D-2) — never project with an empty/default salt.
    const saltHex = await this.saltProvider.saltHexForBrand(brandId);
    const subjectHash = hashIdentifier(subject.value, subject.type, saltHex, regionCode);

    const { records, tombstones } = ProjectConsentUseCase.project(
      brandId,
      subjectHash,
      flags,
      'collector',
      eventId,
    );

    await this.consentRepo.writeProjection(brandId, records, tombstones);

    return {
      outcome: 'projected',
      brandId,
      eventId,
      subjectHash,
      recordCount: records.length,
      tombstoneCount: tombstones.length,
    };
  }

  private extractFlags(parsed: Record<string, unknown>): ConsentFlags | null {
    // consent_flags may sit at the envelope top level or inside payload (collector wire).
    const payload = (parsed['payload'] as Record<string, unknown>) ?? parsed;
    const raw =
      (parsed['consent_flags'] as Record<string, unknown> | undefined) ??
      (payload['consent_flags'] as Record<string, unknown> | undefined);
    if (!raw || typeof raw !== 'object') return null;

    const get = (k: ConsentCategory): boolean => raw[k] === true;
    // Require all 4 keys to be present as booleans — a partial object is malformed.
    if (
      typeof raw['analytics'] !== 'boolean' ||
      typeof raw['marketing'] !== 'boolean' ||
      typeof raw['personalization'] !== 'boolean' ||
      typeof raw['ai_processing'] !== 'boolean'
    ) {
      return null;
    }
    return {
      analytics: get('analytics'),
      marketing: get('marketing'),
      personalization: get('personalization'),
      ai_processing: get('ai_processing'),
    };
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
