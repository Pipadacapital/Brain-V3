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
import { log } from '../log.js';
import { SaltProvider } from '../infrastructure/secrets/SaltProvider.js';
import type { IdentityStore } from '../domain/identity/IdentityStore.js';
import {
  IdentityResolver,
  ExtractedIdentifier,
} from '../domain/identity/IdentityResolver.js';
import {
  buildIdentityEvents,
  type IdentityEventPublisher,
} from '../domain/identity/IdentityEventPublisher.js';

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
    /**
     * The identity store (system-of-record). MEDALLION REALIGNMENT (Epic 3 / ADR-0004): wired to the
     * Neo4jIdentityRepository in the composition root — Neo4j is the SoR. The use-case is store-agnostic
     * (the resolver is pure; this is the IdentityStore contract).
     */
    private readonly identityRepo: IdentityStore,
    /**
     * The identity.* outbound event publisher (Kafka adapter in infrastructure). OPTIONAL: when
     * absent (some tests / legacy wiring) the resolution still runs and writes the graph — only the
     * domain-event emission is skipped. Publishing happens AFTER the graph write (commit-after-write).
     */
    private readonly identityEventPublisher?: IdentityEventPublisher,
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
    // correlation_id of the source event — threaded onto the published identity.* envelope so the
    // identity events stay on the same trace/flow as the Bronze event that triggered them.
    const correlationId = typeof parsed['correlation_id'] === 'string' ? parsed['correlation_id'] : undefined;

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

    // ── C2: device_id + anon_id (brain_anon_id) — medium-tier RESOLUTION INPUTS ──
    // These let an anonymous device/session adopt an already-known brain_id (resolve-only,
    // never a merge key — see IdentityResolver §3b). brain_anon_id is the pixel's stable
    // anonymous id (payload.properties.brain_anon_id); device_id is an optional stable device id.
    const rawDeviceId = typeof props['device_id'] === 'string' ? props['device_id'] :
                        typeof props['$device_id'] === 'string' ? props['$device_id'] : null;
    const rawAnonId = typeof props['brain_anon_id'] === 'string' ? props['brain_anon_id'] :
                     typeof props['anon_id'] === 'string' ? props['anon_id'] : null;

    // ── PROB weak signals — tier='weak', RESOLVE-ONLY (consumed ONLY by the ProbabilisticMatcher) ──
    // MUST stay byte-identical to extract-identifiers.ts buildIdentifiers (the OPERATOR replay path).
    // These are NEVER merge keys and are IGNORED by the deterministic resolver below; they exist so a
    // later rule-based, review-gated probabilistic match can ROUTE TO REVIEW (never auto-merge).
    const firstString = (obj: Record<string, unknown>, keys: string[]): string | null => {
      for (const k of keys) {
        const v = obj[k];
        if (typeof v === 'string' && v.trim().length > 0) return v;
      }
      return null;
    };
    const deviceCtx = (props['device'] as Record<string, unknown>) ?? {};
    const rawCookieId = firstString(props, ['cookie_id', '$cookie_id', 'cookie']) ?? firstString(deviceCtx, ['cookie_id']);
    const rawIp = firstString(props, ['ip', 'ip_address', 'client_ip', '$ip']) ?? firstString(deviceCtx, ['ip', 'ip_address']);
    const rawDeviceFingerprint =
      firstString(props, ['device_fingerprint', '$device_fingerprint', 'fingerprint']) ?? firstString(deviceCtx, ['fingerprint', 'device_fingerprint']);
    const rawSessionId = firstString(props, ['session_id', '$session_id']) ?? firstString(deviceCtx, ['session_id']);

    // ── SECONDARY EXTRACTION: connector-pre-hashed-identity ─────────────────────
    // Connector order/checkout events (Shopify / WooCommerce / Shopflo) may carry identifiers
    // that the upstream platform already hashed before delivery.  Re-hashing would produce a
    // different 64-hex value than the one written by a first-party Pixel or storefront event
    // for the same customer → two identity_link rows → split brain_id → LTV/CAC gap.
    //
    // We read ALREADY-HASHED values from properties under these standardised field names:
    //   hashed_customer_email  / customer_email_hash  — 64-hex SHA-256 of normalised email
    //   hashed_customer_phone  / customer_phone_hash  — 64-hex SHA-256 of normalised phone
    // AND from the CanonicalEvent contract's optional `pre_hashed_identifiers` map (the preferred
    // path for new mappers — see CanonicalPreHashedIdentifiers in @brain/connector-core).
    //
    // Validation: we accept ONLY well-formed 64 lowercase hex chars. Anything else is ignored
    // (fail-safe: it falls back to the raw-value path above if the raw value is also present,
    // or is silently dropped if there is no raw value either — no crash, no double-hash).
    //
    // Security: pre-hashed values are stored under identifier_type 'pre_hashed_email' /
    // 'pre_hashed_phone' — a DISTINCT NAMESPACE from the salted first-party hashes
    // (identifier_type 'email' / 'phone').  The two namespaces NEVER collide in identity_link,
    // so a pre-hashed connector event can stitch to a later raw-email storefront event only when
    // the SAME brain_id already holds BOTH the pre_hashed_email and the email link (written by
    // the connector and pixel paths respectively).  This is exactly the continuity repair needed.
    //
    // rawValue is ALWAYS undefined for pre-hashed ids — there is no plaintext PII to vault.
    const PRE_HASHED_REGEX = /^[0-9a-f]{64}$/;

    // Read from properties (legacy field names used by existing connectors)
    const rawPreHashedEmail: string | null = (() => {
      for (const key of ['hashed_customer_email', 'customer_email_hash']) {
        const v = props[key];
        if (typeof v === 'string' && PRE_HASHED_REGEX.test(v)) return v;
      }
      return null;
    })();

    const rawPreHashedPhone: string | null = (() => {
      for (const key of ['hashed_customer_phone', 'customer_phone_hash']) {
        const v = props[key];
        if (typeof v === 'string' && PRE_HASHED_REGEX.test(v)) return v;
      }
      return null;
    })();

    // Read from the CanonicalEvent's `pre_hashed_identifiers` map (preferred path for new mappers)
    const canonicalPreHashed = (payload['pre_hashed_identifiers'] as Record<string, unknown>) ?? null;
    const canonicalPreHashedEmail: string | null = (() => {
      if (!canonicalPreHashed) return null;
      const v = canonicalPreHashed['hashed_customer_email'];
      return typeof v === 'string' && PRE_HASHED_REGEX.test(v) ? v : null;
    })();
    const canonicalPreHashedPhone: string | null = (() => {
      if (!canonicalPreHashed) return null;
      const v = canonicalPreHashed['hashed_customer_phone'];
      return typeof v === 'string' && PRE_HASHED_REGEX.test(v) ? v : null;
    })();

    // Merge: canonical path wins over legacy properties path for the same type
    const preHashedEmail = canonicalPreHashedEmail ?? rawPreHashedEmail;
    const preHashedPhone = canonicalPreHashedPhone ?? rawPreHashedPhone;

    if (!rawEmail && !rawPhone && !storefrontCustomerId && !rawDeviceId && !rawAnonId
        && !preHashedEmail && !preHashedPhone
        && !rawCookieId && !rawIp && !rawDeviceFingerprint && !rawSessionId) {
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

    // ── C2: device_id (medium) — hashed as a stable device id (trim-normalized like external_id) ──
    if (rawDeviceId) {
      const hash = hashIdentifier(rawDeviceId, 'device_id', saltHex, regionCode);
      identifiers.push({
        type: 'device_id',
        hash,
        tier: 'medium',     // resolve-only, never a merge key (IdentityResolver §3b)
        confidence: 'low',
        rawValue: undefined, // not PII
      });
    }

    // ── C2: anon_id / brain_anon_id (medium) — the pixel's stable anonymous id ──
    // Normalized as external_id (trim) and hashed with the per-brand salt — same wire format as
    // every other identifier, so a device/anon session resolves to the SAME hash on every event.
    if (rawAnonId) {
      const normalized = normalizeIdentifier(rawAnonId, 'external_id', regionCode);
      const hash = hashIdentifier(normalized, 'external_id', saltHex, regionCode);
      identifiers.push({
        type: 'anon_id',
        hash,
        tier: 'medium',     // resolve-only, never a merge key (IdentityResolver §3b)
        confidence: 'low',
        rawValue: undefined, // not PII
      });
    }

    // ── connector-pre-hashed-identity: ALREADY-HASHED identifiers (STRONG, tier='strong') ────
    // These come from connector order/checkout events where the upstream platform already hashed
    // the PII before delivering the webhook.  The hash is accepted AS-IS (preHashed: true) — no
    // per-brand salt is applied and no re-hashing occurs.  They live in a distinct
    // identifier_type namespace ('pre_hashed_email' / 'pre_hashed_phone') in identity_link so
    // they coexist safely with salted first-party hashes without collision.
    //
    // NOTE: the salt fetch above is still required (it may be used by other identifier types on
    // this same event).  For a pure pre-hashed event (no raw identifiers) the salt is fetched
    // but not applied to the pre-hashed values — that is intentional and correct.
    if (preHashedEmail) {
      identifiers.push({
        type: 'pre_hashed_email',
        hash: preHashedEmail,  // already the final 64-hex value — no further hashing
        tier: 'strong',
        confidence: 'high',
        rawValue: undefined,   // no plaintext PII — cannot write to contact_pii vault
        preHashed: true,
      });
    }

    if (preHashedPhone) {
      identifiers.push({
        type: 'pre_hashed_phone',
        hash: preHashedPhone,  // already the final 64-hex value — no further hashing
        tier: 'strong',
        confidence: 'high',
        rawValue: undefined,   // no plaintext PII — cannot write to contact_pii vault
        preHashed: true,
      });
    }

    // ── PROB weak signals (tier='weak', confidence='low', RESOLVE-ONLY) ──
    // Hashed with the per-brand salt (external_id = trim) like every other identifier. The
    // deterministic resolver below IGNORES tier='weak' entirely (no merge, no adoption) — these feed
    // ONLY the rule-based ProbabilisticMatcher, which can never auto-merge (routes to review).
    for (const [type, raw] of [
      ['device_fingerprint', rawDeviceFingerprint],
      ['cookie_id', rawCookieId],
      ['session_id', rawSessionId],
      ['ip', rawIp],
    ] as const) {
      if (!raw) continue;
      const normalized = normalizeIdentifier(raw, 'external_id', regionCode);
      const hash = hashIdentifier(normalized, 'external_id', saltHex, regionCode);
      identifiers.push({ type, hash, tier: 'weak', confidence: 'low', rawValue: undefined });
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

    // ── 6. Write to the identity SoR (Neo4j — ADR-0004) + the PG audit/contact_pii records ──────
    await this.identityRepo.writeOutcome(brandId, outcome, identifiers);

    // ── 7. Publish the identity.* outcome events AFTER the graph write (commit-after-write) ──────
    // The publisher is fail-open (a Kafka blip never throws here) and emits deterministic event_ids,
    // so a genuine reprocess re-emits identical, dedupable events. Skipped entirely when unwired.
    if (this.identityEventPublisher) {
      const events = buildIdentityEvents(brandId, outcome, identifiers);
      if (events.length > 0) {
        await this.identityEventPublisher.publish(brandId, events, {
          correlationId,
          causationId: eventId,
        });
      }
    }

    return {
      outcome: outcome.action,
      brainId: outcome.brainId,
      brandId,
      eventId,
    };
  }
}
