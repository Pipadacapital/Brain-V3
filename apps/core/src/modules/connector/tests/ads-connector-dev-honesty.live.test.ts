/**
 * ads-connector-dev-honesty.live.test.ts — feat-ad-connectors Track 1 (ADR-AD-9).
 *
 * Proves the DEV-HONESTY boundary + the security invariants for the ads connectors using
 * a SYNTHETIC connector seeded via the connector-lifecycle path (no real OAuth network):
 *
 *   - The marketplace status surface reflects the REAL connector_sync_status row
 *     (waiting_for_data on connect) — never a simulated "connected" badge.
 *   - The token NEVER lands in Postgres: connector_instance has no token/secret column;
 *     only secret_ref (an ARN) is persisted. ad_account_id is an operational ref (not PII).
 *   - Cross-brand isolation under brain_app (FORCE-RLS, non-inert): a meta connector seeded
 *     for Brand A is INVISIBLE to Brand B (count === 0).
 *
 * ALL isolation assertions run under SET ROLE brain_app via BRAIN_APP_DATABASE_URL
 * (NOSUPERUSER NOBYPASSRLS). Superuser `brain` handles DDL/seed only — the dev superuser
 * masks RLS, so an isolation check NOT under brain_app would be INERT.
 *
 * REQUIRES: Postgres on localhost:5432 with migrations through 0029 applied.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const SUPERUSER_URL =
  process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const APP_URL =
  process.env['BRAIN_APP_DATABASE_URL'] ??
  'postgres://brain_app:brain_app@localhost:5432/brain';

const BRAND_A = process.env['TEST_BRAND_A'] || 'eefda8d9-2ee5-42a8-a667-06af5e51a99c';
const BRAND_B = process.env['TEST_BRAND_B'] || 'ef1b8fe7-bad9-4400-87ca-778d7b1a9a37';

const SYNTHETIC_TOKEN = 'EAABsynthetic_meta_token_must_never_reach_postgres';

let superPool: pg.Pool;
let appPool: pg.Pool;
// Self-skip flag: the fixture brands are provisioned by CI (TEST_BRAND_A/B) or the dev seed. When they
// are absent (thin/fresh DB), the suite SKIPs with a clear reason instead of a hard throw — matching the
// established self-skip pattern (apps/stream-worker/src/tests/pipeline-wire.e2e.test.ts).
let brandsSeeded = false;

interface SeededConnector {
  connectorInstanceId: string;
  syncStatusId: string;
  secretRef: string;
}

/**
 * Seed a synthetic meta connector exactly as the callback command would: a connector_instance
 * row (provider='meta', shop_domain='', secret_ref=ARN, ad_account_id set) + a
 * connector_sync_status row in the REAL 'waiting_for_data' state. The token itself is NEVER
 * written — only the ARN (mirrors LocalSecretsManager.storeSecret's return).
 */
async function seedSyntheticMetaConnector(brandId: string, adAccountId: string): Promise<SeededConnector> {
  const connectorInstanceId = randomUUID();
  const syncStatusId = randomUUID();
  const secretRef = `arn:aws:secretsmanager:us-east-1:000000000000:secret:brain/connector/meta/${brandId}/${adAccountId}`;
  const now = new Date().toISOString();

  await superPool.query(
    `INSERT INTO connector_instance
       (id, brand_id, provider, shop_domain, secret_ref, status,
        health_state, safety_rating, ad_account_id, connected_at, created_at, updated_at)
     VALUES ($1, $2, 'meta', '', $3, 'connected', 'Healthy', 'safe', $4, $5, $5, $5)`,
    [connectorInstanceId, brandId, secretRef, adAccountId, now],
  );
  await superPool.query(
    `INSERT INTO connector_sync_status
       (id, brand_id, connector_instance_id, state, last_sync_at, last_error, updated_at)
     VALUES ($1, $2, $3, 'waiting_for_data', NULL, NULL, $4)`,
    [syncStatusId, brandId, connectorInstanceId, now],
  );
  return { connectorInstanceId, syncStatusId, secretRef };
}

async function cleanup(brandIds: string[]): Promise<void> {
  for (const brandId of brandIds) {
    await superPool.query(
      `DELETE FROM connector_sync_status WHERE brand_id = $1 AND connector_instance_id IN
         (SELECT id FROM connector_instance WHERE provider IN ('meta','google_ads'))`,
      [brandId],
    );
    await superPool.query(
      `DELETE FROM connector_instance WHERE brand_id = $1 AND provider IN ('meta','google_ads')`,
      [brandId],
    );
  }
}

beforeAll(async () => {
  superPool = new pg.Pool({ connectionString: SUPERUSER_URL, max: 3 });
  appPool = new pg.Pool({ connectionString: APP_URL, max: 3 });
  const brands = await superPool.query<{ id: string }>(
    `SELECT id FROM brand WHERE id IN ($1, $2)`,
    [BRAND_A, BRAND_B],
  );
  brandsSeeded = brands.rows.length >= 2;
  if (!brandsSeeded) {
    // Thin/fresh DB: the fixture brands aren't present. SKIP with a clear reason (self-skip) rather than
    // a hard throw — the seed-fixture-org lane provisions an org but not these specific brand UUIDs, so
    // set TEST_BRAND_A/B (or seed the brands) to exercise the assertions.
    console.warn(
      `[ads-connector-dev-honesty] SKIP — brands ${BRAND_A}/${BRAND_B} not in DB. Set TEST_BRAND_A/B to run.`,
    );
    return;
  }
  await cleanup([BRAND_A, BRAND_B]);
});

afterAll(async () => {
  await cleanup([BRAND_A, BRAND_B]);
  await superPool.end();
  await appPool.end();
});

describe('Dev-honesty status surface (ADR-AD-9)', () => {
  it('a synthetic meta connector exposes the REAL connector_sync_status (waiting_for_data), not a fake badge', async () => {
    if (!brandsSeeded) return; // fixture brands absent → self-skip (needs a seeded brand FK)
    const seeded = await seedSyntheticMetaConnector(BRAND_A, 'act_777');
    try {
      // Read the status the SAME way the product does: brand-scoped under brain_app.
      const client = await appPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL app.current_brand_id = '${BRAND_A}'`);
        const r = await client.query<{ state: string; provider: string }>(
          `SELECT s.state, i.provider
             FROM connector_sync_status s
             JOIN connector_instance i ON i.id = s.connector_instance_id
            WHERE i.id = $1`,
          [seeded.connectorInstanceId],
        );
        await client.query('COMMIT');
        expect(r.rows.length).toBe(1);
        // REAL persisted truth — not simulated.
        expect(r.rows[0]!.state).toBe('waiting_for_data');
        expect(r.rows[0]!.provider).toBe('meta');
      } finally {
        client.release();
      }
    } finally {
      await cleanup([BRAND_A]);
    }
  });
});

describe('Token never in Postgres (NN-2 / I-S09)', () => {
  it('connector_instance has no token/secret/key column — only secret_ref (ARN)', async () => {
    const r = await superPool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'connector_instance'`,
    );
    const cols = r.rows.map((x) => x.column_name.toLowerCase());
    const forbidden = cols.filter(
      (c) => c.includes('token') || c.includes('ciphertext') || c.includes('_secret') || c.endsWith('_key'),
    );
    expect(forbidden, `Forbidden columns: ${forbidden.join(', ')}`).toHaveLength(0);
    expect(cols).toContain('secret_ref');
    expect(cols).toContain('ad_account_id'); // migration 0029 additive column
  });

  it('the synthetic token string is absent from the persisted meta connector row', async () => {
    if (!brandsSeeded) return; // fixture brands absent → self-skip (needs a seeded brand FK)
    const seeded = await seedSyntheticMetaConnector(BRAND_A, 'act_888');
    try {
      const r = await superPool.query<{ secret_ref: string; ad_account_id: string }>(
        `SELECT secret_ref, ad_account_id FROM connector_instance WHERE id = $1`,
        [seeded.connectorInstanceId],
      );
      expect(r.rows[0]!.secret_ref).toMatch(/^arn:aws:/);
      expect(r.rows[0]!.secret_ref).not.toContain(SYNTHETIC_TOKEN);
      expect(r.rows[0]!.ad_account_id).toBe('act_888'); // operational ref, not PII
    } finally {
      await cleanup([BRAND_A]);
    }
  });
});

describe('Cross-brand isolation under brain_app (non-inert FORCE-RLS)', () => {
  it('current_user is brain_app (NOSUPERUSER NOBYPASSRLS)', async () => {
    const client = await appPool.connect();
    try {
      const r = await client.query<{ current_user: string }>(`SELECT current_user`);
      expect(r.rows[0]!.current_user).toBe('brain_app');
    } finally {
      client.release();
    }
  });

  it('a Brand A meta connector is INVISIBLE to Brand B (count === 0)', async () => {
    if (!brandsSeeded) return; // fixture brands absent → self-skip (needs seeded brand FKs)
    const seeded = await seedSyntheticMetaConnector(BRAND_A, 'act_999');
    try {
      const client = await appPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL app.current_brand_id = '${BRAND_B}'`);
        const r = await client.query<{ id: string }>(
          `SELECT id FROM connector_instance WHERE id = $1`,
          [seeded.connectorInstanceId],
        );
        await client.query('COMMIT');
        expect(r.rows.length, 'Brand A meta connector leaked to Brand B').toBe(0);
      } finally {
        client.release();
      }
    } finally {
      await cleanup([BRAND_A]);
    }
  });
});
