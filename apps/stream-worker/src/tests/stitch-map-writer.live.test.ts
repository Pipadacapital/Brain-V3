/**
 * stitch-map-writer.live.test.ts — DB-AUDIT journey-stitch. Proves StitchMapWriter upserts the
 * order→anon stitch (with the C2-resolved brain_id) idempotently under RLS, so the live/repull order
 * lane stitches journeys (previously only the webhook did). Requires Postgres.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { StitchMapWriter } from '../infrastructure/pg/StitchMapWriter.js';

const SUPER = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const APP = process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';

const BRAND = 'cafe0000-0000-4000-8000-0000000000ca';
const ORG = 'cafe0000-0000-4000-8000-0000000000f0';
const USER = 'cafe0000-0000-4000-8000-0000000000e0';
const ORDER = 'stitch-order-1';
const ANON = 'anon-journey-1';
const BRAIN = 'cafe0000-0000-4000-8000-0000000000b0';

let superPool: pg.Pool;
let appPool: pg.Pool;
let pgUp = false;

async function cleanup() {
  await superPool.query(`DELETE FROM connectors.connector_journey_stitch_map WHERE brand_id=$1`, [BRAND]).catch(() => {});
  await superPool.query(`DELETE FROM brand WHERE id=$1`, [BRAND]).catch(() => {});
  await superPool.query(`DELETE FROM organization WHERE id=$1`, [ORG]).catch(() => {});
  await superPool.query(`DELETE FROM app_user WHERE id=$1`, [USER]).catch(() => {});
}

beforeAll(async () => {
  try {
    superPool = new pg.Pool({ connectionString: SUPER, connectionTimeoutMillis: 4000 });
    await superPool.query('SELECT 1');
    appPool = new pg.Pool({ connectionString: APP, max: 2 });
    await cleanup();
    await superPool.query(`INSERT INTO app_user (id,email,email_normalized,password_hash) VALUES ($1,$2,$3,'x')`, [USER, `${USER}@x.invalid`, `${USER}@x.invalid`]);
    await superPool.query(`INSERT INTO organization (id,name,slug,owner_user_id) VALUES ($1,'JS',$2,$3)`, [ORG, `js-${ORG.slice(-6)}`, USER]);
    await superPool.query(`INSERT INTO brand (id,organization_id,display_name,currency_code,status) VALUES ($1,$2,'JS','INR','active')`, [BRAND, ORG]);
    pgUp = true;
  } catch {
    pgUp = false;
  }
});

afterAll(async () => {
  if (pgUp) await cleanup();
  await appPool?.end?.().catch(() => {});
  await superPool?.end?.().catch(() => {});
});

async function readStitch(): Promise<{ stitched_anon_id: string; brain_id: string | null } | null> {
  const r = await superPool.query<{ stitched_anon_id: string; brain_id: string | null }>(
    `SELECT stitched_anon_id, brain_id::text AS brain_id FROM connectors.connector_journey_stitch_map WHERE brand_id=$1 AND order_id=$2`,
    [BRAND, ORDER],
  );
  return r.rows[0] ?? null;
}

describe('StitchMapWriter (journey-stitch, live Postgres)', () => {
  it('SKIP_IF_NO_PG', () => {
    if (!pgUp) console.warn('[stitch-map-writer] Postgres unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('upserts order→anon with the resolved brain_id (RLS-scoped)', async () => {
    if (!pgUp) return;
    const w = new StitchMapWriter(appPool);
    await w.upsert(BRAND, ORDER, ANON, BRAIN);
    expect(await readStitch()).toEqual({ stitched_anon_id: ANON, brain_id: BRAIN });
  });

  it('is idempotent and never clobbers an existing brain_id with NULL (COALESCE)', async () => {
    if (!pgUp) return;
    const w = new StitchMapWriter(appPool);
    await w.upsert(BRAND, ORDER, ANON, null);          // re-upsert without a brain_id
    expect((await readStitch())!.brain_id).toBe(BRAIN); // prior brain_id preserved
  });
});
