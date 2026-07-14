/**
 * registerWebhookRoutes — registers all 4 provider webhook pipelines on a Fastify instance.
 *
 * Called once from main.ts (replacing the 4 individual register* calls).
 *
 * The Shopify route needs the `:topic` URL param available to the Strategy. We inject it into
 * a custom request header (x-wh-topic) before delegating to the pipeline's handle() method —
 * this keeps the pipeline handler generic while preserving the existing Shopify route contract.
 *
 * Architecture: each provider gets a WebhookPipeline (Template Method) + a WebhookStrategy
 * (Strategy for signatureVerify + payloadMap). The pipeline owns all common steps.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Producer } from 'kafkajs';
import type pg from 'pg';
import type { Redis } from 'ioredis';
import type { ISecretsManager } from '@brain/connector-secrets';

import { WebhookPipeline, type WebhookPipelineDeps } from './WebhookPipeline.js';
import type { WebhookIdentityReader } from './IWebhookStrategy.js';
import type { ErasureEventPublisher } from '../../../../infrastructure/events/ErasureEventPublisher.js';
import { ShopifyWebhookStrategy } from '../strategies/ShopifyWebhookStrategy.js';
import { resolveBrandOAuthAppCreds } from '../../oauth-app-creds.js';
import { getDefinition } from '../../catalog/index.js';
import { RazorpayWebhookStrategy } from '../strategies/RazorpayWebhookStrategy.js';
import { ShopfloWebhookStrategy } from '../strategies/ShopfloWebhookStrategy.js';
import { WooCommerceWebhookStrategy } from '../strategies/WooCommerceWebhookStrategy.js';
import { ShiprocketWebhookStrategy, timingSafeTokenEqual } from '../strategies/ShiprocketWebhookStrategy.js';
import { GokwikWebhookStrategy } from '../strategies/GokwikWebhookStrategy.js';

export interface WebhookRegistrationDeps {
  secretsManager: ISecretsManager;
  rawPgPool: pg.Pool;
  producer: Producer;
  liveTopic: string;
  getSaltHex: (brandId: string) => Promise<string>;
  redis: Redis;
  regionCode?: string;
  /** MEDALLION REALIGNMENT (Epic 3 / ADR-0004): Neo4j identity reader for GDPR redact side-effects. */
  identityReader?: WebhookIdentityReader;
  /**
   * AUD-OPS-036 — the RTBF erasure-trigger bridge for Shopify customers/redact. Optional:
   * absent → the redact side-effect keeps its pre-bridge (synchronous-only) behavior.
   */
  erasureEventPublisher?: ErasureEventPublisher;
  /**
   * SPEC: A.1.4 (WA-09) — per-brand `connector.identity_fields` flag resolver (platform-flags).
   * OPTIONAL + FAIL-CLOSED (absent → flag OFF → today's envelope byte-identical).
   */
  isIdentityFieldsEnabled?: (brandId: string) => Promise<boolean>;
  /**
   * CRIT-2 OVERRIDE (optional): resolve the Shopify webhook HMAC signing key (the brand's app
   * `client_secret`) for a shop domain. When omitted, a default resolver is built from
   * secretsManager + rawPgPool below. Injectable so tests can stub it.
   */
  shopifyHmacSecretResolver?: (shopDomain: string) => Promise<string>;
}

export function registerAllWebhookRoutes(
  fastify: FastifyInstance,
  deps: WebhookRegistrationDeps,
): void {
  const pipelineDeps: WebhookPipelineDeps = {
    secretsManager: deps.secretsManager,
    rawPgPool: deps.rawPgPool,
    producer: deps.producer,
    liveTopic: deps.liveTopic,
    getSaltHex: deps.getSaltHex,
    redis: deps.redis,
    regionCode: deps.regionCode ?? 'IN',
    identityReader: deps.identityReader,
    // SPEC: A.1.4 (WA-09) — connector.identity_fields flag resolver (fail-closed when absent).
    isIdentityFieldsEnabled: deps.isIdentityFieldsEnabled,
  };

  // ── Shopify HMAC secret resolver (CRIT-2) ─────────────────────────────────
  // Shopify signs webhooks with the app `client_secret` (BYO per-brand app → Brain's app fallback,
  // UNLESS the catalog says byoAppRequired — then the env app is refused), NOT a per-connector
  // webhook_secret the OAuth connect flow never stored. Resolve the brand from the shop domain
  // (SECURITY DEFINER resolver, RLS-bypassing — brand unknown pre-auth), then the brand's app
  // client_secret. Fail-closed: any miss returns '' → HMAC_INVALID (no spoofed events).
  const shopifyDef = getDefinition('shopify');
  const shopifyRequiresBrandCreds = shopifyDef?.byoAppRequired ?? false;

  const shopifyHmacSecretResolver =
    deps.shopifyHmacSecretResolver ??
    (async (shopDomain: string): Promise<string> => {
      const sd = shopDomain.trim();
      if (!sd) return '';
      let brandId = '';
      try {
        const r = await deps.rawPgPool.query<{ brand_id: string }>(
          `SELECT brand_id FROM resolve_connector_by_shop_domain($1)`,
          [sd],
        );
        brandId = r.rows[0]?.brand_id ?? '';
      } catch {
        return '';
      }
      if (!brandId) return '';

      // BYO-required (Shopify): env fallback is FORBIDDEN — its secret fetch is skipped entirely.
      // If the brand has no stored app secret, return '' → HMAC_INVALID (existing installs on the
      // env app are handled by the boot-time reconnect migration; see Task 10). Fail-closed.
      const envFallback = shopifyRequiresBrandCreds
        ? null
        : {
            clientId: process.env['SHOPIFY_CLIENT_ID'] ?? '',
            // Brain's app secret (env in dev; ARN-resolved value in prod). May be unset for pure-BYO setups.
            clientSecret: await deps.secretsManager.getShopifyClientSecret().catch(() => ''),
          };

      const creds = await resolveBrandOAuthAppCreds(
        deps.secretsManager,
        'shopify',
        brandId,
        envFallback,
        { requireBrandCreds: shopifyRequiresBrandCreds },
      );
      return creds?.clientSecret ?? '';
    });

  // ── Shopify: POST /api/v1/webhooks/shopify/:topic ─────────────────────────
  // Topic param injected as x-wh-topic header for the Strategy.
  {
    const pipeline = new WebhookPipeline(
      // AUD-OPS-036: the erasure publisher lets customers/redact bridge to the async
      // full-erasure orchestrator (in addition to the synchronous eraseCustomer side-effect).
      new ShopifyWebhookStrategy(shopifyHmacSecretResolver, deps.erasureEventPublisher),
      {
        path: '/api/v1/webhooks/shopify/:topic', // used only as config label here
        resolverFn: 'resolve_connector_by_shop_domain',
        resolverArg: (req: FastifyRequest) =>
          (req.headers['x-shopify-shop-domain'] as string | undefined) ?? '',
        topicLabel: (req: FastifyRequest) =>
          (req.params as { topic?: string }).topic ?? 'unknown',
      },
      pipelineDeps,
    );

    fastify.post(
      '/api/v1/webhooks/shopify/:topic',
      { config: { rawBody: true } },
      async (req: FastifyRequest<{ Params: { topic: string } }>, reply: FastifyReply) => {
        // Inject URL param as a custom header so the Strategy can read it uniformly.
        (req.headers as Record<string, string>)['x-wh-topic'] = req.params.topic ?? '';
        return pipeline.handleRequest(req, reply);
      },
    );
  }

  // ── Razorpay: POST /api/v1/webhooks/razorpay ─────────────────────────────
  {
    const pipeline = new WebhookPipeline(
      new RazorpayWebhookStrategy(),
      {
        path: '/api/v1/webhooks/razorpay',
        resolverFn: 'resolve_razorpay_connector_by_account',
        resolverArg: (_req, parsedBody) =>
          ((parsedBody as { account_id?: string } | null)?.account_id) ?? '',
        topicLabel: (_req, parsedBody) =>
          ((parsedBody as { event?: string } | null)?.event) ?? 'unknown',
      },
      pipelineDeps,
    );
    pipeline.register(fastify);
  }

  // ── Shopflo: POST /api/v1/webhooks/shopflo ───────────────────────────────
  {
    const pipeline = new WebhookPipeline(
      new ShopfloWebhookStrategy(),
      {
        path: '/api/v1/webhooks/shopflo',
        resolverFn: 'resolve_shopflo_connector_by_merchant',
        resolverArg: (_req, parsedBody) =>
          ((parsedBody as { merchant_id?: string } | null)?.merchant_id) ?? '',
        topicLabel: (_req, parsedBody) =>
          ((parsedBody as { event?: string } | null)?.event) ?? 'unknown',
      },
      pipelineDeps,
    );
    pipeline.register(fastify);
  }

  // ── WooCommerce: POST /api/v1/webhooks/woocommerce ───────────────────────
  {
    const pipeline = new WebhookPipeline(
      new WooCommerceWebhookStrategy(),
      {
        path: '/api/v1/webhooks/woocommerce',
        resolverFn: 'resolve_woocommerce_connector_by_site',
        resolverArg: (req) => {
          const sourceUrl = (req.headers['x-wc-webhook-source'] as string | undefined)?.trim() ?? '';
          return sourceUrl.replace(/\/+$/, '');
        },
        topicLabel: (req) =>
          (req.headers['x-wc-webhook-topic'] as string | undefined) ?? 'unknown',
      },
      pipelineDeps,
    );
    pipeline.register(fastify);
  }

  // ── Shiprocket: POST /api/v1/webhooks/shiprocket ─────────────────────────
  // Verification: X-Api-Key shared-token compare (token scheme, not HMAC).
  // Lookup key: x-shiprocket-channel-id header (fallback: x-shiprocket-account-id), and — when
  //   the merchant's webhook config can't set custom headers — a TOKEN FALLBACK that resolves
  //   the tenant from the Brain-minted X-Api-Key itself (see resolver below).
  // Resolver fn: resolve_shiprocket_connector_by_channel (SECURITY DEFINER).
  // FAIL-CLOSED: if webhook_secret is unset in the connector secret bundle,
  //   verification fails — surfaces 'not connected / needs credentials'. No spoofed events.
  {
    // TENANT-ROUTING TOKEN FALLBACK (header-less deliveries): enumerate connected Shiprocket
    // connectors (list_shiprocket_connectors_for_webhook, SECURITY DEFINER — migration 0128) and
    // timing-safe-compare the presented token against each bundle's webhook_secret. The token is
    // Brain-MINTED (SR-2, high-entropy, unique per connector) so a match uniquely identifies the
    // tenant; lookup_key = COALESCE(channel_id, account_key), the same value
    // resolve_shiprocket_connector_by_channel resolves — Step-3 brand resolution works unchanged.
    // Fail-closed: any error / no match → null → LOOKUP_KEY_MISSING (no spoofed events). The
    // Shiprocket connector count per deployment is small, so the linear scan is bounded; the
    // strategy only invokes this when BOTH routing headers are absent.
    const resolveShiprocketLookupKeyByToken = async (receivedToken: string): Promise<string | null> => {
      if (!receivedToken) return null;
      try {
        const result = await deps.rawPgPool.query<{ secret_ref: string; lookup_key: string | null }>(
          `SELECT secret_ref, lookup_key FROM list_shiprocket_connectors_for_webhook()`,
        );
        for (const row of result.rows) {
          if (!row.lookup_key) continue;
          const creds = await deps.secretsManager.getSecret(row.secret_ref).catch(() => null);
          const stored = creds?.['webhook_secret'] ?? '';
          if (stored && timingSafeTokenEqual(receivedToken, stored)) return row.lookup_key;
        }
      } catch {
        /* fail-closed — the strategy throws LOOKUP_KEY_MISSING */
      }
      return null;
    };

    const pipeline = new WebhookPipeline(
      new ShiprocketWebhookStrategy(resolveShiprocketLookupKeyByToken),
      {
        path: '/api/v1/webhooks/shiprocket',
        resolverFn: 'resolve_shiprocket_connector_by_channel',
        resolverArg: (req) =>
          (req.headers['x-shiprocket-channel-id'] as string | undefined)?.trim() ||
          (req.headers['x-shiprocket-account-id'] as string | undefined)?.trim() ||
          '',
        topicLabel: (_req, parsedBody) => {
          const b = parsedBody as Record<string, unknown> | null;
          return (
            (b?.['event'] as string | undefined) ??
            (b?.['topic'] as string | undefined) ??
            (b?.['webhook_type'] as string | undefined) ??
            'unknown'
          );
        },
      },
      pipelineDeps,
    );
    pipeline.register(fastify);
  }

  // ── GoKwik: POST /api/v1/webhooks/gokwik ─────────────────────────────────
  // Real-time payment/order/delivery status (POC-mediated delivery). HMAC-gated, fail-closed.
  // Lookup key: x-gokwik-appid header, else appid/merchant_id in the body.
  // Resolver fn: resolve_gokwik_connector_by_merchant (SECURITY DEFINER, 0108) — by gokwik_appid.
  {
    const pipeline = new WebhookPipeline(
      new GokwikWebhookStrategy(),
      {
        path: '/api/v1/webhooks/gokwik',
        resolverFn: 'resolve_gokwik_connector_by_merchant',
        resolverArg: (req, parsedBody) => {
          const hdr = (req.headers['x-gokwik-appid'] as string | undefined)?.trim();
          if (hdr) return hdr;
          const b = parsedBody as Record<string, unknown> | null;
          for (const k of ['appid', 'app_id', 'gokwik_appid', 'merchant_id', 'mid']) {
            const v = b?.[k];
            if (typeof v === 'string' && v.trim()) return v.trim();
          }
          return '';
        },
        topicLabel: (_req, parsedBody) => {
          const b = parsedBody as Record<string, unknown> | null;
          return (
            (b?.['event'] as string | undefined) ??
            (b?.['event_type'] as string | undefined) ??
            (b?.['type'] as string | undefined) ??
            'unknown'
          );
        },
      },
      pipelineDeps,
    );
    pipeline.register(fastify);
  }
}
