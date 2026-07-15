/**
 * RegisterWebhooksCommand — register Shopify order webhooks on connect/enable-live-sync.
 *
 * Registers the five order event topics (create/updated/paid/fulfilled/cancelled)
 * to the receiver URL so Shopify can deliver live events.
 *
 * ADR-LV-5 (D-5): ENV-GATED NO-OP IN DEV.
 * The callback URL is not publicly reachable in dev — attempting registration
 * would either fail or register an unreachable URL. In dev, the stub logs the
 * skipped registration and returns. The production code path is present and
 * ships in this slice; real delivery requires public-ingress (platform follow-up).
 *
 * SECURITY: The Shopify access token (from secretRef) is used only for the
 * registration API call and is never logged (I-S09).
 */

import type { ISecretsManager } from '@brain/connector-secrets';
import { log } from "../../../../../../../log.js";

/** Shopify Admin API version used for webhook registration. */
const SHOPIFY_API_VERSION = '2025-07' as const;

/**
 * Webhook topics to register (B2 / ADR-LV-5 + shopify-compliance-token-lifecycle).
 *
 * Order topics (live event lane):
 *   orders/create, orders/updated, orders/paid, orders/fulfilled, orders/cancelled
 *
 * GDPR mandatory compliance topics (Shopify Partner requirement):
 *   customers/data_request — data export request (48h SLA; ack only).
 *   customers/redact       — GDPR/DPDP erasure; routes to erase_customer SECURITY DEFINER.
 *   shop/redact            — shop-level deletion (ack + ops runbook).
 *
 * App lifecycle:
 *   app/uninstalled — marks ConnectorInstance Disconnected + invalidates secret.
 *
 * Resource topics (P1 webhook expansion — real-time peers of the scheduled resource backfills):
 *   products/create|update, customers/create|update, refunds/create,
 *   fulfillments/create|update, inventory_levels/update
 *   Mapped in ShopifyWebhookStrategy with the SAME deterministic dedup ids the resumable backfill
 *   derives, so a record seen on both lanes lands ONCE in Bronze (live↔backfill dedup parity).
 */
// GDPR/DPDP MANDATORY COMPLIANCE webhooks (customers/data_request, customers/redact, shop/redact)
// are DELIBERATELY NOT here: Shopify does NOT accept them via the Admin webhook-subscription API —
// a POST returns 404 "Could not find the webhook topic customers/data_request". They are configured
// on the APP itself (Partner Dashboard → App setup → Compliance webhooks / shopify.app.toml), which
// delivers them to Brain's /shopify/customers_data_request, /customers_redact, /shop_redact routes.
// Registering them here previously THREW on the 404 and aborted the loop, so every topic AFTER them
// (products/customers/refunds/fulfillments/inventory) was silently never registered. (2026-07-16.)
const ALL_WEBHOOK_TOPICS = [
  'orders/create',
  'orders/updated',
  'orders/paid',
  'orders/fulfilled',
  'orders/cancelled',
  'app/uninstalled',
  // P1 webhook expansion — resource grains (products/customers/refunds/fulfillments/inventory):
  'products/create',
  'products/update',
  'customers/create',
  'customers/update',
  'refunds/create',
  'fulfillments/create',
  'fulfillments/update',
  'inventory_levels/update',
] as const;

export interface RegisterWebhooksInput {
  /** Brand's Shopify shop domain (e.g. 'mystore.myshopify.com'). */
  shopDomain: string;
  /** secret_ref ARN for the Shopify OAuth access token. */
  secretRef: string;
  /** Public callback URL for webhook delivery (must be HTTPS in prod). */
  callbackBaseUrl: string;
}

export interface RegisterWebhooksResult {
  /** Whether registration ran (false in dev — stubbed). */
  registered: boolean;
  /** Number of topics registered (0 in dev). */
  topicCount: number;
}

export class RegisterWebhooksCommand {
  constructor(
    private readonly secretsManager: ISecretsManager,
    private readonly appEnv: string,
  ) {}

  /**
   * Register Shopify order webhooks for a connector.
   *
   * In dev (APP_ENV !== 'production'): logs skip message and returns.
   * In prod: calls PUT /admin/api/{version}/webhooks.json for each topic.
   */
  async execute(input: RegisterWebhooksInput): Promise<RegisterWebhooksResult> {
    // ── D-5: Dev no-op guard ──────────────────────────────────────────────────
    // The dev callback URL is non-public — Shopify cannot reach localhost.
    // Real webhook delivery requires public ingress (platform follow-up slice).
    if (this.appEnv !== 'production') {
      log.info(`[RegisterWebhooksCommand] dev: webhook registration stubbed ` +
                  `(shop=${input.shopDomain} — callback URL is non-public in dev). ` +
                  `Real delivery requires public-ingress follow-up. ` +
                  `In dev, use synthetic HMAC-signed POST tests to validate the receiver path.`);
      return { registered: false, topicCount: 0 };
    }

    // ── Production code path ──────────────────────────────────────────────────
    // Fetch the Shopify access token (I-S09: never log the token value).
    const accessToken = await this.secretsManager.getShopifyToken(input.secretRef);
    if (!accessToken) {
      throw new Error(
        `[RegisterWebhooksCommand] no access token found for secret_ref=${input.secretRef} — reconnect required`,
      );
    }

    const callbackUrl = `${input.callbackBaseUrl}/api/v1/webhooks/shopify`;
    const webhooksUrl = `https://${input.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/webhooks.json`;

    // ── Idempotency: read the shop's existing subscriptions first ──────────────
    // Treat a (topic → already pointed at our callback host) as already-registered and skip the POST,
    // so reconnect / re-run never throws on Shopify 422 "address ... has already been taken". Best
    // effort: if the GET fails we proceed to POST and rely on the per-topic 422-as-success guard below.
    const existingTopics = await this.fetchExistingTopics(webhooksUrl, callbackUrl, accessToken);

    let registered = 0;
    for (const topic of ALL_WEBHOOK_TOPICS) {
      if (existingTopics.has(topic)) {
        registered += 1; // already subscribed for this topic at our callback host
        continue;
      }

      // Canonical encoding (matcher↔registrar alignment): the body `topic` is the slash form Shopify
      // echoes back in X-Shopify-Topic (authoritative for the matcher). The address path segment encodes
      // the slash as '_' so it is a single valid URL segment for Brain's `/shopify/:topic` route.
      const topicPath = topic.replace(/\//g, '_'); // e.g. 'orders/create' → 'orders_create'

      const response = await fetch(webhooksUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // I-S09: access token is used here, not logged
          'X-Shopify-Access-Token': accessToken,
        },
        body: JSON.stringify({
          webhook: {
            topic,
            address: `${callbackUrl}/${topicPath}`,
            format: 'json',
          },
        }),
        signal: AbortSignal.timeout(15_000), // T2-9: bound the Shopify call so registration can't hang.
      });

      if (response.ok) {
        registered += 1;
        log.info(`registered webhook topic=${topic} for shop=${input.shopDomain}`);
        continue;
      }

      // 422 "address ... has already been taken" → the subscription already exists. Idempotent success.
      if (response.status === 422) {
        const body = await response.text().catch(() => '');
        if (/already been taken|has already|taken/i.test(body)) {
          registered += 1;
          log.info(`webhook topic=${topic} already registered for shop=${input.shopDomain} (422 treated as success)`);
          continue;
        }
        throw new Error(
          `[RegisterWebhooksCommand] failed to register topic=${topic} status=422: ${body.slice(0, 200)}`,
        );
      }

      const body = await response.text().catch(() => '');
      // 404 "Could not find the webhook topic …" → Shopify doesn't accept this topic via the
      // subscription API (e.g. an app-config-only compliance webhook, or a topic removed in the
      // pinned API version). SKIP it — a single unregisterable topic must never abort registration
      // of the remaining resource webhooks (regression fixed 2026-07-16). Other non-OK statuses
      // (401/403/5xx) are genuine failures and still throw.
      if (response.status === 404) {
        log.warn(
          `webhook topic=${topic} not registerable via API (404) for shop=${input.shopDomain} — skipping: ${body.slice(0, 120)}`,
        );
        continue;
      }
      throw new Error(
        `[RegisterWebhooksCommand] failed to register topic=${topic} status=${response.status}: ${body.slice(0, 200)}`,
      );
    }

    return { registered: true, topicCount: registered };
  }

  /**
   * GET the shop's existing webhook subscriptions and return the set of topics already pointed at our
   * callback host. Best-effort: any error (network/parse) yields an empty set so the caller falls back
   * to POST + the 422-as-success guard. The access token is used here and NEVER logged (I-S09).
   */
  private async fetchExistingTopics(
    webhooksUrl: string,
    callbackUrl: string,
    accessToken: string,
  ): Promise<Set<string>> {
    const out = new Set<string>();
    try {
      const response = await fetch(webhooksUrl, {
        method: 'GET',
        headers: { 'X-Shopify-Access-Token': accessToken },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return out;
      const data = (await response.json()) as { webhooks?: Array<{ topic?: string; address?: string }> };
      for (const w of data.webhooks ?? []) {
        // Only treat as "already registered" when it points at OUR callback host — a subscription to a
        // different address must be (re)created so live delivery reaches Brain.
        if (w.topic && typeof w.address === 'string' && w.address.startsWith(callbackUrl)) {
          out.add(w.topic);
        }
      }
    } catch {
      // best-effort — fall through to POST + 422-as-success
    }
    return out;
  }
}
