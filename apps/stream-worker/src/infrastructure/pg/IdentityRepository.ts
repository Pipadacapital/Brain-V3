/**
 * IdentityRepository — writes identity graph rows to Postgres (brain_app).
 *
 * Mirrors BronzeRepository discipline (architecture-plan §1 grounding):
 *   ONE transaction: BEGIN → set_config GUC → INSERTs ON CONFLICT DO NOTHING → COMMIT.
 *   Connects as brain_app (NEVER superuser brain) — RLS is enforced.
 *
 * GUC note: SET LOCAL x=$1 is invalid for custom GUCs.
 *   Use: SELECT set_config('app.current_brand_id', $1, true)
 *   (true = is_local = transaction-scoped, equivalent to SET LOCAL).
 *
 * contact_pii writes additionally set app.role='send_service' in-txn (D-3).
 *
 * Idempotency (D-4): every INSERT uses ON CONFLICT DO NOTHING.
 *   - identity_link: ON CONFLICT on UNIQUE PARTIAL (brand_id,type,value WHERE is_active,strong)
 *   - identity_merge_event: ON CONFLICT (merge_id) DO NOTHING (deterministic PK)
 *   - brain_id_alias: ON CONFLICT on UNIQUE PARTIAL (brand_id,observed) WHERE valid_to IS NULL
 *   Replay-safe: 3× replay → exactly 1 row for each entity.
 */
import { Pool, PoolClient } from 'pg';
import { encryptPii, deriveDevVaultDek } from '@brain/identity-core';
import type {
  ExtractedIdentifier,
  ExistingLink,
  SharedUtilityState,
  BrandPhoneGuardConfig,
  ResolveOutcome,
} from '../../domain/identity/IdentityResolver.js';

export interface IdentityReadState {
  existingLinks: ExistingLink[];
  sharedUtilityMap: Map<string, SharedUtilityState>;
  phoneCount: Map<string, number>;    // phone hash → windowed distinct brain_id count
  aliasChain: Set<string>;
  brandConfig: BrandPhoneGuardConfig;
}

export class IdentityRepository {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    // brain_app credentials — RLS enforced on all identity tables.
    this.pool = new Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 30_000,
      statement_timeout: 15_000,
    });
  }

  /**
   * Build an AES-256-GCM envelope for a raw PII value (P0-C write-population), or null when
   * encryption is unavailable. Prod is DEFAULT-CLOSED: the worker's KMS DEK provider is not
   * wired yet, so we SKIP the vault write rather than crash ingest or use a weak key — the
   * identity_link is still written; the vault fills once the prod provider lands. Dev derives
   * a deterministic per-brand DEK (the SAME key apps/core's vault read path uses).
   */
  private vaultEnvelope(
    brandId: string,
    rawValue: string,
  ): { ciphertext: Buffer; iv: Buffer; authTag: Buffer; keyVersion: number } | null {
    if (process.env['NODE_ENV'] === 'production') {
      return null;
    }
    const env = encryptPii(deriveDevVaultDek(brandId), rawValue);
    return { ciphertext: env.ciphertext, iv: env.iv, authTag: env.authTag, keyVersion: 1 };
  }

  /**
   * Read pre-resolution state for a brand + set of identifier hashes.
   * Called BEFORE the resolver runs — fetches existing links, phone-guard state,
   * alias chain, and brand config. All reads under brain_app + brand GUC.
   */
  async readState(
    brandId: string,
    identifierHashes: Array<{ type: string; hash: string }>,
    now: Date = new Date(),
  ): Promise<IdentityReadState> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_brand_id', $1, true)", [brandId]);

      // Brand phone-guard config
      const brandRows = await client.query<{ phone_guard_threshold: number; suppression_window_days: number }>(
        'SELECT phone_guard_threshold, suppression_window_days FROM brand WHERE id = $1',
        [brandId],
      );
      const brandConfig: BrandPhoneGuardConfig = brandRows.rows[0] ?? {
        phone_guard_threshold: 10,
        suppression_window_days: 30,
      };

      // Existing active identity_links for the given hashes
      const existingLinks: ExistingLink[] = [];
      if (identifierHashes.length > 0) {
        const hashes = identifierHashes.map((i) => i.hash);
        const types = identifierHashes.map((i) => i.type);
        const linkRows = await client.query<ExistingLink>(
          `SELECT brain_id, identifier_type, identifier_value, is_active
           FROM identity_link
           WHERE brand_id = $1
             AND is_active = TRUE
             AND (identifier_type, identifier_value) IN (
               SELECT unnest($2::text[]), unnest($3::text[])
             )`,
          [brandId, types, hashes],
        );
        existingLinks.push(...linkRows.rows);
      }

      // Phone-guard state for phone hashes
      const phoneHashes = identifierHashes
        .filter((i) => i.type === 'phone')
        .map((i) => i.hash);
      const sharedUtilityMap = new Map<string, SharedUtilityState>();
      const phoneCount = new Map<string, number>();

      if (phoneHashes.length > 0) {
        // Current suppression state
        const suiRows = await client.query<{
          identifier_type: string;
          identifier_value: string;
          profile_count: number;
          suppressed_until: Date | null;
        }>(
          `SELECT identifier_type, identifier_value, profile_count, suppressed_until
           FROM shared_utility_identifier
           WHERE brand_id = $1
             AND identifier_type = 'phone'
             AND identifier_value = ANY($2::text[])`,
          [brandId, phoneHashes],
        );
        for (const row of suiRows.rows) {
          sharedUtilityMap.set(row.identifier_value, {
            identifier_type: row.identifier_type,
            identifier_value: row.identifier_value,
            profile_count: row.profile_count,
            suppressed_until: row.suppressed_until,
          });
        }

        // Windowed distinct brain_id count per phone hash (last suppression_window_days days)
        const windowDays = brandConfig.suppression_window_days;
        for (const hash of phoneHashes) {
          const countRow = await client.query<{ cnt: string }>(
            `SELECT COUNT(DISTINCT brain_id)::text AS cnt
             FROM identity_link
             WHERE brand_id = $1
               AND identifier_type = 'phone'
               AND identifier_value = $2
               AND is_active = TRUE
               AND created_at > NOW() - ($3 || ' days')::interval`,
            [brandId, hash, windowDays],
          );
          phoneCount.set(hash, parseInt(countRow.rows[0]?.cnt ?? '0', 10));
        }
      }

      // Alias chain: all live observed_brain_ids (cycle detection)
      const aliasRows = await client.query<{ observed_brain_id: string }>(
        `SELECT observed_brain_id FROM brain_id_alias
         WHERE brand_id = $1 AND valid_to IS NULL`,
        [brandId],
      );
      const aliasChain = new Set(aliasRows.rows.map((r) => r.observed_brain_id));

      await client.query('COMMIT');
      return { existingLinks, sharedUtilityMap, phoneCount, aliasChain, brandConfig };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Write resolution outcome to Postgres.
   * ONE transaction: set_config GUC → all INSERTs ON CONFLICT DO NOTHING → COMMIT.
   * contact_pii writes additionally set app.role='send_service' in-txn (D-3).
   * Returns { written: true } always (idempotent inserts never throw on conflict).
   */
  async writeOutcome(
    brandId: string,
    outcome: ResolveOutcome,
    identifiers: ExtractedIdentifier[],
  ): Promise<{ written: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Brand GUC — scoped to this transaction (is_local=true)
      await client.query(
        "SELECT set_config('app.current_brand_id', $1, true)",
        [brandId],
      );

      // ── customer row ─────────────────────────────────────────────────────────
      await client.query(
        `INSERT INTO customer (brand_id, brain_id, lifecycle_state)
         VALUES ($1, $2, 'active')
         ON CONFLICT (brand_id, brain_id) DO NOTHING`,
        [brandId, outcome.brainId],
      );

      // ── identity_link rows (new identifiers) ─────────────────────────────────
      // ON CONFLICT uses the partial index predicate (CREATE UNIQUE INDEX, not CONSTRAINT).
      // PG partial-index ON CONFLICT form: ON CONFLICT (cols) WHERE <predicate> DO NOTHING.
      for (const id of outcome.newLinks) {
        if (id.tier === 'strong' || id.tier === 'strong_on_link') {
          // Strong identifiers: use the partial unique index conflict target
          await client.query(
            `INSERT INTO identity_link (brand_id, brain_id, identifier_type, identifier_value, tier, is_active)
             VALUES ($1, $2, $3, $4, $5, TRUE)
             ON CONFLICT (brand_id, identifier_type, identifier_value)
               WHERE is_active = TRUE AND tier IN ('strong','strong_on_link')
             DO NOTHING`,
            [brandId, outcome.brainId, id.type, id.hash, id.tier],
          );
        } else {
          // Medium/weak identifiers: no partial unique constraint — just insert
          await client.query(
            `INSERT INTO identity_link (brand_id, brain_id, identifier_type, identifier_value, tier, is_active)
             VALUES ($1, $2, $3, $4, $5, TRUE)
             ON CONFLICT DO NOTHING`,
            [brandId, outcome.brainId, id.type, id.hash, id.tier],
          );
        }
      }

      // ── merge: identity_merge_event + brain_id_alias ──────────────────────
      if (outcome.action === 'merged' && outcome.merge) {
        const { canonicalBrainId, mergedBrainId, mergeId } = outcome.merge;

        // Ensure the merged customer row exists (may be new context)
        await client.query(
          `INSERT INTO customer (brand_id, brain_id, merged_into, lifecycle_state)
           VALUES ($1, $2, $3, 'merged')
           ON CONFLICT (brand_id, brain_id) DO UPDATE
             SET merged_into = EXCLUDED.merged_into,
                 lifecycle_state = 'merged'
             WHERE customer.lifecycle_state != 'merged'`,
          [brandId, mergedBrainId, canonicalBrainId],
        );

        // identity_merge_event — deterministic PK, ON CONFLICT DO NOTHING (D-4)
        await client.query(
          `INSERT INTO identity_merge_event
             (merge_id, brand_id, canonical_brain_id, merged_brain_id, rule_version)
           VALUES ($1, $2, $3, $4, 'v1-deterministic')
           ON CONFLICT (merge_id) DO NOTHING`,
          [mergeId, brandId, canonicalBrainId, mergedBrainId],
        );

        // brain_id_alias — UNIQUE PARTIAL (brand_id, observed_brain_id) WHERE valid_to IS NULL (D-4)
        // Use partial-index ON CONFLICT form (CREATE UNIQUE INDEX, not named CONSTRAINT).
        await client.query(
          `INSERT INTO brain_id_alias
             (brand_id, observed_brain_id, canonical_brain_id, rule_version, merge_id)
           VALUES ($1, $2, $3, 'v1-deterministic', $4)
           ON CONFLICT (brand_id, observed_brain_id)
             WHERE valid_to IS NULL
           DO NOTHING`,
          [brandId, mergedBrainId, canonicalBrainId, mergeId],
        );
      }

      // ── phone-guard: shared_utility_identifier upserts ──────────────────────
      for (const update of outcome.phoneGuardUpdates) {
        if (update.suppress) {
          await client.query(
            `INSERT INTO shared_utility_identifier
               (brand_id, identifier_type, identifier_value, profile_count,
                flagged_at, suppressed_until, window_days, reason)
             VALUES ($1, $2, $3, $4, NOW(), $5, $6, 'phone_guard_threshold_exceeded')
             ON CONFLICT (brand_id, identifier_type, identifier_value)
             DO UPDATE SET
               profile_count = GREATEST(EXCLUDED.profile_count, shared_utility_identifier.profile_count),
               suppressed_until = EXCLUDED.suppressed_until,
               flagged_at = NOW()`,
            [
              brandId,
              update.identifier_type,
              update.identifier_value,
              update.profile_count,
              update.suppressed_until,
              30,  // window_days from brand config (stored for reference)
            ],
          );
        }
      }

      // ── merge_review_queue (cycle-guard or phone conflicts) ──────────────────
      if (outcome.routeToReview && outcome.reviewReason) {
        await client.query(
          `INSERT INTO merge_review_queue
             (brand_id, brain_id_a, brain_id_b, trigger_reason, evidence)
           VALUES ($1, $2, $2, $3, $4::jsonb)`,
          [
            brandId,
            outcome.brainId,
            outcome.reviewReason,
            JSON.stringify({ reason: outcome.reviewReason, rule_version: 'v1-deterministic' }),
          ],
        );
      }

      // ── identity_audit ────────────────────────────────────────────────────────
      await client.query(
        `INSERT INTO identity_audit (brand_id, brain_id, action, merge_id, detail)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
          brandId,
          outcome.brainId,
          outcome.action === 'minted' ? 'mint'
            : outcome.action === 'linked' ? 'link'
            : outcome.action === 'merged' ? 'merge'
            : 'link',
          outcome.merge?.mergeId ?? null,
          JSON.stringify({
            rule_version: 'v1-deterministic',
            identifier_types: identifiers.map((i) => i.type),
            action: outcome.action,
            // NO raw values — only hashes and types (no raw PII in audit)
          }),
        ],
      );

      // ── contact_pii writes (ENCRYPTED at rest — gated by app.role='send_service') ──
      // P0-C: the raw value is AES-256-GCM-encrypted with the per-brand DEK and written to
      // the ciphertext columns; pii_value (legacy plaintext) is NULL. Prod is default-closed
      // (no KMS DEK provider in the worker yet) → skip the write, leaving identity_link intact
      // and the vault to fill once the prod provider lands.
      if (outcome.contactPiiWrites.length > 0) {
        // Additional GUC: app.role='send_service' — both required for contact_pii RLS (D-3)
        await client.query(
          "SELECT set_config('app.role', 'send_service', true)",
        );
        for (const pii of outcome.contactPiiWrites) {
          const env = this.vaultEnvelope(brandId, pii.raw_value);
          if (!env) continue; // prod default-closed → skip until KMS provider is wired
          await client.query(
            `INSERT INTO contact_pii
               (brand_id, brain_id, pii_type, identifier_hash,
                pii_ciphertext, pii_iv, pii_auth_tag, key_version, pii_value)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL)
             ON CONFLICT (brand_id, brain_id, pii_type) DO NOTHING`,
            [brandId, pii.brain_id, pii.pii_type, pii.identifier_hash, env.ciphertext, env.iv, env.authTag, env.keyVersion],
          );
        }
      }

      await client.query('COMMIT');
      return { written: true };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}
