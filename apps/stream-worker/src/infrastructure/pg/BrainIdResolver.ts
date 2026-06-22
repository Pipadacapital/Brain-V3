/**
 * BrainIdResolver — resolves an order's storefront_customer_id to its identity-resolved brain_id
 * (DB-AUDIT C2). The order ledger carried brain_id=NULL, so silver_customers (and CAC / cohorts /
 * Customer 360 / the feature history) were starved. Orders DO carry properties.storefront_customer_id,
 * and identity resolution already links it → brain_id (identity_link, type 'storefront_customer_id').
 * This resolver mirrors that hash EXACTLY (hashIdentifier as 'external_id' with the per-brand salt —
 * the same path ResolveIdentityUseCase uses) and looks the brain_id up, so the order-ledger write can
 * stamp it. brain_id is ledger METADATA (not a money value) — stamping it never affects money math.
 *
 * Best-effort by contract: a miss (customer not yet resolved / no storefront id) returns null and the
 * ledger row is written brain_id=NULL exactly as before — never a failure, never blocks the offset.
 */
import type { Pool } from 'pg';
import { hashIdentifier } from '@brain/identity-core';
import type { SaltProvider } from '../secrets/SaltProvider.js';

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export class BrainIdResolver {
  constructor(
    private readonly pool: Pool,
    private readonly saltProvider: SaltProvider,
  ) {}

  /**
   * Resolve brain_id for (brandId, storefrontCustomerId). Returns null when the id is absent, the
   * salt can't be fetched, or no active identity_link exists yet (race with the identity bridge —
   * acceptable: the row writes brain_id=NULL and a later order for the same customer resolves it).
   */
  async resolve(brandId: string, storefrontCustomerId: string | null, regionCode = 'IN'): Promise<string | null> {
    if (!storefrontCustomerId) return null;
    let saltHex: string;
    try {
      saltHex = await this.saltProvider.saltHexForBrand(brandId);
    } catch {
      return null; // salt unavailable → best-effort miss (never throw on the ledger path)
    }
    // SAME hash the identity resolver computes for a storefront id (normalize+hash as 'external_id').
    const hash = hashIdentifier(storefrontCustomerId, 'external_id', saltHex, regionCode);

    const client = await this.pool.connect();
    try {
      // Wrap in a txn so the txn-local brand GUC holds for the SELECT (identity_link FORCE RLS, NN-1 —
      // brain_app, never superuser). Without BEGIN, each query auto-commits and is_local is lost.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_brand_id', $1, true),
                                 set_config('app.current_user_id', $2, true),
                                 set_config('app.current_workspace_id', $2, true)`, [brandId, NIL_UUID]);
      const res = await client.query<{ brain_id: string }>(
        `SELECT brain_id FROM identity.identity_link
          WHERE brand_id = $1 AND identifier_type = 'storefront_customer_id'
            AND identifier_value = $2 AND is_active = true
          LIMIT 1`,
        [brandId, hash],
      );
      await client.query('COMMIT');
      return res.rows[0]?.brain_id ?? null;
    } catch {
      await client.query('ROLLBACK').catch(() => undefined);
      return null; // best-effort
    } finally {
      client.release();
    }
  }
}
