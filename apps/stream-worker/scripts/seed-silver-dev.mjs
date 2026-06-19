/**
 * seed-silver-dev.mjs — DEV ONLY: provision the StarRocks Silver tier + populate it from the
 * Postgres ledger so journey / order-status / attribution analytics show real data instead of
 * no_data. In prod these tables are filled by dbt full-refresh from Bronze (the starrocks-rebuild
 * Argo job); this is the dev shortcut.
 *
 *   silver_order_state  — one row per order: lifecycle_state derived from the ledger event mix
 *                         (rto_reversal → rto, finalization → delivered, else in_transit).
 *   silver_touchpoint   — two synthetic journey touches per stitched order (a first-touch channel
 *                         + a converting touch), stitched_brain_id = the order's brain_id.
 *
 * Usage: node --import tsx scripts/seed-silver-dev.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import pg from 'pg';
import mysql from 'mysql2/promise';

/** Deterministic UUID from a string (dev: synth a journey identity for anonymous orders). */
function synthBrainId(s) {
  const h = createHash('sha256').update(s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const ROOT = process.env['REPO_ROOT'] ?? process.cwd();

const PG_URL = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const SR = { host: process.env['STARROCKS_HOST'] ?? '127.0.0.1', port: Number(process.env['STARROCKS_PORT'] ?? 9030), user: 'root', password: '' };
const FIRST_TOUCH_CHANNELS = ['paid_social', 'organic_social', 'referral', 'email', 'direct', 'paid_search'];

function dt(d) {
  return new Date(d).toISOString().slice(0, 19).replace('T', ' ');
}

async function main() {
  const pgPool = new pg.Pool({ connectionString: PG_URL });
  const sr = await mysql.createConnection({ ...SR, multipleStatements: true });

  // 1. Provision (apply the versioned DDL — DROP first for a clean dev reseed).
  await sr.query('DROP TABLE IF EXISTS brain_silver.silver_order_state');
  await sr.query('DROP TABLE IF EXISTS brain_silver.silver_touchpoint');
  for (const f of ['silver_order_state.sql', 'silver_touchpoint.sql']) {
    const sql = fs.readFileSync(path.join(ROOT, 'db/starrocks/ddl', f), 'utf-8').replace(/--[^\n]*/g, '');
    for (const stmt of sql.split(';').map((s) => s.trim()).filter(Boolean)) await sr.query(stmt);
  }

  const brands = (await pgPool.query('SELECT id FROM list_active_brand_ids()')).rows;
  let orders = 0;
  let touches = 0;

  for (const { id: brandId } of brands) {
    // One row per order with its latest lifecycle + gross value.
    const ordRes = await pgPool.query(
      `SELECT order_id, MAX(brain_id::text) AS brain_id,
              MAX(amount_minor) FILTER (WHERE event_type='provisional_recognition') AS gross,
              bool_or(event_type='finalization') AS finalized,
              bool_or(event_type='rto_reversal') AS rto,
              MAX(occurred_at) AS last_at, MAX(currency_code) AS cc
         FROM realized_revenue_ledger WHERE brand_id = $1
        GROUP BY order_id`,
      [brandId],
    );

    const stateRows = [];
    const touchRows = [];
    let i = 0;
    for (const o of ordRes.rows) {
      const lifecycle = o.rto ? 'rto' : o.finalized ? 'delivered' : 'in_transit';
      const value = o.gross ?? 0;
      const at = dt(o.last_at ?? new Date());
      stateRows.push([brandId, o.order_id, lifecycle, value, (o.cc ?? 'INR').trim(), at, at]);

      // Journey identity: the order's brain_id, or a deterministic synthetic one (anonymous orders).
      const brainId = o.brain_id ?? synthBrainId(o.order_id);
      // DEV: backfill the ledger's brain_id to the SAME identity so the attribution reconcile (which
      // resolves the journey by the order's brain_id) can stitch + credit. No-op once identity-resolved.
      if (!o.brain_id) {
        await pgPool.query(
          `UPDATE realized_revenue_ledger SET brain_id = $1 WHERE brand_id = $2 AND order_id = $3 AND brain_id IS NULL`,
          [brainId, brandId, o.order_id],
        );
      }
      // Two touches per order: a first-touch channel (rotated) + a converting 'direct' touch.
      const anon = `anon-${brainId.slice(0, 8)}`;
      const ch = FIRST_TOUCH_CHANNELS[i % FIRST_TOUCH_CHANNELS.length];
      const tAt = dt(new Date(new Date(o.last_at ?? Date.now()).getTime() - 86400000));
      touchRows.push([brandId, anon, 1, 1, 0, ch, null, 'cpc', null, null, null, tAt, brainId]);
      touchRows.push([brandId, anon, 2, 0, 1, 'direct', null, null, null, null, null, at, brainId]);
      i += 1;
    }

    if (stateRows.length) {
      await sr.query(
        `INSERT INTO brain_silver.silver_order_state
           (brand_id, order_id, lifecycle_state, order_value_minor, currency_code, state_effective_at, occurred_at)
         VALUES ${stateRows.map(() => '(?,?,?,?,?,?,?)').join(',')}`,
        stateRows.flat(),
      );
      orders += stateRows.length;
    }
    if (touchRows.length) {
      await sr.query(
        `INSERT INTO brain_silver.silver_touchpoint
           (brand_id, brain_anon_id, touch_seq, is_first_touch, is_last_touch, channel, utm_campaign,
            utm_medium, fbclid, gclid, ttclid, occurred_at, stitched_brain_id)
         VALUES ${touchRows.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',')}`,
        touchRows.flat(),
      );
      touches += touchRows.length;
    }
  }

  console.log(`seeded silver: ${orders} order_state rows, ${touches} touchpoint rows across ${brands.length} brands`);
  await pgPool.end();
  await sr.end();
}

main().catch((e) => {
  console.error('seed-silver-dev failed:', e.message);
  process.exit(1);
});
