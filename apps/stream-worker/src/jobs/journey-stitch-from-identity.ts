/**
 * journey-stitch-from-identity — derive connector_journey_stitch_map from the IDENTITY GRAPH (GAP-1).
 *
 * The canonical live stitch reads brain_anon_id BACK from an order's checkout note_attributes
 * (StitchMapWriter, fed by the order lane). Historical / repulled orders don't carry it, and most
 * storefronts have no checkout-side pixel — so that path leaves the stitch map empty and
 * silver_touchpoint.stitched_* NULL → attribution has no journeys to credit.
 *
 * This job is the deterministic, identity-graph fallback that completes the anon→customer BRIDGE:
 * the pixel `identify` event carries brain_anon_id + hashed_customer_email; the identity resolver
 * links that anon_id to the SAME brain_id as the order's pre_hashed_email. THIS job then reads those
 * links and writes the stitch:  raw anon (silver) --hash--> identity_link(anon_id)→brain_id --∩-->
 * gold_revenue_ledger(order→brain_id, Bronze-sourced)  ⇒  (order_id, stitched_anon_id, brain_id).
 *
 * DETERMINISTIC, NEVER GUESSED (Brain rule: journey-before-attribution, never guess attribution):
 *   - The anon↔customer link comes ONLY from identity resolution (a real `identify`/order signal),
 *     never from time-proximity heuristics.
 *   - UNAMBIGUOUS-ONLY: a brain_id is stitched to a journey anon ONLY when it maps to EXACTLY ONE
 *     anon. A customer with multiple resolved anons is skipped (honest NULL) rather than guessed.
 *
 * PROD-CORRECT (unlike tools/backfill/backfill-journey-stitch-map.sh, which re-derives the dev salt
 * and yields ZERO rows in prod): hashing goes through SaltProvider → resolveSaltHex, so the anon
 * hash matches identity_link in BOTH dev (env salt) and prod (KMS-derived salt).
 *
 * Idempotent (StitchMapWriter upsert on (brand_id, order_id)); brand-scoped via the GUC (RLS).
 * Usage: node dist/jobs/journey-stitch-from-identity.js  (Argo cron, after identity + finalization).
 */
import { Pool } from 'pg';
import mysql from 'mysql2/promise';
import { hashIdentifier, normalizeIdentifier, resolveSaltHex } from '@brain/identity-core';
import { SaltProvider, LocalSecretsProvider } from '../infrastructure/secrets/SaltProvider.js';
import { StitchMapWriter } from '../infrastructure/pg/StitchMapWriter.js';
import { log } from '../log.js';

const DB_URL =
  process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';

export interface StitchFromIdentityResult {
  brands: number;
  stitched: number;
  ambiguousSkipped: number;
  errors: number;
}

interface SilverPoolLike {
  query: (sql: string, params?: unknown[]) => Promise<[unknown[], unknown]>;
  end: () => Promise<void>;
}

/** Brand-scoped PG read: BEGIN → set brand GUC (RLS) → query → COMMIT. */
async function readScoped<T>(pool: Pool, brandId: string, sql: string, params: unknown[]): Promise<T[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_brand_id', $1, true)", [brandId]);
    const res = await client.query(sql, params);
    await client.query('COMMIT');
    return res.rows as T[];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function runJourneyStitchFromIdentity(deps?: {
  pool?: Pool;
  srPool?: SilverPoolLike;
  saltProvider?: SaltProvider;
}): Promise<StitchFromIdentityResult> {
  const srHost = process.env['STARROCKS_HOST'];
  if (!deps?.srPool && srHost === undefined) {
    log.warn('journey-stitch-from-identity skipped — STARROCKS_HOST unset (no Silver tier to read anons)');
    return { brands: 0, stitched: 0, ambiguousSkipped: 0, errors: 0 };
  }

  const pool = deps?.pool ?? new Pool({ connectionString: DB_URL, max: 3 });
  const srPool =
    deps?.srPool ??
    (mysql.createPool({
      host: srHost,
      port: parseInt(process.env['STARROCKS_PORT'] ?? '9030', 10),
      user: process.env['STARROCKS_ANALYTICS_USER'] ?? 'brain_analytics',
      password: process.env['STARROCKS_ANALYTICS_PASSWORD'] ?? 'brain_analytics_dev',
      connectionLimit: 3,
    }) as unknown as SilverPoolLike);
  const saltProvider = deps?.saltProvider ?? new SaltProvider(new LocalSecretsProvider(), resolveSaltHex);
  const stitchWriter = new StitchMapWriter(pool);
  const ownsPool = !deps?.pool;
  const ownsSr = !deps?.srPool;

  const result: StitchFromIdentityResult = { brands: 0, stitched: 0, ambiguousSkipped: 0, errors: 0 };

  try {
    const brands = await pool.query<{ id: string }>('SELECT id FROM list_active_brand_ids()');
    log.info('journey-stitch-from-identity starting', { brands: brands.rows.length });

    for (const brand of brands.rows) {
      result.brands += 1;
      try {
        const saltHex = await saltProvider.saltHexForBrand(brand.id);

        // 1. Distinct raw journey anons from Silver (brand-filtered; StarRocks).
        const [anonRows] = await srPool.query(
          `SELECT DISTINCT brain_anon_id FROM brain_silver.silver_touchpoint
            WHERE brand_id = ? AND brain_anon_id IS NOT NULL AND brain_anon_id <> ''`,
          [brand.id],
        );
        const rawAnons = (anonRows as Array<{ brain_anon_id: string }>).map((r) => r.brain_anon_id);
        if (rawAnons.length === 0) continue;

        // 2. Hash each raw anon EXACTLY as the resolver does (anon_id → external_id normalization).
        const hashToRaw = new Map<string, string>();
        for (const raw of rawAnons) {
          const h = hashIdentifier(normalizeIdentifier(raw, 'external_id'), 'external_id', saltHex);
          hashToRaw.set(h, raw);
        }

        // 3. anon hash → brain_id via the identity graph projection (active anon_id links only).
        // MEDALLION REALIGNMENT (Epic 3 / ADR-0004): identity is the Neo4j SoR; the active hash→brain_id
        // edges are materialized into brain_silver.silver_identity_link (StarRocks) by the identity-export
        // job — read it via srPool instead of the dropped PG identity_link.
        const anonHashes = [...hashToRaw.keys()];
        let linkRows: Array<{ identifier_value: string; brain_id: string }> = [];
        if (anonHashes.length > 0) {
          const [rows] = await srPool.query(
            `SELECT identifier_value, brain_id
               FROM brain_silver.silver_identity_link
              WHERE brand_id = ? AND identifier_type = 'anon_id' AND is_active = true
                AND brain_id IS NOT NULL AND identifier_value IN (${anonHashes.map(() => '?').join(',')})`,
            [brand.id, ...anonHashes],
          );
          linkRows = rows as Array<{ identifier_value: string; brain_id: string }>;
        }

        // 4. brain_id → anon(s). UNAMBIGUOUS-ONLY: keep brain_ids that map to exactly one anon.
        const brainToAnons = new Map<string, Set<string>>();
        for (const row of linkRows) {
          const raw = hashToRaw.get(row.identifier_value);
          if (!raw) continue;
          (brainToAnons.get(row.brain_id) ?? brainToAnons.set(row.brain_id, new Set()).get(row.brain_id)!).add(raw);
        }
        const brainToAnon = new Map<string, string>();
        for (const [brainId, anons] of brainToAnons) {
          if (anons.size === 1) brainToAnon.set(brainId, [...anons][0]!);
          else result.ambiguousSkipped += 1; // multiple anons for one customer → never guess
        }
        if (brainToAnon.size === 0) continue;

        // 5. brain_id → orders, then upsert the stitch (order_id, raw anon, brain_id).
        // MEDALLION REALIGNMENT (Epic 1): read orders from the lakehouse (brain_gold.gold_revenue_ledger,
        // Bronze-sourced) via the StarRocks pool — NOT the PG ledger.
        const brainIds = [...brainToAnon.keys()];
        const inPlaceholders = brainIds.map(() => '?').join(',');
        const [orderRowsRaw] = await srPool.query(
          `SELECT DISTINCT order_id, brain_id
             FROM brain_gold.gold_revenue_ledger
            WHERE brand_id = ? AND brain_id IN (${inPlaceholders})`,
          [brand.id, ...brainIds],
        );
        const orderRows = orderRowsRaw as Array<{ order_id: string; brain_id: string }>;

        // PERF (PF-4): one txn per brand — collect the brand's stitch rows, then a single
        // multi-row upsert (was a per-order connect→BEGIN→GUC→INSERT→COMMIT loop).
        const stitchRows = orderRows
          .map((o) => {
            const rawAnon = brainToAnon.get(o.brain_id);
            return rawAnon ? { orderId: o.order_id, stitchedAnonId: rawAnon, brainId: o.brain_id } : null;
          })
          .filter((r): r is { orderId: string; stitchedAnonId: string; brainId: string } => r !== null);
        if (stitchRows.length > 0) {
          await stitchWriter.upsertMany(brand.id, stitchRows);
          result.stitched += stitchRows.length;
        }
      } catch (err) {
        result.errors += 1;
        log.error('journey-stitch-from-identity failed for brand', { brand_id: brand.id, err });
      }
    }

    log.info('journey-stitch-from-identity complete', { ...result });
    return result;
  } finally {
    if (ownsPool) await pool.end();
    if (ownsSr) await srPool.end();
  }
}

// Entry point — only when run directly (not when imported in tests).
if (
  process.argv[1]?.endsWith('journey-stitch-from-identity.ts') ||
  process.argv[1]?.endsWith('journey-stitch-from-identity.js')
) {
  runJourneyStitchFromIdentity()
    .then((r) => process.exit(r.errors > 0 ? 1 : 0))
    .catch((err) => {
      log.error('fatal', { err });
      process.exit(1);
    });
}
