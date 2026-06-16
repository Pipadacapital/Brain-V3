/**
 * DEV-ONLY Shopify sync validation route.
 *
 * Exercises the REAL connector path end-to-end: takes the most-recently connected
 * connector_instance, resolves its OAuth token from Secrets Manager, and pulls live
 * data via ShopifyAdminClient — reporting whether the order/refund shape matches what
 * the Bronze layer + realized-revenue ledger will need. This is the de-risking spike
 * for the ingestion build; it is NOT the production sync.
 *
 * SECURITY: registered ONLY when NODE_ENV !== 'production' (see main.ts). The token is
 * used for the request and never logged or returned (I-S09).
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { DbPool, QueryContext } from '@brain/db';
import type { ISecretsManager } from '../../infrastructure/secrets/ISecretsManager.js';
import { ShopifyAdminClient, type ShopifyOrder } from '../../infrastructure/api/ShopifyAdminClient.js';

interface ConnInstanceRow {
  brand_id: string;
  shop_domain: string;
  secret_ref: string;
  connected_at: Date;
}

function dist(values: (string | null | undefined)[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const v of values) {
    const k = v ?? 'null';
    m[k] = (m[k] ?? 0) + 1;
  }
  return m;
}

function num(v: unknown): number {
  return Number(v ?? 0);
}

export function registerDevShopifySyncRoutes(
  app: FastifyInstance,
  pool: DbPool,
  secretsManager: ISecretsManager,
): void {
  app.get('/api/v1/dev/shopify/validate-sync', async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = randomUUID();

    // 1. Most-recently connected Shopify store. In dev the DB connects as superuser
    //    (RLS bypassed), so this cross-brand SELECT returns the latest connection.
    const ctx: QueryContext = { correlationId: 'dev-validate-sync' };
    const client = await pool.connect();
    let conn: ConnInstanceRow | undefined;
    try {
      const result = await client.query<ConnInstanceRow>(
        ctx,
        `SELECT brand_id, shop_domain, secret_ref, connected_at
         FROM connector_instance
         WHERE provider = 'shopify' AND status = 'connected'
         ORDER BY connected_at DESC
         LIMIT 1`,
        [],
      );
      conn = result.rows[0];
    } finally {
      client.release();
    }

    if (!conn) {
      return reply.code(404).send({
        request_id: requestId,
        error: { code: 'NO_CONNECTION', message: 'No connected Shopify store. Connect one in the dashboard first.' },
      });
    }

    // 2. Resolve the token from Secrets Manager (in-memory in dev — lost on restart).
    const token = await secretsManager.getShopifyToken(conn.secret_ref);
    if (!token) {
      return reply.code(409).send({
        request_id: requestId,
        error: {
          code: 'NO_TOKEN',
          message:
            'Connector row exists but the token is not in the dev secret store. Core likely restarted since you connected — reconnect the store, then retry.',
        },
      });
    }

    // 3. Pull live data via the real client.
    const shopify = new ShopifyAdminClient(conn.shop_domain, token);
    let shop, count: number, orders: ShopifyOrder[];
    try {
      shop = await shopify.getShop();
      count = await shopify.countOrders();
      orders = await shopify.getOrders(50);
    } catch (err) {
      return reply.code(502).send({
        request_id: requestId,
        error: { code: 'SHOPIFY_API_ERROR', message: err instanceof Error ? err.message : String(err) },
      });
    }

    // 4. Summarize the shape (the de-risking payoff).
    const o = (k: string) => orders.map((ord) => ord[k] as string | null | undefined);
    const withRefunds = orders.filter((ord) => Array.isArray(ord['refunds']) && (ord['refunds'] as unknown[]).length > 0);
    const currencies = [...new Set(o('currency'))];
    const pageGmv = orders.reduce((s, ord) => s + num(ord['current_total_price'] ?? ord['total_price']), 0);
    const sample = orders.find((ord) => Array.isArray(ord['refunds']) && (ord['refunds'] as unknown[]).length > 0) ?? orders[0];

    return reply.send({
      request_id: requestId,
      store: {
        brand_id: conn.brand_id,
        shop_domain: conn.shop_domain,
        name: shop.name,
        currency: shop.currency,
        iana_timezone: shop.ianaTimezone,
        country_code: shop.countryCode,
        plan: shop.planName,
      },
      orders: {
        total_count: count,
        sample_page_size: orders.length,
        currencies,
        page_gmv: Number(pageGmv.toFixed(2)),
        financial_status: dist(o('financial_status')),
        fulfillment_status: dist(o('fulfillment_status')),
        payment_gateways: dist(orders.flatMap((ord) => (ord['payment_gateway_names'] as string[]) ?? [ord['gateway'] as string])),
        orders_with_refunds: withRefunds.length,
        test_orders: orders.filter((ord) => ord['test'] === true).length,
        with_customer: orders.filter((ord) => ord['customer']).length,
      },
      sample_order: sample
        ? {
            id: sample['id'],
            name: sample['name'],
            created_at: sample['created_at'],
            processed_at: sample['processed_at'],
            currency: sample['currency'],
            total_price: sample['total_price'],
            financial_status: sample['financial_status'],
            fulfillment_status: sample['fulfillment_status'],
            payment_gateway_names: sample['payment_gateway_names'],
            test: sample['test'],
            refund_count: Array.isArray(sample['refunds']) ? (sample['refunds'] as unknown[]).length : 0,
            customer_email_present: !!(sample['customer'] as { email?: string } | null)?.email,
            customer_phone_present: !!(sample['customer'] as { phone?: string } | null)?.phone,
          }
        : null,
    });
  });
}
