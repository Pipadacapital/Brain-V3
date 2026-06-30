/**
 * Logistics / orders / cost analytics BFF routes (CQ-1 decomposition).
 *
 * CoD/RTO rates, customer-360 summary, CoD mix, checkout funnel, RTO-risk
 * distribution, order-status mix, top products, contribution margin, cost inputs
 * (list/upsert), orders list, and order detail. ADR-002 sole-read-path via the
 * analytics wrappers → the metric engine. Brand from session (D-1).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedRequest } from '../../../workspace-access/index.js';
import {
  getCodRtoRates,
  getCustomerBaseSummary,
  getCodMix,
  getCheckoutFunnel,
  getRtoRiskDistribution,
  getDeliveryTime,
  getOrderStatusMix,
  getTopProducts,
  getOrdersList,
  getOrderDetail,
  getContributionMargin,
  listCostInputs,
  upsertCostInput,
  fxRateService,
} from '../../../analytics/index.js';
import { withBrandTxn } from '@brain/metric-engine';
import type {
  OrderStatusMix as ContractOrderStatusMix,
  TopProducts as ContractTopProducts,
  OrdersList as ContractOrdersList,
  ContributionMargin as ContractContributionMargin,
  CostInputsList as ContractCostInputsList,
  OrderDetail as ContractOrderDetail,
  DeliveryTime as ContractDeliveryTime,
} from '@brain/contracts';
import type { BffDeps } from './_shared.js';

export function registerAnalyticsLogisticsRoutes(fastify: FastifyInstance, deps: BffDeps): void {
  const { bffProtectedPreHandler, rawPool, srPool, servingCache } = deps;

  // Redis serving-cache wrapper (same shape as analytics-core.routes.ts) — wraps a Trino read so
  // repeated loads hit Redis (5-min TTL) instead of re-querying Trino. No-op when cache is absent.
  const cachedRead = <T>(
    brandId: string,
    metricId: string,
    params: Record<string, unknown>,
    compute: () => Promise<T>,
  ): Promise<T> => (servingCache ? servingCache.read(brandId, metricId, params, compute) : compute());

  // ── CoD / RTO endpoints (GoKwik + Shopflo Track C) ────────────────────────
  // Three reads for the CoD/RTO analytics surface, all via the metric-engine sole
  // read-path (ADR-002 — NO ad-hoc SUM/COUNT here). Brand from session (D-1, never
  // body). Honest no_data (D-2). RLS/F-SEC-02: engine reads inside withBrandTxn.
  // data_source ('synthetic'|'live') is passed through for the Synthetic (dev) badge.

  /**
   * GET /api/v1/analytics/cod-rto-rates
   * RTO% by pincode cohort from gokwik.awb_status.v1 terminal Bronze rows.
   * Synthetic source in dev → data_source='synthetic' (UI badge). No numeric RTO score.
   */
  fastify.get(
    '/api/v1/analytics/cod-rto-rates',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }
      const result = await getCodRtoRates(auth.brandId, { srPool });
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/dashboard/customer-360
   * Customer-360 summary (customer count + lifetime value/orders + top customers) from the
   * gold_customer_360 Gold mart via the metric-engine Silver/Gold seam (ADR-002 / I-ST01). Honest
   * no_data when the brand has no customers. Brand from session (D-1).
   */
  fastify.get(
    '/api/v1/dashboard/customer-360',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }
      const result = await getCustomerBaseSummary(auth.brandId, { srPool });
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/cod-mix
   * CoD CM2 + CoD-vs-prepaid mix from the gold revenue ledger cod_* recognition event_types.
   * Money = bigint minor-unit strings (signed; net may be negative — honest).
   */
  fastify.get(
    '/api/v1/analytics/cod-mix',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }
      const result = await getCodMix(auth.brandId, { srPool });
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/checkout-funnel
   * Abandoned-checkout funnel from the silver_checkout_signal Silver mart (signal_type=
   * 'checkout_abandoned'). REAL Shopflo self-serve webhook (NOT synthetic). PII hashed at boundary.
   */
  fastify.get(
    '/api/v1/analytics/checkout-funnel',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }
      const result = await getCheckoutFunnel(auth.brandId, { srPool });
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/rto-risk-distribution
   * Per-order RTO-risk distribution from the silver_checkout_signal Silver mart (signal_type=
   * 'rto_predict'; latest prediction per order, last 30d). Categorical risk_flag buckets — VERBATIM,
   * never a fabricated score. Honest no_data (D-2). data_source='synthetic' drives the UI Synthetic
   * badge (GoKwik read API is a documented follow-up; real shape, synthetic source in dev).
   */
  fastify.get(
    '/api/v1/analytics/rto-risk-distribution',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }
      const result = await getRtoRiskDistribution(auth.brandId, { srPool });
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/operations/delivery-time
   * P3 — per-courier delivery-time profile: average delivery days + the fixed five-bucket day
   * histogram (0-1 / 2-3 / 4-5 / 6-7 / 8+), from gold_delivery_time (folded from the silver_shipment
   * dispatched→delivered terminal timestamps). Integer day math, NO money (avg is a behavioral
   * double). Honest no_data when the brand has no delivered shipments. Brand from session (D-1).
   */
  fastify.get(
    '/api/v1/analytics/operations/delivery-time',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data', generated_at: new Date().toISOString() } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (Trino) not available' } });
      }
      const brandId = auth.brandId; // narrowed string — stable inside the cache closure
      const result: ContractDeliveryTime = await cachedRead(brandId, 'delivery_time', {}, () =>
        getDeliveryTime(brandId, { srPool }),
      );
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/order-status-mix?from=YYYY-MM-DD&to=YYYY-MM-DD
   * The FIRST Silver-tier read: order-status mix (counts + share + realized value by
   * lifecycle_state) over a window, from silver.order_state. Goes through the
   * metric-engine Silver seam (withSilverBrand) — the route issues NO OLAP SQL itself
   * (ADR-002 / I-ST01 sole read path). Brand from session (D-1, NEVER body). Honest
   * no_data (D-2). Money = bigint minor-unit strings (I-S07). data_source='synthetic'
   * in dev (the underlying ledger cod_* rows are synthetic — real shape, synthetic source).
   */
  fastify.get(
    '/api/v1/analytics/order-status-mix',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            to:   { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          },
          additionalProperties: false,
        },
      },
      attachValidation: true,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_PARAMS', message: 'from/to must be YYYY-MM-DD.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      // Silver reads require the StarRocks pool; absent → honest 503 (never a fake zero).
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }

      const query = request.query as { from?: string; to?: string };
      const today = new Date().toISOString().split('T')[0] as string;
      const toStr = query.to ?? today;
      // Default window: last 30 days.
      const defaultFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string;
      const fromStr = query.from ?? defaultFrom;

      const result: ContractOrderStatusMix = await getOrderStatusMix(
        auth.brandId,
        { srPool },
        {
          from: new Date(`${fromStr}T00:00:00Z`),
          to: new Date(`${toStr}T23:59:59Z`),
          fromStr,
          toStr,
          // Dev: the order ledger's cod_* rows folded into Silver are synthetic (real shape).
          dataSource: 'synthetic',
        },
      );

      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/top-products?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=N
   * Per-SKU rollup (units / line GMV / order count) over the Silver order-line mart
   * (silver.order_line), via the metric-engine seam (withSilverBrand, I-ST01). The route
   * issues NO OLAP SQL itself. Brand from session (D-1). Honest no_data (D-2). Money = bigint
   * minor-unit strings (I-S07). data_source='synthetic' in dev.
   */
  fastify.get(
    '/api/v1/analytics/top-products',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            from:  { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            to:    { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            limit: { type: 'integer', minimum: 1, maximum: 50 },
          },
          additionalProperties: false,
        },
      },
      attachValidation: true,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_PARAMS', message: 'from/to must be YYYY-MM-DD, limit 1–50.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data' } });
      }
      if (!srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier (StarRocks) not available' } });
      }

      const query = request.query as { from?: string; to?: string; limit?: number };
      const today = new Date().toISOString().split('T')[0] as string;
      const toStr = query.to ?? today;
      const defaultFrom = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string;
      const fromStr = query.from ?? defaultFrom;

      const result: ContractTopProducts = await getTopProducts(
        auth.brandId,
        { srPool },
        {
          from: new Date(`${fromStr}T00:00:00Z`),
          to: new Date(`${toStr}T23:59:59Z`),
          fromStr,
          toStr,
          limit: query.limit ?? 10,
          dataSource: 'synthetic',
        },
      );

      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/contribution-margin?as_of=YYYY-MM-DD
   * CM1/CM2 + cost_confidence over the brand's revenue/cost/spend (feat-cm2-cost-inputs). Brand from
   * session (D-1). Honest no_data (D-2). Money = bigint minor-unit strings (I-S07). PHASE G: mixed-tier
   * read — cost config via rawPool (PG, RLS), realized + spend via srPool (lakehouse). No manual SUM
   * (F-SEC-02 / ADR-002).
   */
  fastify.get(
    '/api/v1/analytics/contribution-margin',
    {
      preHandler: [bffProtectedPreHandler],
      schema: { querystring: { type: 'object', properties: { as_of: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } }, additionalProperties: false } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      const today = new Date().toISOString().split('T')[0] as string;
      const asOfStr = (request.query as { as_of?: string }).as_of ?? today;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data', as_of: asOfStr } });
      }
      if (!rawPool || !srPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'read pool or Silver tier not available' } });
      }
      const result: ContractContributionMargin = await getContributionMargin(auth.brandId, new Date(`${asOfStr}T23:59:59Z`), { pool: rawPool, srPool });
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/costs — the brand's currently-active cost inputs (feat-cm2-cost-inputs).
   * POST /api/v1/costs — upsert one cost input (COGS/shipping/fee rate or fixed amount).
   * Brand from session (D-1). cost_input is RLS-scoped config.
   */
  fastify.get(
    '/api/v1/costs',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) return reply.send({ request_id: requestId, data: { cost_inputs: [] } });
      if (!rawPool) return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'read pool not available' } });
      const cost_inputs = await listCostInputs(auth.brandId, { pool: rawPool });
      const result: ContractCostInputsList = { cost_inputs };
      return reply.send({ request_id: requestId, data: result });
    },
  );

  fastify.post(
    '/api/v1/costs',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        body: {
          type: 'object',
          required: ['scope', 'cost_type', 'currency_code'],
          properties: {
            scope: { type: 'string', enum: ['global', 'sku', 'category'] },
            scope_ref: { type: 'string', maxLength: 256 },
            cost_type: { type: 'string', enum: ['cogs', 'shipping', 'packaging', 'payment_fee', 'marketplace_fee'] },
            amount_minor: { type: 'string', pattern: '^\\d+$' },
            pct_bps: { type: 'integer', minimum: 0, maximum: 100000 },
            currency_code: { type: 'string', minLength: 3, maxLength: 3 },
            cost_confidence: { type: 'string', enum: ['Trusted', 'Estimated', 'Insufficient'] },
          },
          additionalProperties: false,
        },
        attachValidation: true,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({ request_id: requestId, error: { code: 'INVALID_PARAMS', message: 'Invalid cost input.' } });
      }
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) return reply.code(409).send({ request_id: requestId, error: { code: 'NO_ACTIVE_BRAND', message: 'Select a brand first.' } });
      if (!rawPool) return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'read pool not available' } });
      const b = request.body as Parameters<typeof upsertCostInput>[1];
      try {
        const out = await upsertCostInput(auth.brandId, b, { pool: rawPool });
        return reply.send({ request_id: requestId, data: out });
      } catch (err) {
        request.log.error({ err }, 'cost input upsert failed');
        if ((err as { code?: string }).code === '23505') {
          return reply.code(409).send({ request_id: requestId, error: { code: 'COST_ALREADY_RECORDED', message: 'This cost has already been recorded.' } });
        }
        return reply.code(500).send({ request_id: requestId, error: { code: 'INTERNAL_ERROR', message: 'Could not save cost input.' } });
      }
    },
  );

  /**
   * GET /api/v1/analytics/orders-list?page=N&page_size=M
   * A paginated list of orders (latest state per order) from Bronze (feat-shopify-order-depth);
   * each row links to order-detail. Brand from session (D-1, NEVER body). Honest no_data (D-2).
   * Money = bigint minor-unit strings (I-S07). Reads Bronze via rawPool (no manual WHERE — F-SEC-02).
   */
  fastify.get(
    '/api/v1/analytics/orders-list',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            page:      { type: 'integer', minimum: 1 },
            page_size: { type: 'integer', minimum: 1, maximum: 100 },
          },
          additionalProperties: false,
        },
      },
      attachValidation: true,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_PARAMS', message: 'page ≥ 1, page_size 1–100.' },
        });
      }

      const query = request.query as { page?: number; page_size?: number };
      const page = query.page ?? 1;
      const pageSize = query.page_size ?? 20;
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'no_data', page, page_size: pageSize, total: '0' } });
      }
      if (!rawPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Bronze read pool not available' } });
      }

      // Cache the page read (keyed by brand + page + size) behind Redis (5-min TTL); the FX
      // enrichment below stays per-request on the (fresh-parsed) cached result.
      const brandId = auth.brandId; // narrowed (guarded above) — stable inside the cache closure
      const result: ContractOrdersList = await cachedRead(
        brandId,
        'orders_list',
        { page, pageSize },
        () => getOrdersList(brandId, { page, pageSize }, { pool: rawPool, srPool }),
      );

      // FX convenience view (display-only): enrich each order with its amount in the brand's PRIMARY
      // currency at the latest rate. Native amount/currency stay authoritative (revenue truth). Best-
      // effort: any failure (brand read, FX provider down) just omits the converted value — the UI
      // then shows the native amount only and never breaks.
      if (result.state === 'has_data' && result.orders.length > 0) {
        try {
          const primaryCurrency = await withBrandTxn(rawPool, auth.brandId, async (client) => {
            const r = await client.query<{ currency_code: string | null }>(
              `SELECT currency_code FROM brand WHERE id = $1`,
              [auth.brandId],
            );
            return r.rows[0]?.currency_code ?? null;
          });
          if (primaryCurrency) {
            const enriched = await Promise.all(
              result.orders.map(async (o) => ({
                ...o,
                amount_in_primary_minor:
                  o.currency_code === primaryCurrency
                    ? null
                    : await fxRateService.convertMinorToPrimary(o.amount_minor, o.currency_code, primaryCurrency),
              })),
            );
            return reply.send({
              request_id: requestId,
              data: { ...result, orders: enriched, primary_currency: primaryCurrency },
            });
          }
        } catch (err) {
          request.log.warn({ err }, 'fx enrichment failed');
          // fall through to the un-enriched result (native amounts only)
        }
      }
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /api/v1/analytics/order-detail?order_id=<id>
   * A single order's economic breakdown (line items / tax / shipping / discounts / refunds), read
   * from Bronze — the captured composition of the order (feat-shopify-order-depth). Brand from
   * session (D-1, NEVER body). Honest not_found (D-2). Money = bigint minor-unit strings (I-S07).
   * Reads Bronze via rawPool under withBrandTxn (RLS-scoped; no manual WHERE — F-SEC-02).
   */
  fastify.get(
    '/api/v1/analytics/order-detail',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: { order_id: { type: 'string', minLength: 1, maxLength: 256 } },
          required: ['order_id'],
          additionalProperties: false,
        },
      },
      attachValidation: true,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_PARAMS', message: 'order_id is required.' },
        });
      }

      const orderId = (request.query as { order_id: string }).order_id;
      const auth = (request as AuthenticatedRequest).auth;
      if (!auth.brandId) {
        return reply.send({ request_id: requestId, data: { state: 'not_found', order_id: orderId } });
      }
      if (!rawPool) {
        return reply.code(503).send({ request_id: requestId, error: { code: 'SERVICE_UNAVAILABLE', message: 'Bronze read pool not available' } });
      }

      const result: ContractOrderDetail = await getOrderDetail(auth.brandId, orderId, { pool: rawPool, srPool });
      return reply.send({ request_id: requestId, data: result });
    },
  );

}
