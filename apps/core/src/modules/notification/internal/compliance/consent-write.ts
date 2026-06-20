/**
 * Consent write path — operator/API-sourced consent grant + withdrawal.
 *
 * The collector path (consent_flags on CollectorEventV1) is projected by the
 * stream-worker ConsentSuppressorConsumer. THIS path is the non-collector source:
 * an operator action or an authenticated API call recording a consent grant or a
 * withdrawal (a tombstone). Both write to the same SoR (consent_record /
 * consent_tombstone, migration 0032), brand-GUC scoped, append-only, and audited.
 *
 * PII: the caller supplies the RAW recipient; we hash it HERE via identity-core and
 * persist ONLY the subject_hash. Raw email/phone never reaches a column, a log, or
 * the audit payload.
 *
 * Append-only: a withdrawal does NOT update or delete the grant row — it inserts a
 * withdrawal consent_record AND a consent_tombstone (the tombstone drives fast-path
 * suppression). A later re-grant is a new consent_record with a later effective_at.
 */

import type { DbClient, QueryContext } from '@brain/db';
import type { ConsentCategory } from '@brain/contracts';
import type { AuditWriter } from '@brain/audit';
import { hashIdentifier } from '@brain/identity-core';
import type { SaltPort } from './ports.js';
import { identifierTypeForChannel, type ContactChannel } from './contact-types.js';

export type ConsentSource = 'operator' | 'api';
export type WithdrawReason = 'withdrawal' | 'erasure';

export interface ConsentWriteDeps {
  db: DbClient;
  salt: SaltPort;
  audit: AuditWriter;
}

export interface GrantConsentInput {
  brandId: string;
  /** Raw recipient — hashed immediately; never stored raw. */
  recipient: string;
  /** Channel determines email vs phone normalization for the hash. */
  channel: ContactChannel;
  category: ConsentCategory;
  source: ConsentSource;
  policyVersion?: string;
  actorId: string | null;
  actorRole: string;
  correlationId: string;
  /** I-ST04 / T2-7: client-supplied idempotency key — recorded on the audit entry for safe retries. */
  idempotencyKey: string;
}

export interface WithdrawConsentInput {
  brandId: string;
  recipient: string;
  channel: ContactChannel;
  /** null = withdraw ALL marketing categories. */
  category: ConsentCategory | null;
  reason: WithdrawReason;
  source: ConsentSource;
  actorId: string | null;
  actorRole: string;
  correlationId: string;
  /** I-ST04 / T2-7: client-supplied idempotency key — recorded on the audit entry for safe retries. */
  idempotencyKey: string;
}

export class ConsentWriter {
  constructor(private readonly deps: ConsentWriteDeps) {}

  private async hash(
    brandId: string,
    recipient: string,
    channel: ContactChannel,
  ): Promise<string> {
    // Salt fetch failure HARD CRASHES (D-2) — never a silent default-salt hash.
    const saltHex = await this.deps.salt.saltHexForBrand(brandId);
    return hashIdentifier(recipient, identifierTypeForChannel(channel), saltHex);
  }

  /** Record a consent GRANT (append-only consent_record row). */
  async grant(input: GrantConsentInput): Promise<{ subjectHash: string }> {
    const subjectHash = await this.hash(
      input.brandId,
      input.recipient,
      input.channel,
    );
    const ctx: QueryContext = {
      brandId: input.brandId,
      correlationId: input.correlationId,
    };

    await this.deps.db.query(
      ctx,
      `INSERT INTO consent_record
         (brand_id, subject_hash, category, state, source, policy_version)
       VALUES ($1, $2, $3, 'granted', $4, $5)
       ON CONFLICT DO NOTHING`,
      [
        input.brandId,
        subjectHash,
        input.category,
        input.source,
        input.policyVersion ?? 'v1',
      ],
    );

    await this.deps.audit.append({
      brand_id: input.brandId,
      actor_id: input.actorId,
      actor_role: input.actorRole,
      action: 'consent.granted',
      entity_type: 'consent_record',
      entity_id: subjectHash,
      idempotency_key: input.idempotencyKey,
      payload: {
        category: input.category,
        source: input.source,
        policy_version: input.policyVersion ?? 'v1',
        subject_hash: subjectHash,
      },
    });

    return { subjectHash };
  }

  /**
   * Record a consent WITHDRAWAL: a withdrawal consent_record (append-only) AND a
   * consent_tombstone (drives fast-path suppression). category=null tombstones all.
   */
  async withdraw(input: WithdrawConsentInput): Promise<{ subjectHash: string }> {
    const subjectHash = await this.hash(
      input.brandId,
      input.recipient,
      input.channel,
    );
    const ctx: QueryContext = {
      brandId: input.brandId,
      correlationId: input.correlationId,
    };

    // Append a withdrawal consent_record for the specific category (when given).
    if (input.category !== null) {
      await this.deps.db.query(
        ctx,
        `INSERT INTO consent_record
           (brand_id, subject_hash, category, state, source)
         VALUES ($1, $2, $3, 'withdrawn', $4)
         ON CONFLICT DO NOTHING`,
        [input.brandId, subjectHash, input.category, input.source],
      );
    }

    // Append the tombstone (category NULL = all categories).
    await this.deps.db.query(
      ctx,
      `INSERT INTO consent_tombstone
         (brand_id, subject_hash, category, reason, source)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [
        input.brandId,
        subjectHash,
        input.category,
        input.reason,
        input.source,
      ],
    );

    await this.deps.audit.append({
      brand_id: input.brandId,
      actor_id: input.actorId,
      actor_role: input.actorRole,
      action: 'consent.withdrawn',
      entity_type: 'consent_record',
      entity_id: subjectHash,
      idempotency_key: input.idempotencyKey,
      payload: {
        category: input.category,
        reason: input.reason,
        source: input.source,
        subject_hash: subjectHash,
      },
    });

    return { subjectHash };
  }
}
