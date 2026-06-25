/**
 * woocommerce-creds.ts — resolve a WooCommerce connector's API credentials (consumer_key/secret +
 * site_url) for the ingestion-backfill framework path.
 *
 * Mirrors the existing woocommerce-orders-repull credential resolution: PROD reads the per-brand
 * AWS Secrets Manager secret; DEV reads the dev_secret table, then env fallback. consumer_key /
 * consumer_secret are NEVER logged (I-S09). Returns null when credentials are missing
 * (RECONNECT_REQUIRED).
 */

import type { WooCommerceApiCredentials } from '../woocommerce-orders-repull/woocommerce-client.js';
import { log } from '../../log.js';

interface WooSecretBundle {
  consumer_key: string;
  consumer_secret: string;
}

export async function resolveWooCredentialsForConnector(
  secretRef: string,
  siteUrl: string,
): Promise<WooCommerceApiCredentials | null> {
  if (process.env['NODE_ENV'] === 'production') {
    try {
      const { AwsSecretsManager } = await import('@brain/connector-secrets');
      const region = process.env['BRAIN_AWS_REGION'] ?? process.env['AWS_REGION'] ?? 'us-east-1';
      const mgr = new AwsSecretsManager(region, '', process.env['KMS_KEY_ID'] ?? '');
      const bundle = await mgr.getSecret(secretRef);
      if (bundle && typeof bundle['consumer_key'] === 'string' && typeof bundle['consumer_secret'] === 'string') {
        return { consumer_key: bundle['consumer_key'], consumer_secret: bundle['consumer_secret'], site_url: siteUrl };
      }
      log.error(`[ingestion-backfill/woo] secret ${secretRef.slice(-24)} resolved but missing consumer_key/secret`);
    } catch (err) {
      log.error('[ingestion-backfill/woo] AwsSecretsManager getSecret failed', { err });
    }
  }

  const { Pool: PgPool } = await import('pg');
  const devPool = new PgPool({
    connectionString: process.env['BRAIN_APP_DATABASE_URL'] ?? process.env['DATABASE_URL'],
    max: 1,
  });
  try {
    const name = secretRef.split(':secret:')[1] ?? secretRef;
    const res = await devPool.query<{ secret_value: string }>(
      `SELECT secret_value FROM dev_secret WHERE name = $1`,
      [name],
    );
    const raw = res.rows[0]?.secret_value;
    if (raw) {
      try {
        const bundle = JSON.parse(raw) as WooSecretBundle;
        if (bundle.consumer_key && bundle.consumer_secret) {
          return { consumer_key: bundle.consumer_key, consumer_secret: bundle.consumer_secret, site_url: siteUrl };
        }
      } catch {
        // malformed — fall through to env fallback
      }
    }
    const envKey = process.env['WOOCOMMERCE_CONSUMER_KEY'];
    const envSecret = process.env['WOOCOMMERCE_CONSUMER_SECRET'];
    if (envKey && envSecret) {
      return { consumer_key: envKey, consumer_secret: envSecret, site_url: siteUrl };
    }
    return null;
  } finally {
    await devPool.end();
  }
}
