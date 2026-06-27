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
import type { ConfidenceVerdict, IdentifierComboMember } from '@brain/contracts';
import { log } from '../log.js';
import { SaltProvider } from '../infrastructure/secrets/SaltProvider.js';
import type { IdentityStore } from '../domain/identity/IdentityStore.js';
import {
  IdentityResolver,
  ExtractedIdentifier,
  RULE_VERSION,
} from '../domain/identity/IdentityResolver.js';
import {
  buildIdentityEvents,
  type IdentityEventPublisher,
} from '../domain/identity/IdentityEventPublisher.js';
import { ConfidenceEngine, gradeResolverOutcome } from '../domain/identity/confidence/index.js';
import { DecisionEngine } from '../domain/identity/decisions/DecisionEngine.js';
import type { DecisionLogRepository } from '../domain/identity/decisions/DecisionLogRepository.js';
import type { EvidenceStore } from '../domain/identity/decisions/EvidenceStore.js';
import { PROBABILISTIC_MATCHER_ID } from '../domain/identity/matchers/ProbabilisticMatcher.js';

/** The deterministic strong-key authority id — the verdict stamped on every committed graph edge. */
const DETERMINISTIC_MATCHER_ID = 'deterministic-union-find';

/**
 * The confidence/decision collaborators wired into the live resolve path. ALL OPTIONAL: when absent
 * the use-case runs exactly as before (deterministic resolve + graph write only) — the probabilistic
 * review gate is purely additive. The graph write stays FIRST (commit-after-write); a confidence or
 * review-write failure NEVER loses the deterministic graph write (every step here is fail-open).
 */
export interface ConfidenceReviewDeps {
  confidenceEngine: ConfidenceEngine;
  decisionEngine: DecisionEngine;
  decisionLog: DecisionLogRepository;
  evidenceStore: EvidenceStore;
}

/**
 * The deterministic verdict to STAMP on a committed graph edge. The founding identifiers of a
 * minted/linked customer (and every strong-key merge) are deterministically that customer's →
 * exact/100. A probabilistic verdict NEVER reaches this function (it routes to review, not commit).
 */
function deterministicEdgeVerdict(
  ruleVersion: string,
  combo: IdentifierComboMember[],
): ConfidenceVerdict {
  return {
    score: 100,
    band: 'exact',
    reasons: ['deterministic:strong_key'],
    matcher_id: DETERMINISTIC_MATCHER_ID,
    rule_version: ruleVersion,
    identifier_combo: combo,
  };
}

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
    /**
     * The confidence/decision layer that grades the resolution and ENFORCES the probabilistic
     * review gate (weak-signal agreement → route_to_review, NEVER auto-merge). Optional + fail-open:
     * when undefined the deterministic path is unchanged. Wired in the stream-worker composition root.
     */
    private readonly confidence?: ConfidenceReviewDeps,
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

    // ── 5b. Confidence + review gate (deterministic-first; fail-open) ────────────────────────────
    // BEFORE the graph write so the real verdict can be stamped on the edge. Everything here is a
    // pure assessment + a READ (weak-candidate fetch): if any of it throws we fall back to the
    // deterministic exact stamp and skip the review — the deterministic graph write below ALWAYS runs
    // (commit-after-write). A probabilistic weak-signal agreement maps to a route_to_review Command
    // (persisted after the write); it can NEVER auto-merge (band is sub-'exact' by construction).
    let edgeVerdict: ConfidenceVerdict | undefined;
    let reviewDecision: ReturnType<DecisionEngine['routeProbabilisticReview']> | undefined;
    let reviewVerdict: ConfidenceVerdict | undefined;
    let reviewCandidateBrainIds: string[] = [];

    if (this.confidence) {
      try {
        const { confidenceEngine, decisionEngine } = this.confidence;

        // Explicit weak-signal candidate fetch (the dedicated probabilistic surface). Only the event's
        // weak hashes, and ONLY when the deterministic resolver did NOT already auto-merge on a strong
        // key (a merge needs no probabilistic consultation — deterministic-first).
        const weakHashes =
          outcome.action !== 'merged'
            ? identifiers.filter((i) => i.tier === 'weak').map((i) => ({ type: i.type, hash: i.hash }))
            : [];
        const weakCandidates =
          weakHashes.length > 0 && this.identityRepo.findCandidatesByWeakSignals
            ? await this.identityRepo.findCandidatesByWeakSignals(brandId, weakHashes)
            : [];

        const assessed = gradeResolverOutcome(confidenceEngine, {
          brand_id: brandId,
          identifiers,
          existingLinks: state.existingLinks,
          weakCandidates,
          outcome,
        });

        if (
          outcome.action !== 'merged' &&
          assessed.matcher_id === PROBABILISTIC_MATCHER_ID &&
          !confidenceEngine.isMergeEligible(assessed)
        ) {
          // PROBABILISTIC weak-signal agreement → REVIEW (never merge). The graph edge keeps the
          // deterministic stamp (the mint/link itself is deterministic); the probabilistic verdict
          // only ever produces the review record.
          reviewCandidateBrainIds = [...new Set(weakCandidates.map((c) => c.brain_id))].filter(
            (b) => b && b !== outcome.brainId,
          );
          if (reviewCandidateBrainIds.length > 0) {
            reviewVerdict = assessed;
            reviewDecision = decisionEngine.routeProbabilisticReview({
              brand_id: brandId,
              rule_version: RULE_VERSION,
              decided_at: _now,
              subject_brain_id: outcome.brainId,
              candidate_brain_ids: reviewCandidateBrainIds,
              verdict: assessed,
            });
          }
          edgeVerdict = deterministicEdgeVerdict(RULE_VERSION, [...assessed.identifier_combo]);
        } else {
          // DETERMINISTIC verdict (exact strong/merge, or sub-exact 'medium' cross-device adoption).
          // A pure mint with no existing match grades 'none'/0 — its FOUNDING links are exact/100.
          edgeVerdict =
            assessed.band === 'none'
              ? deterministicEdgeVerdict(RULE_VERSION, [...assessed.identifier_combo])
              : assessed;
        }
      } catch (err) {
        // FAIL-OPEN: never block the deterministic graph write on a confidence error.
        edgeVerdict = undefined;
        reviewDecision = undefined;
        reviewVerdict = undefined;
        log.warn(
          `[identity] confidence/review assessment failed (fail-open, deterministic write proceeds): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // ── 6. Write to the identity SoR (Neo4j — ADR-0004) + the PG audit/contact_pii records ──────
    // FIRST write — commit-after-write. `edgeVerdict` (deterministic) is stamped on the committed
    // edges; undefined → the adapter's deterministic-exact fallback (back-compat).
    await this.identityRepo.writeOutcome(brandId, outcome, identifiers, edgeVerdict);

    // ── 6b. Persist the review-gated decision AFTER the graph write (fail-open) ──────────────────
    // The route_to_review Command + its evidence land additively in the Decision Log + Evidence Store
    // (identity_audit), and the pair is enqueued to the graph review queue. A failure here NEVER
    // unwinds the committed graph write (the deterministic resolution is already durable).
    if (reviewDecision && reviewVerdict && this.confidence) {
      const { decisionEngine, decisionLog, evidenceStore } = this.confidence;
      try {
        const evidence = decisionEngine.buildEvidence(reviewDecision, reviewVerdict, {
          matcher_version: reviewVerdict.rule_version,
          recorded_at: _now,
        });
        await evidenceStore.put(evidence);
        await decisionLog.append({
          decision_id: evidence.decision_id,
          brand_id: brandId,
          decision: reviewDecision,
          evidence_ref: evidence.decision_id,
          recorded_at: _now,
        });
        if (this.identityRepo.enqueueReview) {
          await this.identityRepo.enqueueReview(brandId, {
            review_id: reviewDecision.review_id,
            brain_id_a: reviewDecision.brain_id_a,
            brain_id_b: reviewDecision.brain_id_b,
            reason: reviewDecision.reason,
            evidence: {
              matcher_id: reviewVerdict.matcher_id,
              score: reviewVerdict.score,
              band: reviewVerdict.band,
              signals: reviewVerdict.reasons,
              identifier_combo: reviewVerdict.identifier_combo,
            },
          });
        }
        log.info(
          `[identity] probabilistic weak-signal match routed to review (NOT merged): review_id=${reviewDecision.review_id} band=${reviewVerdict.band} score=${reviewVerdict.score}`,
        );
      } catch (err) {
        log.warn(
          `[identity] review persistence failed (fail-open, graph write already committed): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

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
