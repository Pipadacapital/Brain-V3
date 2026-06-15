/**
 * shopifyWebhookHandler — handles Shopify webhook callbacks.
 *
 * NN-4: HMAC validation is the absolute first operation on every webhook.
 * Any failure → 401, no further processing.
 *
 * Registered at: POST /api/v1/webhooks/shopify/:topic
 *
 * The raw body must be read BEFORE any JSON parse so the HMAC can be
 * computed over the original bytes (Shopify signs the raw body).
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ShopifyHmac } from '../../domain/value-objects/ShopifyHmac.js';
import type { ISecretsManager } from '../../infrastructure/secrets/ISecretsManager.js';

export interface WebhookHandlerDeps {
  secretsManager: ISecretsManager;
  emitEvent: (eventName: string, payload: Record<string, unknown>) => Promise<void>;
}

export function registerShopifyWebhookRoutes(
  fastify: FastifyInstance,
  deps: WebhookHandlerDeps,
): void {
  const { secretsManager, emitEvent } = deps;

  // POST /api/v1/webhooks/shopify/:topic
  // Shopify sends webhooks to this path.
  // rawBody must be available (configure Fastify's addContentTypeParser or preParsing hook).
  fastify.post(
    '/api/v1/webhooks/shopify/:topic',
    {
      config: { rawBody: true }, // Fastify raw-body plugin option
    },
    async (
      req: FastifyRequest<{
        Params: { topic: string };
        Headers: { 'x-shopify-hmac-sha256'?: string; 'x-shopify-shop-domain'?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const requestId = (req.id as string) ?? crypto.randomUUID();

      // ── Step 1: HMAC validation FIRST (NN-4) ─────────────────────────────
      const hmacHeader = req.headers['x-shopify-hmac-sha256'] ?? '';
      // rawBody is the raw Buffer; requires @fastify/rawbody or equivalent plugin.
      const rawBody = (req as FastifyRequest & { rawBody?: Buffer }).rawBody;
      if (!rawBody) {
        return reply.code(400).send({
          request_id: requestId,
          error: { code: 'RAW_BODY_MISSING', message: 'Raw body not available' },
        });
      }

      const clientSecret = await secretsManager.getShopifyClientSecret();
      const hmacValid = ShopifyHmac.validateWebhook(rawBody, hmacHeader, clientSecret);
      if (!hmacValid) {
        return reply.code(401).send({
          request_id: requestId,
          error: { code: 'HMAC_INVALID', message: 'Webhook authentication failed' },
        });
      }

      // ── Step 2: Process webhook ───────────────────────────────────────────
      const topic = req.params.topic;
      const shopDomain = req.headers['x-shopify-shop-domain'] ?? 'unknown';
      const body = req.body as Record<string, unknown>;

      // Emit as a domain event for downstream consumers
      await emitEvent(`shopify.webhook.${topic}`, {
        shop_domain: shopDomain,
        topic,
        payload: body,
      });

      // Shopify expects a 200 response quickly
      return reply.code(200).send({ request_id: requestId, received: true });
    },
  );
}
