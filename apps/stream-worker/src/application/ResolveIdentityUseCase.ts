/**
 * ResolveIdentityUseCase — extract → normalize → hash → resolve → write.
 * @effort("deterministic") — no model calls; pure SHA-256 + count threshold.
 *
 * Pipeline:
 *   1. Parse Bronze event payload JSONB → extract identifiers (email/phone/storefront_id).
 *   2. Normalize + hash each (real SHA-256 via identity-core; per-brand salt from SaltProvider).
 *   3. Read pre-resolution state from IdentityRepository.
 *   4. IdentityResolver (pure domain) → ResolveOutcome.
 *   5. Write outcome to Postgres via IdentityRepository (one txn, GUC scoped, brain_app).
 *
 * Called by IdentityBridgeConsumer; returns ResolveResult.
 * Kafka offset committed by consumer ONLY after this returns without throwing.
 *
 * No raw PII in logs or outcome — only hashes (I-S02 / D-3).
 */

import { normalizeIdentifier, hashIdentifier, normalizePhone } from '@brain/identity-core';
import { SaltProvider } from '../infrastructure/secrets/SaltProvider.js';
import { IdentityRepository } from '../infrastructure/pg/IdentityRepository.js';
import {
  IdentityResolver,
  ExtractedIdentifier,
} from '../domain/identity/IdentityResolver.js';

export type ResolveOutcomeType = 'minted' | 'linked' | 'merged' | 'suppressed' | 'skipped' | 'no_identifiers' | 'invalid';

export interface ResolveResult {
  outcome: ResolveOutcomeType;
  brainId?: string;
  brandId?: string;
  eventId?: string;
  reason?: string;
}

export class ResolveIdentityUseCase {
  private readonly resolver = new IdentityResolver();

  constructor(
    private readonly saltProvider: SaltProvider,
    private readonly identityRepo: IdentityRepository,
  ) {}

  /**
   * Process a single Bronze event: extract identifiers, resolve brain_id, write.
   *
   * @param rawValue  Kafka message value (Buffer).
   * @param _now      Current ISO-8601 timestamp (for audit; not used in hash).
   */
  async execute(rawValue: Buffer | null, _now: string): Promise<ResolveResult> {
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

    // Extract brand region for phone normalization (D-6)
    const regionCode = typeof parsed['region_code'] === 'string' ? parsed['region_code'] : 'IN';

    // ── 1. Extract identifiers from payload ──────────────────────────────────
    const payload = (parsed['payload'] as Record<string, unknown>) ?? parsed;
    const props = (payload['properties'] as Record<string, unknown>) ?? {};

    const rawEmail = typeof props['email'] === 'string' ? props['email'] :
                     typeof props['$email'] === 'string' ? props['$email'] : null;
    const rawPhone = typeof props['phone'] === 'string' ? props['phone'] :
                     typeof props['phone_number'] === 'string' ? props['phone_number'] :
                     typeof props['$phone'] === 'string' ? props['$phone'] : null;
    const storefrontCustomerId = typeof props['customer_id'] === 'string' ? props['customer_id'] :
                                 typeof props['storefront_customer_id'] === 'string' ? props['storefront_customer_id'] : null;

    if (!rawEmail && !rawPhone && !storefrontCustomerId) {
      return { outcome: 'no_identifiers', brandId, eventId };
    }

    // ── 2. Fetch per-brand salt (HARD CRASH on failure — D-2) ────────────────
    // saltProvider.saltHexForBrand throws if salt is missing/wrong-length.
    // Let it propagate — the consumer must NOT commit the offset on salt failure.
    const saltHex = await this.saltProvider.saltHexForBrand(brandId);

    // ── 3. Normalize + hash each identifier ──────────────────────────────────
    const identifiers: ExtractedIdentifier[] = [];

    if (rawEmail) {
      const hash = hashIdentifier(rawEmail, 'email', saltHex, regionCode);
      identifiers.push({
        type: 'email',
        hash,
        tier: 'strong',
        confidence: 'high',
        rawValue: rawEmail, // for contact_pii write only
      });
    }

    if (rawPhone) {
      const { normalized: normPhone, confidence } = normalizePhone(rawPhone, regionCode);
      const hash = hashIdentifier(normPhone, 'phone', saltHex, regionCode);
      identifiers.push({
        type: 'phone',
        hash,
        tier: 'strong',
        confidence,
        rawValue: rawPhone, // for contact_pii write only
      });
    }

    if (storefrontCustomerId) {
      const normalized = normalizeIdentifier(storefrontCustomerId, 'external_id', regionCode);
      const hash = hashIdentifier(normalized, 'external_id', saltHex, regionCode);
      identifiers.push({
        type: 'storefront_customer_id',
        hash,
        tier: 'strong_on_link',
        confidence: 'high',
        rawValue: undefined, // not PII
      });
    }

    // ── 4. Read pre-resolution state ─────────────────────────────────────────
    const idHashes = identifiers.map((i) => ({ type: i.type, hash: i.hash }));
    const state = await this.identityRepo.readState(brandId, idHashes);

    // ── 5. Resolve ────────────────────────────────────────────────────────────
    const outcome = this.resolver.resolve(
      brandId,
      identifiers,
      state.existingLinks,
      state.sharedUtilityMap,
      state.phoneCount,
      state.brandConfig,
      state.aliasChain,
    );

    // ── 6. Write ──────────────────────────────────────────────────────────────
    await this.identityRepo.writeOutcome(brandId, outcome, identifiers);

    return {
      outcome: outcome.action,
      brainId: outcome.brainId,
      brandId,
      eventId,
    };
  }
}
