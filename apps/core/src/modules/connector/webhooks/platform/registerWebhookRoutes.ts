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
import { ShopifyWebhookStrategy } from '../strategies/ShopifyWebhookStrategy.js';
import { RazorpayWebhookStrategy } from '../strategies/RazorpayWebhookStrategy.js';
import { ShopfloWebhookStrategy } from '../strategies/ShopfloWebhookStrategy.js';
import { WooCommerceWebhookStrategy } from '../strategies/WooCommerceWebhookStrategy.js';
import { ShiprocketWebhookStrategy } from '../strategies/ShiprocketWebhookStrategy.js';
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
  };

  // ── Shopify: POST /api/v1/webhooks/shopify/:topic ─────────────────────────
  // Topic param injected as x-wh-topic header for the Strategy.
  {
    const pipeline = new WebhookPipeline(
      new ShopifyWebhookStrategy(),
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
  // Lookup key: x-shiprocket-channel-id header (fallback: x-shiprocket-account-id).
  // Resolver fn: resolve_shiprocket_connector_by_channel (SECURITY DEFINER).
  // FAIL-CLOSED: if webhook_secret is unset in the connector secret bundle,
  //   verification fails — surfaces 'not connected / needs credentials'. No spoofed events.
  {
    const pipeline = new WebhookPipeline(
      new ShiprocketWebhookStrategy(),
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
