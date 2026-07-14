/**
 * BronzeRepository — writes BronzeRow values to the bronze_events Postgres table.
 *
 * Isolation invariant (D-8, NN-1):
 *   Every INSERT must be preceded by SELECT set_config('app.current_brand_id', brand_id, true)
 *   in the SAME transaction so the RLS policy sees the correct brand_id GUC.
 *   The stream-worker connects as brain_app (NOT brain superuser) so RLS is enforced.
 *
 * Idempotency backstop (I-ST04 / §5):
 *   ON CONFLICT (brand_id, event_id) DO NOTHING — the PK is the second dedup layer.
 *   Returns { inserted: false } when the PK detects a dup; caller treats as dedup-hit.
 *
 * GUC note (architecture-plan §4):
 *   SET LOCAL x = $1 is NOT valid SQL for custom GUCs. Use:
 *     SELECT set_config('app.current_brand_id', $1, true)
 *   The third arg (true) scopes the GUC to the current transaction (equivalent to
 *   SET LOCAL for transaction-block scope).
 */
import { Pool, PoolClient } from 'pg';
import { buildContextGucSql } from '@brain/db';
import { BronzeRow } from '../../domain/bronze/BronzeRow.js';

export interface WriteResult {
  /** true = row was inserted; false = PK conflict (dup, treat as dedup-hit) */
  inserted: boolean;
}

/**
 * AUD-PERF-010: in-process TTL cache for install_token→brand_id. The mapping only changes on
 * pixel reinstall, yet the hot pixel lane paid one PG round trip PER EVENT. TTLs are bounded
 * so staleness is bounded:
 *   - positive hits: 60s (a revoked/rotated token keeps admitting events ≤60s — accepted risk,
 *     documented in the audit; the SECURITY DEFINER fn remains the sole derivation source).
 *   - negative hits: 5s (a NEWLY installed pixel must not be quarantined for a minute).
 */
const BRAND_CACHE_POSITIVE_TTL_MS = 60_000;
const BRAND_CACHE_NEGATIVE_TTL_MS = 5_000;
/** Hard cap — garbage tokens must not grow the map unbounded (expired sweep on overflow). */
const BRAND_CACHE_MAX_ENTRIES = 10_000;

export class BronzeRepository {
  private readonly pool: Pool;
  /** install_token → { brandId (null = unresolved), expiresAt } (AUD-PERF-010). */
  private readonly brandCache = new Map<string, { brandId: string | null; expiresAt: number }>();

  constructor(connectionString: string) {
    // Connect as brain_app (connection string must use brain_app credentials).
    // brain superuser bypasses RLS — never use it for data-plane writes (F-4 trap).
    this.pool = new Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 30_000,
      statement_timeout: 10_000,
    });
  }

  /**
   * Write a BronzeRow to bronze_events.
   *
   * Transaction ordering (D-8 + D-7):
   *   1. BEGIN
   *   2. SELECT set_config('app.current_brand_id', brand_id, true) — GUC scoped to txn
   *   3. INSERT INTO bronze_events ... ON CONFLICT DO NOTHING
   *   4. COMMIT
   *   Caller commits Kafka offset ONLY AFTER this method returns successfully (D-7).
   *
   * @throws on any error except PK conflict (conflict → returns { inserted: false }).
   */
  /**
   * R2 keystone — derive the AUTHORITATIVE brand_id from a pixel install_token.
   *
   * Calls the SECURITY DEFINER fn resolve_brand_by_install_token(uuid) (migration 0028)
   * under brain_app. The fn bypasses FORCE RLS on pixel_installation for the dispatch-only
   * token→brand lookup (no brand GUC is known yet — that is precisely what we resolve), and
   * returns ONLY (brand_id) — no tenant data content.
   *
   * The install_token is a PUBLIC tracking id by design (0007:9), NOT a secret. Authority is
   * this SERVER-SIDE derivation + the caller's mismatch-quarantine, NEVER token secrecy and
   * NEVER a client-stamped brand_id (R2: the tenant key is never trusted from input).
   *
   * @returns the derived brand_id, or null when the token is malformed / absent / unresolved.
   *          A null return MUST cause the caller to quarantine (never write under a claimed brand).
   */
  async resolveBrandByInstallToken(installToken: unknown): Promise<string | null> {
    // Guard: the fn signature is (uuid). A non-string / non-uuid token would error at the
    // ::uuid cast — treat as unresolved (quarantine), never let it throw the pipeline.
    if (typeof installToken !== 'string' || installToken.length === 0) {
      return null;
    }
    const UUID_RE =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(installToken)) {
      return null;
    }

    // AUD-PERF-010: TTL-bounded in-process cache (positive 60s / negative 5s).
    const now = Date.now();
    const cached = this.brandCache.get(installToken);
    if (cached) {
      if (cached.expiresAt > now) return cached.brandId;
      this.brandCache.delete(installToken);
    }

    const client: PoolClient = await this.pool.connect();
    let brandId: string | null;
    try {
      const result = await client.query<{ brand_id: string }>(
        'SELECT brand_id FROM resolve_brand_by_install_token($1::uuid)',
        [installToken],
      );
      brandId = result.rows[0]?.brand_id ?? null;
    } finally {
      client.release();
    }

    if (this.brandCache.size >= BRAND_CACHE_MAX_ENTRIES) {
      // Sweep expired entries; if the map is genuinely full of live entries, clear it —
      // correctness is unaffected (cache miss = the PG round trip we did before).
      for (const [token, entry] of this.brandCache) {
        if (entry.expiresAt <= now) this.brandCache.delete(token);
      }
      if (this.brandCache.size >= BRAND_CACHE_MAX_ENTRIES) this.brandCache.clear();
    }
    this.brandCache.set(installToken, {
      brandId,
      expiresAt:
        now + (brandId !== null ? BRAND_CACHE_POSITIVE_TTL_MS : BRAND_CACHE_NEGATIVE_TTL_MS),
    });
    return brandId;
  }

  async write(row: BronzeRow): Promise<WriteResult> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Set GUC scoped to this transaction (true = is_local, equivalent to SET LOCAL).
      // This is mandatory before any RLS-filtered query — the policy reads this GUC.
      // Architecture note: SET LOCAL app.current_brand_id = $1 is invalid SQL;
      // set_config('name', value, is_local) is the correct parametric form.
      await client.query(buildContextGucSql({ brandId: row.brand_id, correlationId: '' }));

      const result = await client.query(
        `INSERT INTO bronze_events (
          brand_id, event_id, occurred_at, ingested_at,
          schema_name, schema_version, event_type, correlation_id,
          partition_key, payload, processing_flags, collector_version
        ) VALUES (
          $1, $2, $3::timestamptz, $4::timestamptz,
          $5, $6, $7, $8,
          $9, $10::jsonb, $11::jsonb, $12
        )
        ON CONFLICT (brand_id, event_id) DO NOTHING`,
        [
          row.brand_id,
          row.event_id,
          row.occurred_at,          // ISO-8601 string → timestamptz cast (D-6)
          row.ingested_at,          // ISO-8601 string → timestamptz cast (D-6)
          row.schema_name,
          row.schema_version,
          row.event_type,
          row.correlation_id,
          row.partition_key,
          JSON.stringify(row.payload),
          row.processing_flags != null ? JSON.stringify(row.processing_flags) : null,
          row.collector_version ?? null,
        ],
      );

      await client.query('COMMIT');

      // rowCount = 0 means ON CONFLICT triggered (PK duplicate — dedup-hit)
      const inserted = (result.rowCount ?? 0) > 0;
      return { inserted };
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
