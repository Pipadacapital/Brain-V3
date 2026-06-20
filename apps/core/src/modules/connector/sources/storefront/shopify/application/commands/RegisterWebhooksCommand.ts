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

/** Order webhook topics to register (B2 / ADR-LV-5). */
const ORDER_WEBHOOK_TOPICS = [
  'orders/create',
  'orders/updated',
  'orders/paid',
  'orders/fulfilled',
  'orders/cancelled',
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
    let registered = 0;

    for (const topic of ORDER_WEBHOOK_TOPICS) {
      const url = `https://${input.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/webhooks.json`;
      const topicPath = topic.replace('/', '_'); // e.g. 'orders_create'

      const response = await fetch(url, {
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
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(
          `[RegisterWebhooksCommand] failed to register topic=${topic} status=${response.status}: ${body.slice(0, 200)}`,
        );
      }

      registered += 1;
      log.info(`registered webhook topic=${topic} for shop=${input.shopDomain}`);
    }

    return { registered: true, topicCount: registered };
  }
}
