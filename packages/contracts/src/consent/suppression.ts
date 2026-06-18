/**
 * Consent suppression read seam — the Single-Primitive contract between the
 * consent-suppressor consumer (stream-worker, WRITES consent_record/consent_tombstone)
 * and the can_contact() compliance engine (apps/core, READS the same OLTP SoR).
 *
 * Both apps run against the same `core` Postgres. stream-worker projects consent
 * state into consent_record + consent_tombstone; core's notification chokepoint
 * queries it through this interface. No cross-service RPC — same DB, the existing
 * identity-write / core-read pattern (stream-worker writes customer/identity_link;
 * core reads them).
 *
 * FAIL-CLOSED INVARIANT (D13 §13.4): the absence of a granted consent_record OR the
 * presence of a tombstone => SUPPRESSED. There is no "unknown => allow" path here.
 *
 * PII: the subject is identified by `subjectHash` ONLY — a 64-hex identity-core
 * per-brand salt hash (sha256(salt ‖ normalized email/phone)). Raw email/phone
 * MUST NEVER appear in this contract, its args, or its results.
 */

/**
 * The 4 DPDP lawful-basis consent categories (mirrors the `consent_flags` envelope
 * field on CollectorEventV1 and the consent_record.category CHECK constraint).
 */
export type ConsentCategory =
  | 'analytics'
  | 'marketing'
  | 'personalization'
  | 'ai_processing';

export const CONSENT_CATEGORIES: readonly ConsentCategory[] = [
  'analytics',
  'marketing',
  'personalization',
  'ai_processing',
] as const;

/** Why a subject is suppressed for a category (null when NOT suppressed). */
export type SuppressionReason =
  | 'no_consent' // no consent_record row at all => fail-closed default
  | 'withdrawn' // latest consent_record.state !== 'granted'
  | 'tombstoned' // a consent_tombstone covers this subject/category
  | null;

export interface SuppressionResult {
  /** true => the subject MUST NOT be contacted for this category. */
  suppressed: boolean;
  /** The fail-closed reason; null only when suppressed === false. */
  reason: SuppressionReason;
}

/**
 * The consent suppression query seam.
 *
 * Implemented once in apps/core (notification module infrastructure) against
 * consent_record + consent_tombstone with `app.current_brand_id` GUC set.
 *
 * Contract: `isSuppressed` MUST default-close — when no granted record exists,
 * `suppressed` is true with reason `no_consent`. It never throws to mean "allow".
 */
export interface SuppressionQuery {
  isSuppressed(args: {
    brandId: string;
    subjectHash: string;
    category: ConsentCategory;
  }): Promise<SuppressionResult>;
}
