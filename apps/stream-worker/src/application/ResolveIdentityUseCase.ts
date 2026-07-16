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

import type { ConfidenceVerdict, IdentifierComboMember } from '@brain/contracts';
import { log } from '../log.js';
import { SaltProvider } from '../infrastructure/secrets/SaltProvider.js';
import type { IdentityStore } from '../domain/identity/IdentityStore.js';
import {
  IdentityResolver,
  RULE_VERSION,
  DEFAULT_IDENTITY_PRIORITY,
  type IdentityPriorityConfig,
} from '../domain/identity/IdentityResolver.js';
import { extractEventIdentifiers } from './extract-event-identifiers.js';
import type { FlagService } from '@brain/platform-flags';
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
    /**
     * SPEC: A.1.5 (WA-12) — per-brand feature-flag service gating the ordered identity-priority path.
     * OPTIONAL + fail-closed: when absent (tests / not wired) the flag reads OFF and the legacy
     * fixed-tier resolver runs byte-identically. When present, `identity.priority_config` (default OFF)
     * decides whether resolution walks the brand's ordered priority config. A flag read NEVER throws.
     */
    private readonly flags?: FlagService,
  ) {}

  /**
   * Process a single Bronze event: extract identifiers, resolve brain_id, write.
   *
   * @param rawValue  Kafka message value (Buffer).
   * @param _now      Current ISO-8601 timestamp (for audit; not used in hash).
   */
  async execute(rawValue: Buffer | null, _now: string): Promise<ResolveResult> {
    // ── 1–3. Parse → extract → normalize → hash (the SHARED front-half — GAP-A batched backfill) ──
    // Factored verbatim into extractEventIdentifiers so the batch path hashes byte-identically to
    // this live path (one extraction implementation; zero drift). Same early-return semantics.
    const extracted = await extractEventIdentifiers(rawValue, this.saltProvider);
    if (extracted.status === 'invalid') {
      return { outcome: 'invalid', reason: extracted.reason };
    }
    if (extracted.status === 'no_identifiers') {
      return { outcome: 'no_identifiers', brandId: extracted.brandId, eventId: extracted.eventId };
    }
    const { brandId, eventId, correlationId, identifiers } = extracted;

    // ── 4. Read pre-resolution state ─────────────────────────────────────────
    const idHashes = identifiers.map((i) => ({ type: i.type, hash: i.hash }));
    const state = await this.identityRepo.readState(brandId, idHashes);

    // ── 4b. SPEC A.1.5 (WA-12): per-brand ORDERED priority config (flag-gated, default OFF) ──────
    // Only when `identity.priority_config` is ON for this brand do we read the versioned config and
    // switch the resolver onto its ordered-priority decision. Flag OFF (or unwired / store lacks the
    // reader / flag read errors → fail-closed false) ⇒ priorityConfig stays undefined ⇒ the legacy
    // fixed-tier union-find runs byte-identically. The read errors are swallowed (fail-open to legacy).
    let priorityConfig: IdentityPriorityConfig | undefined;
    if (this.flags && this.identityRepo.readPriorityConfig) {
      let enabled = false;
      try {
        enabled = await this.flags.isFlagEnabled(brandId, 'identity.priority_config');
      } catch {
        enabled = false; // fail-closed — never block resolution on a flag read.
      }
      if (enabled) {
        try {
          priorityConfig =
            (await this.identityRepo.readPriorityConfig(brandId)) ??
            { version: 0, order: DEFAULT_IDENTITY_PRIORITY };
        } catch (err) {
          // Fail-open to the legacy path: a config-read blip must not lose the resolution.
          priorityConfig = undefined;
          log.warn(
            `[identity] priority-config read failed (fail-open to fixed-tier): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }

    // ── 4c. SPEC A.2.3.4 (WA-16): shared-device guard (flag-gated, default OFF) ───────────────────
    // When `identity.shared_device_guard` is ON for this brand, thread the strong-ownership signal so the
    // resolver refuses to fold a NEW strong id into an anon's already-strong-owned brain (two family members
    // on one device stay separate brains → stitch surfaces the conflict). Flag OFF (or read error →
    // fail-closed) ⇒ undefined ⇒ the resolver's guard is inert, adoption byte-identical to the legacy path.
    let strongOwnedBrainIds: Set<string> | undefined;
    if (this.flags) {
      let guardOn = false;
      try {
        guardOn = await this.flags.isFlagEnabled(brandId, 'identity.shared_device_guard');
      } catch {
        guardOn = false; // fail-closed — never block resolution on a flag read.
      }
      if (guardOn) strongOwnedBrainIds = state.strongOwnedBrainIds;
    }

    // ── 5. Resolve ────────────────────────────────────────────────────────────
    const outcome = this.resolver.resolve(
      brandId,
      identifiers,
      state.existingLinks,
      state.sharedUtilityMap,
      state.phoneCount,
      state.brandConfig,
      state.aliasChain,
      undefined,             // now → resolver default (unchanged for the legacy path)
      priorityConfig,        // A.1.5: undefined unless the flag is ON (byte-identical when absent)
      strongOwnedBrainIds,   // A.2.3.4: undefined unless the shared-device-guard flag is ON
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
