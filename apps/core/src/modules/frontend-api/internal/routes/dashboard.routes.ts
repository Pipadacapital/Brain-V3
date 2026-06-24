/**
 * Dashboard BFF routes (CQ-1 decomposition).
 *
 * Brand summary, connection status, data-foundation-health verdict, entitlements
 * (progressive unlock), data (pixel) status, onboarding progress, and realized-revenue.
 * All reads are control-plane (Postgres) + the metric-engine seam (realized-revenue).
 * Honest empty: never 404 — a structured empty state when no data exists yet. All routes
 * are protected by bffProtectedPreHandler (validateSession + NN-3 + CSRF).
 *
 * Cross-context raw SQL has been consolidated into named helpers in dashboard.queries.ts.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { QueryContext } from '@brain/db';
import type { AuthenticatedRequest } from '../../../workspace-access/index.js';
import {
  getRevenueMetrics,
  computeFoundationHealth,
  computeEntitlements,
  type FoundationSignals,
} from '../../../analytics/index.js';
import type {
  RevenueSnapshot as ContractRevenueSnapshot,
  FoundationHealth as ContractFoundationHealth,
  Entitlements as ContractEntitlements,
} from '@brain/contracts';
import type { BffDeps } from './_shared.js';
import {
  queryOrganization,
  queryBrandList,
  queryActiveBrandMemberCount,
  queryLatestConnectorWithSync,
  queryLatestPixelStatus,
  queryUserEmailVerified,
  queryWorkspaceMembershipCount,
  queryBrandCount,
  queryShopifyConnectedCount,
  queryPixelInstalledCount,
  type ConnRow,
} from './dashboard.queries.js';

export function registerDashboardRoutes(fastify: FastifyInstance, deps: BffDeps): void {
  const { bffProtectedPreHandler, pool, rawPool, srPool, gatherFoundationSignals } = deps;

  // ── Dashboard BFF endpoints (MED-BFF-DASH-01) ─────────────────────────────
  // All reads are Postgres-only (ZERO StarRocks/OLAP — ADR-002).
  // Honest empty: if no data exists yet, returns structured empty state — never 404.
  // All routes protected by bffProtectedPreHandler (validateSession + NN-3 + CSRF).

  /**
   * GET /v1/dashboard/brand-summary
   * Returns brand/org/membership counts for the current workspace.
   */
  fastify.get(
    '/api/v1/dashboard/brand-summary',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;

      if (!auth.workspaceId) {
        // No workspace context yet — honest empty
        return reply.send({
          request_id: requestId,
          data: {
            org_name: null,
            active_brand_id: null,
            brand_count: 0,
            member_count: 0,
            brands: [],
          },
        });
      }

      if (!pool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' },
        });
      }

      // userId is REQUIRED: the brand list is gated by the brand_self_read RLS policy, whose
      // membership subquery filters `app_user_id = app.current_user_id`. Without the user GUC the
      // subquery matches nothing and the switcher shows ZERO brands (the org membership_self_read
      // path needs it too). Set all of workspace + user (+ brand for the member count) here.
      const ctx: QueryContext = {
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        correlationId: requestId,
      };
      const client = await pool.connect();
      try {
        // brand-summary queries: org + brand list (all member brands for the switcher) + brand-scoped member count.
        const [orgResult, brandResult, memberResult] = await Promise.all([
          queryOrganization(client, ctx, auth.workspaceId),
          queryBrandList(client, ctx, auth.workspaceId),
          // MA-06/SD-2: member count is per-active-brand, not org-level.
          // Guard: if auth.brandId is null (no active brand), count returns 0 (honest empty).
          auth.brandId
            ? queryActiveBrandMemberCount(client, ctx, auth.workspaceId, auth.brandId)
            : Promise.resolve({ rows: [{ count: '0' }] as { count: string }[] }),
        ]);

        const org = orgResult.rows[0];
        return reply.send({
          request_id: requestId,
          data: {
            org_name: org?.name ?? null,
            // MA-06: active_brand_id = auth.brandId so the client can identify the active brand
            // by ID (not array index). Frontend resolves: brands.find(b => b.id === active_brand_id).
            active_brand_id: auth.brandId ?? null,
            brand_count: brandResult.rows.length,
            member_count: parseInt(memberResult.rows[0]?.count ?? '0', 10),
            brands: brandResult.rows.map((b) => ({
              id: b.id,
              display_name: b.display_name,
              domain: b.domain,
              status: b.status,
            })),
          },
        });
      } finally {
        client.release();
      }
    },
  );

  /**
   * GET /v1/dashboard/connection-status
   * Returns connector_sync_status for the current brand.
   */
  fastify.get(
    '/api/v1/dashboard/connection-status',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;

      if (!auth.brandId) {
        return reply.send({
          request_id: requestId,
          data: {
            shopify: { connected: false, status: 'not_connected', syncState: null, lastSyncAt: null },
            razorpay: { connected: false, status: 'not_connected', syncState: null, lastSyncAt: null },
            meta: { coming_soon: true },
            google: { coming_soon: true },
          },
        });
      }

      if (!pool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' },
        });
      }

      const ctx: QueryContext = { brandId: auth.brandId, correlationId: requestId };
      const client = await pool.connect();
      try {
        // Latest instance per provider (shopify + razorpay), each LEFT JOINed to its sync status.
        // Parallel reads — no sequential scan. RLS scopes brand_id via the QueryContext.
        const [shopifyResult, razorpayResult] = await Promise.all([
          queryLatestConnectorWithSync(client, ctx, auth.brandId, 'shopify'),
          queryLatestConnectorWithSync(client, ctx, auth.brandId, 'razorpay'),
        ]);

        // 'disconnected' instance rows persist for audit but present as not-connected.
        const mapConn = (row: ConnRow | undefined) =>
          row && row.status !== 'disconnected'
            ? {
                connected: row.status === 'connected',
                status: row.status,
                shop_domain: row.shop_domain || null,
                connector_instance_id: row.connector_instance_id,
                syncState: row.sync_state,
                lastSyncAt: row.last_sync_at?.toISOString() ?? null,
                lastError: row.last_error,
              }
            : { connected: false, status: 'not_connected', syncState: null, lastSyncAt: null };

        return reply.send({
          request_id: requestId,
          data: {
            shopify: mapConn(shopifyResult.rows[0]),
            razorpay: mapConn(razorpayResult.rows[0]),
            meta: { coming_soon: true },
            google: { coming_soon: true },
          },
        });
      } finally {
        client.release();
      }
    },
  );

  /**
   * GET /v1/dashboard/data-foundation-health — the readiness verdict (P1).
   * Aggregates the existing health signals (pixel installed, commerce connected + healthy, sync
   * started, events flowing & fresh, DQ trust tier) into ONE deterministic, fail-closed verdict +
   * a guided next step. This is the spine's gate: "everything depends on the data foundation."
   */
  fastify.get(
    '/api/v1/dashboard/data-foundation-health',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      if (!pool || !rawPool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' },
        });
      }
      // No active brand → the foundation hasn't started; return the honest 'blocked' verdict.
      if (!auth.brandId) {
        const blocked = computeFoundationHealth({
          pixelInstalled: false,
          commerceConnected: false,
          commerceHealthy: false,
          initialSyncStarted: false,
          firstEventReceived: false,
          freshness: 'unknown',
          dqTier: 'untrusted',
        });
        const data: ContractFoundationHealth = {
          tier: blocked.tier,
          ready: blocked.ready,
          steps: blocked.steps,
          gaps: blocked.gaps,
          next_action: blocked.nextAction,
          headline: blocked.headline,
        };
        return reply.send({ request_id: requestId, data });
      }

      const signals = await gatherFoundationSignals(auth.brandId, requestId);
      const health = computeFoundationHealth(signals);

      const result: ContractFoundationHealth = {
        tier: health.tier,
        ready: health.ready,
        steps: health.steps,
        gaps: health.gaps,
        next_action: health.nextAction,
        headline: health.headline,
      };
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /v1/entitlements — readiness-driven progressive unlock (P2).
   * What the active brand can access given its data foundation: gated centers + connector-category
   * eligibility. Connector-GENERAL (keyed on category, not per-app). The nav + marketplace consume
   * this so gating is server-driven, never hardcoded in the client. No brand → everything locked.
   */
  fastify.get(
    '/api/v1/entitlements',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;
      if (!pool || !rawPool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' },
        });
      }
      const signals: FoundationSignals = auth.brandId
        ? await gatherFoundationSignals(auth.brandId, requestId)
        : {
            pixelInstalled: false,
            commerceConnected: false,
            commerceHealthy: false,
            initialSyncStarted: false,
            firstEventReceived: false,
            freshness: 'unknown',
            dqTier: 'untrusted',
          };
      const tier = computeFoundationHealth(signals).tier;
      const ent = computeEntitlements({ tier, signals });
      const result: ContractEntitlements = {
        centers: ent.centers.map((e) => ({
          key: e.key,
          eligible: e.eligible,
          reason: e.reason,
          unlock_hint: e.unlockHint,
        })),
        connector_categories: ent.connectorCategories.map((e) => ({
          key: e.key,
          eligible: e.eligible,
          reason: e.reason,
          unlock_hint: e.unlockHint,
        })),
      };
      return reply.send({ request_id: requestId, data: result });
    },
  );

  /**
   * GET /v1/dashboard/data-status
   * Returns pixel_installation + pixel_status for the current brand.
   */
  fastify.get(
    '/api/v1/dashboard/data-status',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;

      if (!auth.brandId) {
        return reply.send({
          request_id: requestId,
          data: {
            pixel: { installed: false, state: 'not_installed', verifiedAt: null },
          },
        });
      }

      if (!pool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' },
        });
      }

      const ctx: QueryContext = { brandId: auth.brandId, correlationId: requestId };
      const client = await pool.connect();
      try {
        const result = await queryLatestPixelStatus(client, ctx, auth.brandId);

        const row = result.rows[0];
        return reply.send({
          request_id: requestId,
          data: {
            pixel: row
              ? {
                  installed: row.installed_at !== null,
                  installation_id: row.installation_id,
                  install_token: row.install_token,
                  target_host: row.target_host,
                  installedAt: row.installed_at?.toISOString() ?? null,
                  state: row.state ?? 'waiting_for_data',
                  verifiedAt: row.verified_at?.toISOString() ?? null,
                  lastError: row.last_error,
                }
              : { installed: false, state: 'not_installed', verifiedAt: null },
          },
        });
      } finally {
        client.release();
      }
    },
  );

  /**
   * GET /v1/dashboard/onboarding-progress
   * Returns deterministic onboarding step completion from control-plane state.
   * Derived entirely from Postgres tables — no external API calls.
   *
   * Steps (M1):
   *   1. email_verified   — app_user.email_verified_at IS NOT NULL
   *   2. workspace_created — membership row exists (brand_id IS NULL)
   *   3. brand_created    — at least one brand row for the workspace
   *   4. shopify_connected — connector_instance.status = 'connected'
   *   5. pixel_installed  — pixel_installation.installed_at IS NOT NULL
   */
  fastify.get(
    '/api/v1/dashboard/onboarding-progress',
    { preHandler: [bffProtectedPreHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();
      const auth = (request as AuthenticatedRequest).auth;

      if (!pool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Database not available' },
        });
      }

      const ctx: QueryContext = {
        userId: auth.userId,
        workspaceId: auth.workspaceId ?? undefined,
        brandId: auth.brandId ?? undefined,
        correlationId: requestId,
      };
      const client = await pool.connect();
      try {
        // All queries run in parallel — no sequential scan.
        const [userResult, workspaceResult, brandResult, connectorResult, pixelResult] =
          await Promise.all([
            // Step 1: email verified
            queryUserEmailVerified(client, ctx, auth.userId),
            // Step 2: workspace created (org-level membership)
            auth.workspaceId
              ? queryWorkspaceMembershipCount(client, ctx, auth.workspaceId, auth.userId)
              : Promise.resolve({ rows: [{ count: '0' }] }),
            // Step 3: brand created
            auth.workspaceId
              ? queryBrandCount(client, ctx, auth.workspaceId)
              : Promise.resolve({ rows: [{ count: '0' }] }),
            // Step 4: Shopify connected
            auth.brandId
              ? queryShopifyConnectedCount(client, ctx, auth.brandId)
              : Promise.resolve({ rows: [{ count: '0' }] }),
            // Step 5: pixel installed
            auth.brandId
              ? queryPixelInstalledCount(client, ctx, auth.brandId)
              : Promise.resolve({ rows: [{ count: '0' }] }),
          ]);

        const steps = [
          {
            key: 'email_verified',
            label: 'Verify your email',
            completed: userResult.rows[0]?.email_verified_at !== null &&
              userResult.rows[0]?.email_verified_at !== undefined,
          },
          {
            key: 'workspace_created',
            label: 'Create your workspace',
            completed: parseInt(workspaceResult.rows[0]?.count ?? '0', 10) > 0,
          },
          {
            key: 'brand_created',
            label: 'Add your first brand',
            completed: parseInt(brandResult.rows[0]?.count ?? '0', 10) > 0,
          },
          {
            key: 'shopify_connected',
            label: 'Connect Shopify',
            completed: parseInt(connectorResult.rows[0]?.count ?? '0', 10) > 0,
          },
          {
            key: 'pixel_installed',
            label: 'Install the Brain pixel',
            completed: parseInt(pixelResult.rows[0]?.count ?? '0', 10) > 0,
          },
        ];

        const completedCount = steps.filter((s) => s.completed).length;

        return reply.send({
          request_id: requestId,
          data: {
            steps,
            completed_count: completedCount,
            total_count: steps.length,
            all_complete: completedCount === steps.length,
          },
        });
      } finally {
        client.release();
      }
    },
  );

  /**
   * GET /api/v1/dashboard/realized-revenue?as_of=<YYYY-MM-DD>
   *
   * Returns realized + provisional revenue for the active brand via the metric engine.
   *
   * ADR-002 SOLE READ PATH: this route calls getRevenueMetrics (analytics module)
   * which calls computeRealizedRevenue / computeProvisionalRevenue from @brain/metric-engine.
   * NO ad-hoc SUM(amount_minor) here — the ONLY SQL in this path is the EXISTS check
   * (inside the analytics use-case) and the named seam calls in the engine.
   *
   * Honest-empty-state (D-2): state='no_data' when no finalized rows exist.
   * NEVER returns a bare 0 without the state discriminant.
   *
   * as_of validation (D-9): schema-validated via Fastify JSON schema; invalid/garbage
   * returns 400 INVALID_DATE before the handler runs.
   *
   * Pool (D §3.1, F-SEC-02): uses rawPool (pg.Pool) — NOT the DbPool wrapper —
   * so withBrandTxn can set the GUC transaction-locally without double-GUC.
   *
   * Brand from session (D-1): brand_id comes from auth.brandId, NEVER from request body.
   */
  fastify.get(
    '/api/v1/dashboard/realized-revenue',
    {
      preHandler: [bffProtectedPreHandler],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            as_of: {
              type: 'string',
              pattern: '^\\d{4}-\\d{2}-\\d{2}$',
            },
          },
          additionalProperties: false,
        },
      },
      // Fastify schema validation errors return 400; we override the reply to match
      // the INVALID_DATE contract (D-9).
      attachValidation: true,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = randomUUID();

      // D-9: as_of schema validation — Fastify sets validationError on the request
      // when attachValidation:true and the schema fails.
      const validationError = (request as FastifyRequest & { validationError?: Error }).validationError;
      if (validationError) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'INVALID_DATE', message: 'as_of must be YYYY-MM-DD.' },
        });
      }

      const auth = (request as AuthenticatedRequest).auth;

      // Honest-empty: no active brand yet → no_data (matches BFF pattern at bff.routes.ts:569)
      if (!auth.brandId) {
        const today = new Date().toISOString().split('T')[0] as string;
        return reply.send({
          request_id: requestId,
          data: {
            state: 'no_data',
            as_of: today,
            realized: null,
            provisional: null,
          },
        });
      }

      // Pool guard: the dashboard snapshot now reads the lakehouse gold ledger (PHASE G follow-up),
      // so the Silver/Gold pool is required (billing still reads PG; this is the dashboard path).
      if (!srPool) {
        return reply.code(503).send({
          request_id: requestId,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Silver tier not available' },
        });
      }

      // as_of: use provided value or default to today (server-side, never client-trusted — Open-Q1)
      const query = request.query as { as_of?: string };
      const asOfStr = query.as_of ?? (new Date().toISOString().split('T')[0] as string);
      const asOf = new Date(`${asOfStr}T00:00:00Z`);

      // Call the analytics use-case — the SOLE read path (ADR-002, D-3)
      const snapshot: ContractRevenueSnapshot = await getRevenueMetrics(auth.brandId, asOf, { srPool });

      return reply.send({
        request_id: requestId,
        data: snapshot,
      });
    },
  );
}
