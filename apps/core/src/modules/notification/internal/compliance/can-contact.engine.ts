/**
 * can_contact() compliance engine — the SOLE outbound send gate (I-ST05).
 *
 * Replaces the `return true` pass-through stub. Ordered, DEFAULT-CLOSED checks:
 * any step that cannot affirmatively resolve granted/approved/cleared/in-window
 * returns `block` (or `queue` for the window). There is NO code path where an
 * unknown yields `allow`.
 *
 * Order (each step short-circuits):
 *   1. Transactional exemption  — purpose==='transactional' → allow (TCCCPR carve-out).
 *                                  The ONLY allow-without-consent path.
 *   2. Hash recipient           — identity-core per-brand salt. Salt fetch failure =
 *                                  HARD CRASH (throw), never a silent allow (D-2).
 *   3. Consent                  — marketing category not suppressed; else block.
 *   4. DLT (phone channels)     — template approved; else block (default-closed stub).
 *   5. NCPR/DND (phone channels)— not on DND; 'unknown' → block (fail-closed stub).
 *   6. Send-window (9–9 IST)    — in-window → allow; out-of-window → queue_pending_window
 *                                  (release at next 09:00 IST); unparseable → block.
 *
 * The engine is pure orchestration over policies/ports — the business rules live in
 * the policies (send-window) and the fail-closed ports (suppression / DLT / NCPR).
 */

import { hashIdentifier } from '@brain/identity-core';
import type {
  SuppressionQuery,
  DltRegistryPort,
  NcprRegistryPort,
  SaltPort,
} from './ports.js';
import {
  type ContactChannel,
  type ContactPurpose,
  type CanContactResult,
  gatingCategoryForPurpose,
  identifierTypeForChannel,
  isPhoneChannel,
} from './contact-types.js';
import { evaluateSendWindow } from './policies/send-window.policy.js';
import { evaluateConsent } from './policies/consent.policy.js';
import { evaluateDlt } from './policies/dlt.policy.js';
import { evaluateNcpr } from './policies/ncpr.policy.js';

export interface CanContactDeps {
  salt: SaltPort;
  suppression: SuppressionQuery;
  dlt: DltRegistryPort;
  ncpr: NcprRegistryPort;
  /** Injectable clock for deterministic window tests. Defaults to real now(). */
  now?: () => Date;
}

export interface CanContactInput {
  brandId: string;
  /** Raw recipient (email/phone). Hashed immediately; NEVER stored/logged raw. */
  recipient: string;
  channel: ContactChannel;
  purpose: ContactPurpose;
  /** Optional DLT template id for phone channels. */
  templateId?: string;
  /**
   * An ALREADY-RESOLVED 64-hex identity-core subject_hash (Phase 6 / capi_meta).
   * When present, Step 2 (hash recipient) is skipped and the consent decision is
   * keyed on this hash directly — for paths where the subject is identified by an
   * order/identity reference, not a raw recipient string. `recipient` is then a
   * non-PII placeholder. The hash MUST be a 64-hex identity-core hash.
   */
  precomputedSubjectHash?: string;
}

/**
 * The decision plus the computed subjectHash (so the caller can write a send_log /
 * audit row keyed on the hash WITHOUT re-hashing or ever touching the raw recipient).
 * subjectHash is null only for the transactional carve-out (no hashing performed).
 */
export interface CanContactDecision extends CanContactResult {
  subjectHash: string | null;
}

export class CanContactEngine {
  constructor(private readonly deps: CanContactDeps) {}

  async evaluate(input: CanContactInput): Promise<CanContactDecision> {
    const { brandId, recipient, channel, purpose } = input;

    // ── Step 1: Transactional exemption (TCCCPR carve-out) ────────────────────
    // The only allow-without-consent path. Withdrawal of MARKETING consent never
    // blocks a transactional send (COMPLIANCE.md). No hashing/lookup performed.
    if (purpose === 'transactional') {
      return {
        decision: 'allow',
        reason: 'transactional_exempt',
        subjectHash: null,
      };
    }

    // ── Step 2: Resolve the subject hash ──────────────────────────────────────
    // Either an already-resolved identity-core subject_hash (capi_meta / Phase 6,
    // keyed on an order's identity ref — no raw PII enters the gate), OR hash the
    // raw recipient here. Salt fetch / decode failure HARD CRASHES (D-2) —
    // propagated, never caught into a silent allow.
    let subjectHash: string;
    if (input.precomputedSubjectHash) {
      // Must be a 64-hex identity-core hash; never a raw recipient.
      if (!/^[0-9a-f]{64}$/.test(input.precomputedSubjectHash)) {
        throw new Error(
          '[can_contact] precomputedSubjectHash must be a 64-hex identity-core hash',
        );
      }
      subjectHash = input.precomputedSubjectHash;
    } else {
      const saltHex = await this.deps.salt.saltHexForBrand(brandId);
      const idType = identifierTypeForChannel(channel);
      subjectHash = hashIdentifier(recipient, idType, saltHex);
    }

    // ── Step 3: Consent (purpose-keyed category, fail-closed) ─────────────────
    // marketing purpose → marketing category; advertising purpose → advertising
    // category (Phase 6). Transactional never reaches here (Step 1 exempted it).
    const gatingCategory = gatingCategoryForPurpose(purpose);
    const supp = await this.deps.suppression.isSuppressed({
      brandId,
      subjectHash,
      category: gatingCategory,
    });
    const consent = evaluateConsent(supp);
    if (consent.blocked) {
      // no_consent / withdrawn / tombstoned → block. No row = blocked (default-closed).
      return { decision: 'block', reason: consent.reason, subjectHash };
    }

    // ── Step 4 & 5: DLT + NCPR (phone channels only) ──────────────────────────
    if (isPhoneChannel(channel)) {
      // Step 4: DLT template approval — default-closed stub blocks until real reg.
      const approved = await this.deps.dlt.isTemplateApproved({
        brandId,
        channel,
        templateId: input.templateId,
      });
      const dltOutcome = evaluateDlt(approved);
      if (dltOutcome.blocked) {
        return { decision: 'block', reason: dltOutcome.reason, subjectHash };
      }

      // Step 5: NCPR/DND — 'unknown' is fail-closed (do not contact).
      const dnd = await this.deps.ncpr.dndStatus({ brandId, subjectHash });
      const ncprOutcome = evaluateNcpr(dnd);
      if (ncprOutcome.blocked) {
        return { decision: 'block', reason: ncprOutcome.reason, subjectHash };
      }
      // not_on_dnd → fall through to the window check.
    }
    // Email channels skip DLT/NCPR (not telecom-registry channels) — documented.

    // ── Advertising short-circuit (Phase 6) ───────────────────────────────────
    // A CAPI conversion passback is a server-to-server MEASUREMENT signal to a
    // platform — NOT a "commercial communication to a person" at a time of day.
    // No human is contacted, so the 9–9 IST send-window does NOT apply. Once
    // consent clears, advertising is allowed regardless of the wall clock.
    // ASSUMPTION (unit-asserted, documented): if legal later requires windowing,
    // the window policy below slots back in by deleting this guard. Out-of-window
    // CAPI is NOT queued — it is allowed immediately (consent already cleared).
    if (purpose === 'advertising') {
      return { decision: 'allow', reason: 'allowed', subjectHash };
    }

    // ── Step 6: Send-window (9am–9pm IST), server-side ────────────────────────
    const now = this.deps.now ? this.deps.now() : new Date();
    const window = evaluateSendWindow(now);
    if (window.inWindow) {
      return { decision: 'allow', reason: 'allowed', subjectHash };
    }
    if (window.releaseAfter) {
      // Out of window → queue, never drop, never send late.
      return {
        decision: 'queue_pending_window',
        reason: 'out_of_window',
        releaseAfter: window.releaseAfter,
        subjectHash,
      };
    }
    // Unparseable clock → fail-closed block.
    return { decision: 'block', reason: 'unknown', subjectHash };
  }
}
