/**
 * PgConnectorInstanceRepository — Postgres-backed repository for connector_instance.
 *
 * All queries are brand-scoped via the QueryContext (sets app.current_brand_id GUC)
 * which combines with RLS to enforce tenant isolation (NN-1).
 *
 * NN-2: secret_ref is the only credential column — no token bytes are read/written.
 *
 * A1 (feat-connector-marketplace): extended to read/write health_state + safety_rating
 * (migration 0021_connector_health). Provider type widened from literal 'shopify' to string.
 *
 * Gap A (0091, data-driven-provider-discovery): SELECT includes connector_provider_config JSONB.
 * Gap B (0092, multi-account-per-provider): SELECT includes account_key; UPSERT ON CONFLICT
 * targets (brand_id, provider, account_key); findByBrandAndProvider returns first (back-compat);
 * findAllByBrandAndProvider returns all accounts.
 */
import type { DbPool, QueryContext } from '@brain/db';
import type { IConnectorInstanceRepository } from '../../domain/repositories/IConnectorInstanceRepository.js';
import { ConnectorInstance, DEFAULT_ACCOUNT_KEY } from '../../domain/entities/ConnectorInstance.js';
import type { ConnectorInstanceProps } from '../../domain/entities/ConnectorInstance.js';
import type { HealthState, SafetyRating } from '../../domain/entities/ConnectorInstance.js';

interface ConnectorInstanceRow {
  id: string;
  brand_id: string;
  provider: string;
  shop_domain: string;
  secret_ref: string;
  status: 'connected' | 'disconnected' | 'error';
  /** Added by migration 0021 (ADR-CM-5). Default 'Healthy' for all pre-0021 rows. */
  health_state: HealthState;
  /** Added by migration 0021 (ADR-CM-5). Default 'safe' for all pre-0021 rows. */
  safety_rating: SafetyRating;
  connected_at: Date;
  disconnected_at: Date | null;
  created_at: Date;
  updated_at: Date;
  /** Added by migration 0092 (Gap B). DEFAULT '__default__' in DB. */
  account_key: string;
  /** Added by migration 0091 (Gap A). NULL for legacy rows. */
  connector_provider_config: Record<string, string | null> | null;
  /** Added by migration 0106 (ad-account activation). NULL = not the chosen account. */
  activated_at: Date | null;
}

function rowToEntity(row: ConnectorInstanceRow): ConnectorInstance {
  return ConnectorInstance.create({
    id: row.id,
    brandId: row.brand_id,
    provider: row.provider,
    shopDomain: row.shop_domain,
    secretRef: row.secret_ref,
    status: row.status,
    healthState: row.health_state,
    safetyRating: row.safety_rating,
    connectedAt: new Date(row.connected_at),
    disconnectedAt: row.disconnected_at ? new Date(row.disconnected_at) : null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    accountKey: row.account_key ?? DEFAULT_ACCOUNT_KEY,
    providerConfig: row.connector_provider_config ?? {},
    activatedAt: row.activated_at ? new Date(row.activated_at) : null,
  } satisfies ConnectorInstanceProps);
}

const SELECT_COLS = `id, brand_id, provider, shop_domain, secret_ref, status,
  health_state, safety_rating, connected_at, disconnected_at, created_at, updated_at,
  account_key, connector_provider_config, activated_at`;

export class PgConnectorInstanceRepository implements IConnectorInstanceRepository {
  constructor(private readonly pool: DbPool) {}

  async findByBrandAndProvider(
    brandId: string,
    provider: string,
  ): Promise<ConnectorInstance | null> {
    const ctx: QueryContext = { brandId, correlationId: 'n/a' };
    const client = await this.pool.connect();
    try {
      const result = await client.query<ConnectorInstanceRow>(
        ctx,
        `SELECT ${SELECT_COLS}
         FROM connector_instance
         WHERE brand_id = $1 AND provider = $2
         ORDER BY created_at ASC
         LIMIT 1`,
        [brandId, provider],
      );
      const row = result.rows[0];
      return row ? rowToEntity(row) : null;
    } finally {
      client.release();
    }
  }

  async findById(id: string, brandId: string): Promise<ConnectorInstance | null> {
    const ctx: QueryContext = { brandId, correlationId: 'n/a' };
    const client = await this.pool.connect();
    try {
      const result = await client.query<ConnectorInstanceRow>(
        ctx,
        `SELECT ${SELECT_COLS}
         FROM connector_instance
         WHERE id = $1 AND brand_id = $2`,
        [id, brandId],
      );
      const row = result.rows[0];
      return row ? rowToEntity(row) : null;
    } finally {
      client.release();
    }
  }

  /**
   * List all connector instances for a brand (catalog⨝instance marketplace JOIN).
   * Returns all rows; caller merges with catalog definition list.
   */
  async findAllByBrand(brandId: string): Promise<ConnectorInstance[]> {
    const ctx: QueryContext = { brandId, correlationId: 'n/a' };
    const client = await this.pool.connect();
    try {
      const result = await client.query<ConnectorInstanceRow>(
        ctx,
        `SELECT ${SELECT_COLS}
         FROM connector_instance
         WHERE brand_id = $1`,
        [brandId],
      );
      return result.rows.map(rowToEntity);
    } finally {
      client.release();
    }
  }

  /**
   * List all connector instances for a brand+provider pair (Gap B — multi-account).
   * Returns all accounts ordered by created_at; caller dispatches per-account.
   */
  async findAllByBrandAndProvider(brandId: string, provider: string): Promise<ConnectorInstance[]> {
    const ctx: QueryContext = { brandId, correlationId: 'n/a' };
    const client = await this.pool.connect();
    try {
      const result = await client.query<ConnectorInstanceRow>(
        ctx,
        `SELECT ${SELECT_COLS}
         FROM connector_instance
         WHERE brand_id = $1 AND provider = $2
         ORDER BY created_at ASC`,
        [brandId, provider],
      );
      return result.rows.map(rowToEntity);
    } finally {
      client.release();
    }
  }

  async save(instance: ConnectorInstance): Promise<ConnectorInstance> {
    const ctx: QueryContext = { brandId: instance.brandId, correlationId: 'n/a' };
    const client = await this.pool.connect();
    try {
      const result = await client.query<ConnectorInstanceRow>(
        ctx,
        // UPSERT on (brand_id, provider, account_key): reconnecting after a disconnect must
        // REACTIVATE the existing row, not INSERT a duplicate (23505). On conflict, refresh the
        // connection fields + clear disconnected_at; keep the original id + created_at
        // (RETURNING yields the surviving row).
        `INSERT INTO connector_instance
           (id, brand_id, provider, shop_domain, secret_ref, status,
            health_state, safety_rating,
            connected_at, disconnected_at, created_at, updated_at,
            account_key, connector_provider_config, activated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT (brand_id, provider, account_key) DO UPDATE SET
            shop_domain              = EXCLUDED.shop_domain,
            secret_ref               = EXCLUDED.secret_ref,
            status                   = EXCLUDED.status,
            health_state             = EXCLUDED.health_state,
            safety_rating            = EXCLUDED.safety_rating,
            connected_at             = EXCLUDED.connected_at,
            disconnected_at          = EXCLUDED.disconnected_at,
            updated_at               = EXCLUDED.updated_at,
            connector_provider_config = EXCLUDED.connector_provider_config
            -- activated_at is NOT clobbered on reconnect: the user's activation choice survives a
            -- token refresh / reconnect. New rows persist the INSERT value (auto-activate-if-single).
         RETURNING ${SELECT_COLS}`,
        [
          instance.id,
          instance.brandId,
          instance.provider,
          instance.shopDomain,
          instance.secretRef,
          instance.status,
          instance.healthState,
          instance.safetyRating,
          instance.connectedAt.toISOString(),
          instance.disconnectedAt?.toISOString() ?? null,
          instance.createdAt.toISOString(),
          instance.updatedAt.toISOString(),
          instance.accountKey,
          instance.providerConfig && Object.keys(instance.providerConfig).length > 0
            ? JSON.stringify(instance.providerConfig)
            : null,
          instance.activatedAt?.toISOString() ?? null,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error('[PgConnectorInstanceRepository] INSERT returned no row');
      return rowToEntity(row);
    } finally {
      client.release();
    }
  }

  async update(instance: ConnectorInstance): Promise<ConnectorInstance> {
    const ctx: QueryContext = { brandId: instance.brandId, correlationId: 'n/a' };
    const client = await this.pool.connect();
    try {
      const result = await client.query<ConnectorInstanceRow>(
        ctx,
        `UPDATE connector_instance
         SET status = $1, health_state = $2, safety_rating = $3,
             disconnected_at = $4, updated_at = $5
         WHERE id = $6 AND brand_id = $7
         RETURNING ${SELECT_COLS}`,
        [
          instance.status,
          instance.healthState,
          instance.safetyRating,
          instance.disconnectedAt?.toISOString() ?? null,
          instance.updatedAt.toISOString(),
          instance.id,
          instance.brandId,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error('[PgConnectorInstanceRepository] UPDATE returned no row');
      return rowToEntity(row);
    } finally {
      client.release();
    }
  }

  /**
   * Activate exactly ONE ad account (migration 0106), with switch semantics. Done as a SINGLE
   * multi-CTE statement so it is ATOMIC and runs under the per-query RLS transaction (the ctx GUC
   * scopes every CTE to this brand): the sibling-deactivation and the target-activation either both
   * commit or neither does — there is never a window with two active accounts.
   *
   * In Postgres, data-modifying CTEs all execute exactly once to completion against the same
   * snapshot, regardless of reference order. `target` resolves the connected instance for this
   * brand; `deactivate_siblings` clears every OTHER active account of the same (brand, provider);
   * the final UPDATE activates the target (idempotent via COALESCE — re-activating keeps the
   * original activated_at). 0 rows back (bad id / not connected / wrong brand) → returns null.
   */
  async activateAccount(
    connectorInstanceId: string,
    brandId: string,
  ): Promise<ConnectorInstance | null> {
    const ctx: QueryContext = { brandId, correlationId: 'n/a' };
    const client = await this.pool.connect();
    try {
      const result = await client.query<ConnectorInstanceRow>(
        ctx,
        `WITH target AS (
           SELECT id, brand_id, provider
             FROM connector_instance
            WHERE id = $1 AND brand_id = $2 AND status = 'connected'
         ),
         deactivate_siblings AS (
           UPDATE connector_instance ci
              SET activated_at = NULL, updated_at = now()
             FROM target t
            WHERE ci.brand_id = t.brand_id
              AND ci.provider = t.provider
              AND ci.id <> t.id
              AND ci.activated_at IS NOT NULL
         )
         UPDATE connector_instance ci
            SET activated_at = COALESCE(ci.activated_at, now()), updated_at = now()
           FROM target t
          WHERE ci.id = t.id
         RETURNING ${SELECT_COLS}`,
        [connectorInstanceId, brandId],
      );
      const row = result.rows[0];
      return row ? rowToEntity(row) : null;
    } finally {
      client.release();
    }
  }
}
