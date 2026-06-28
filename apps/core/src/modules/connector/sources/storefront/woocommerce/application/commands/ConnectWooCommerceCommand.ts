/**
 * ConnectWooCommerceCommand — credential-based WooCommerce connector connect + validate lifecycle.
 *
 * Mirrors ConnectShopfloCommand / ConnectRazorpayCommand. Stores three WooCommerce credentials
 * as ONE composite JSON bundle under a single secret_ref per connector_instance:
 *   { consumer_key, consumer_secret, webhook_secret }
 *
 * Lifecycle:
 *   1. validate() — capability probe: issues a lightweight GET /wp-json/wc/v3/system_status
 *      request to confirm the REST API is reachable and the consumer key/secret are valid.
 *      Returns { valid: false, reason: '...' } on auth failure (401/403) or network error
 *      so the BFF can surface a clean credential-error message before touching any state.
 *   2. execute() — stores the credential bundle, creates ConnectorInstance + ConnectorSyncStatus,
 *      sets woocommerce_site_url on the row (for resolve_woocommerce_connector_by_site webhook
 *      brand resolution), registers outbound webhooks via the WC REST /webhooks API, then emits
 *      connector.connected.
 *
 * Webhook auto-registration:
 *   POST /wp-json/wc/v3/webhooks for each topic in WC_WEBHOOK_TOPICS — the FULL resource set
 *   (order.*, customer.*, product.*, coupon.* created/updated/deleted) so the store is subscribed to
 *   send every resource, not just orders (closes the orders-only gap). Idempotent: topics already
 *   pointing at our delivery URL are skipped. The delivery URL is constructed from BRAIN_WEBHOOK_BASE_URL.
 *
 * Invariants:
 *   - consumer_key + consumer_secret + webhook_secret are NEVER logged (I-S09).
 *   - woocommerce_site_url is the (non-secret) webhook lookup key — stored on connector_instance
 *     and used by resolve_woocommerce_connector_by_site() (SECURITY DEFINER) for MT-1.
 *   - NN-2: only the ARN (secret_ref) is stored in connector_instance — never credential values.
 *   - If webhook auto-registration fails the connect still succeeds (non-fatal); the job backfill
 *     continues to work via polling.
 */

import { loadCoreConfig } from '@brain/config';
import type { ISecretsManager } from '@brain/connector-secrets';
import type { IConnectorInstanceRepository, IConnectorSyncStatusRepository } from '@brain/connector-core';
import { ConnectorInstance, ConnectorSyncStatus } from '@brain/connector-core';
import { assertSingleStorefront } from '../../../storefront-exclusivity.js';
import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { log } from '../../../../../../../log.js';
import { getDefinition } from '../../../../../catalog/index.js';
import { planCredentialConnect, provisionGeneratedSecrets } from '../../../../../credential-schema.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ConnectWooCommerceInput {
  brandId: string;
  /** WooCommerce store base URL (https://store.example.com). Non-secret lookup key. */
  siteUrl: string;
  /** WC REST API consumer key (ck_…). Never logged (I-S09). */
  consumerKey: string;
  /** WC REST API consumer secret (cs_…). Never logged (I-S09). */
  consumerSecret: string;
  idempotencyKey: string;
}

export interface ValidateWooCommerceInput {
  siteUrl: string;
  consumerKey: string;
  consumerSecret: string;
}

export interface ValidateWooCommerceResult {
  valid: boolean;
  reason?: string;
}

export interface ConnectWooCommerceResult {
  connectorInstanceId: string;
  status: 'connected';
  webhooksRegistered: string[];
  webhookRegistrationErrors: string[];
}

// ── Webhook topics to auto-register ──────────────────────────────────────────
//
// FULL resource coverage (was orders-only — the direct cause of "orders show, nothing else"): the
// WooCommerceWebhookStrategy maps customer.* → customer.upsert.v1, product.* → product.upsert.v1,
// coupon.* → coupon.upsert.v1, order.* → order.live.v1, so the store must be SUBSCRIBED to send them.
// These are all native wc/v3 webhook topics (resource.event). `*.deleted` are subscribed for
// forward-compatibility (the strategy fast-acks them today — no canonical hard-delete grain yet).
// `order.refunded` is NOT a native Woo topic, so it is NOT auto-registered here (registering an
// unknown topic 400s); the strategy still HANDLES it if a merchant adds a custom action topic, and
// real-time refunds otherwise ride order.updated → order.live.v1 + the /orders/<id>/refunds backfill.
const WC_WEBHOOK_TOPICS = [
  'order.created',
  'order.updated',
  'order.deleted',
  'customer.created',
  'customer.updated',
  'customer.deleted',
  'product.created',
  'product.updated',
  'product.deleted',
  'coupon.created',
  'coupon.updated',
  'coupon.deleted',
] as const;

// Delivery URL for WooCommerce outbound webhooks.
function webhookDeliveryUrl(): string {
  const base = loadCoreConfig().BRAIN_WEBHOOK_BASE_URL.replace(/\/+$/, '');
  return `${base}/api/v1/webhooks/woocommerce`;
}

// ── WooCommerceApiProbe — thin HTTP probe (no dependency on WooCommerceClient) ─

/**
 * Build Basic auth header. Kept inline to avoid importing the full WooCommerceClient
 * (which has fixture/dev-mode logic not appropriate in the core command layer).
 * Credentials are NEVER logged (I-S09).
 */
function buildBasicAuth(consumerKey: string, consumerSecret: string): string {
  return 'Basic ' + Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
}

/**
 * GET /wp-json/wc/v3/system_status — lightweight capability probe.
 * Returns { ok: true } on 200; { ok: false, status } on any non-2xx.
 * Throws on network error.
 */
async function probeSystemStatus(
  siteUrl: string,
  consumerKey: string,
  consumerSecret: string,
): Promise<{ ok: boolean; status: number }> {
  const normalizedBase = siteUrl.replace(/\/+$/, '');
  const url = `${normalizedBase}/wp-json/wc/v3/system_status`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: buildBasicAuth(consumerKey, consumerSecret),
      Accept: 'application/json',
    },
  });
  return { ok: res.ok, status: res.status };
}

/**
 * List existing webhook registrations from WooCommerce to avoid duplicates.
 * Returns the array of existing topic strings, or [] on any error (best-effort).
 */
async function listExistingWebhookTopics(
  siteUrl: string,
  consumerKey: string,
  consumerSecret: string,
): Promise<string[]> {
  try {
    const normalizedBase = siteUrl.replace(/\/+$/, '');
    const deliveryUrl = webhookDeliveryUrl();
    const url = `${normalizedBase}/wp-json/wc/v3/webhooks?per_page=100`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: buildBasicAuth(consumerKey, consumerSecret),
        Accept: 'application/json',
      },
    });
    if (!res.ok) return [];
    const webhooks = (await res.json()) as Array<{ topic?: string; delivery_url?: string }>;
    // Only consider webhooks pointing at our delivery URL.
    return Array.isArray(webhooks)
      ? webhooks
          .filter((wh) => wh.delivery_url === deliveryUrl)
          .map((wh) => wh.topic ?? '')
          .filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

/**
 * Register a single webhook topic via POST /wp-json/wc/v3/webhooks.
 * Returns the registered topic on success, or null on failure.
 * I-S09: webhook_secret payload is a one-time-generated value for signing; it is NOT logged.
 */
async function registerWebhook(
  siteUrl: string,
  consumerKey: string,
  consumerSecret: string,
  topic: string,
  webhookSecret: string,
): Promise<{ topic: string } | null> {
  try {
    const normalizedBase = siteUrl.replace(/\/+$/, '');
    const url = `${normalizedBase}/wp-json/wc/v3/webhooks`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: buildBasicAuth(consumerKey, consumerSecret),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        name: `Brain – ${topic}`,
        topic,
        delivery_url: webhookDeliveryUrl(),
        secret: webhookSecret,
        status: 'active',
      }),
    });
    if (!res.ok) return null;
    return { topic };
  } catch {
    return null;
  }
}

// ── ConnectWooCommerceCommand ─────────────────────────────────────────────────

export class ConnectWooCommerceCommand {
  constructor(
    private readonly secretsManager: ISecretsManager,
    private readonly connectorRepo: IConnectorInstanceRepository,
    private readonly syncStatusRepo: IConnectorSyncStatusRepository,
    private readonly rawPgPool: pg.Pool,
    private readonly emitEvent: (eventName: string, payload: Record<string, unknown>) => Promise<void>,
  ) {}

  /**
   * Capability probe — cheap, side-effect-free credential validation.
   * Issues a GET /wp-json/wc/v3/system_status. Returns valid=false on 401/403 or network error.
   */
  async validate(input: ValidateWooCommerceInput): Promise<ValidateWooCommerceResult> {
    const { siteUrl, consumerKey, consumerSecret } = input;
    if (!siteUrl || !consumerKey || !consumerSecret) {
      return { valid: false, reason: 'site_url, consumer_key, and consumer_secret are required' };
    }
    try {
      const probe = await probeSystemStatus(siteUrl, consumerKey, consumerSecret);
      if (probe.status === 401 || probe.status === 403) {
        return { valid: false, reason: `WooCommerce REST API rejected credentials (HTTP ${probe.status})` };
      }
      if (!probe.ok) {
        return { valid: false, reason: `WooCommerce REST API unreachable (HTTP ${probe.status})` };
      }
      return { valid: true };
    } catch (err) {
      return { valid: false, reason: `WooCommerce REST API unreachable: ${String(err)}` };
    }
  }

  /**
   * Connect: store credential bundle → create ConnectorInstance + ConnectorSyncStatus →
   * set woocommerce_site_url → auto-register outbound webhooks → emit connector.connected.
   *
   * Webhook auto-registration is best-effort: failures are collected and returned in
   * webhookRegistrationErrors but do NOT abort the connection.
   */
  async execute(input: ConnectWooCommerceInput): Promise<ConnectWooCommerceResult> {
    const { brandId, siteUrl, consumerKey, consumerSecret, idempotencyKey } = input;

    // One-storefront-per-brand (business rule): reject if the brand already has a DIFFERENT
    // connected storefront (e.g. Shopify). Reconnecting WooCommerce is allowed (same provider).
    await assertSingleStorefront(this.connectorRepo, brandId, 'woocommerce');

    // Normalise the site URL (strip trailing slash — it becomes the webhook lookup key).
    const normalizedSiteUrl = siteUrl.replace(/\/+$/, '');

    // Derive the secret bundle from the declarative catalog (single SoR for the secret/non-secret
    // split — see credential-schema.ts). For woocommerce the plan yields
    // { consumer_key, consumer_secret, site_url }: site_url is a non-secret bundleNonSecretField the
    // repull client + pixel-install read the store base URL from. The per-connector webhook signing
    // secret is then MINTED via provisionGeneratedSecrets (catalog generatedSecretFields: webhook_secret)
    // — the SAME generalized mechanism the Shiprocket/GoKwik connect uses, instead of bespoke code.
    // I-S09: webhook_secret is stored in the bundle + set on WC during webhook registration; NEVER logged.
    const def = getDefinition('woocommerce')!;
    const { secretBundle: planBundle } = planCredentialConnect(def.authFields!, def.credentialConnect!, {
      site_url: normalizedSiteUrl,
      consumer_key: consumerKey,
      consumer_secret: consumerSecret,
    });
    const { bundle: secretBundle } = provisionGeneratedSecrets(
      planBundle,
      def.credentialConnect!,
      () => randomBytes(24).toString('hex'),
    );
    const webhookSecret = secretBundle['webhook_secret']!;

    // Store composite credential bundle as ONE secret (single secret_ref per connector).
    // subKey = normalizedSiteUrl (non-secret store identifier, URL-safe).
    const { arn } = await this.secretsManager.storeSecret(
      brandId,
      { connectorType: 'woocommerce', subKey: normalizedSiteUrl },
      secretBundle,
    );

    const now = new Date();
    const connectorInstanceId = randomUUID();

    const instance = ConnectorInstance.create({
      id: connectorInstanceId,
      brandId,
      provider: 'woocommerce',
      shopDomain: normalizedSiteUrl, // reuses shopDomain field for the store URL (consistent with Shopify)
      secretRef: arn,
      status: 'connected',
      healthState: 'Healthy',
      safetyRating: 'safe',
      connectedAt: now,
      disconnectedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    await this.connectorRepo.save(instance);

    // Set woocommerce_site_url on the connector_instance row under brand GUC.
    // Required by resolve_woocommerce_connector_by_site() for webhook brand resolution (MT-1).
    const client = await this.rawPgPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_brand_id', $1, true)`, [brandId]);
      await client.query(
        `UPDATE connector_instance
         SET woocommerce_site_url = $1
         WHERE id = $2 AND brand_id = $3`,
        [normalizedSiteUrl, connectorInstanceId, brandId],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    const syncStatus = ConnectorSyncStatus.create({
      id: randomUUID(),
      brandId,
      connectorInstanceId,
      state: 'connected',
      lastSyncAt: null,
      lastError: null,
      updatedAt: now,
    });
    await this.syncStatusRepo.save(syncStatus);

    // ── Webhook auto-registration (best-effort) ───────────────────────────────
    const webhooksRegistered: string[] = [];
    const webhookRegistrationErrors: string[] = [];

    try {
      const existingTopics = await listExistingWebhookTopics(
        normalizedSiteUrl,
        consumerKey,
        consumerSecret,
      );

      for (const topic of WC_WEBHOOK_TOPICS) {
        if (existingTopics.includes(topic)) {
          // Already registered — skip (idempotent).
          webhooksRegistered.push(topic);
          continue;
        }
        const result = await registerWebhook(
          normalizedSiteUrl,
          consumerKey,
          consumerSecret,
          topic,
          webhookSecret,
        );
        if (result) {
          webhooksRegistered.push(result.topic);
        } else {
          webhookRegistrationErrors.push(`webhook registration failed for topic: ${topic}`);
        }
      }
    } catch (err) {
      // Webhook registration is non-fatal; log and continue. // intentional
      log.warn('woocommerce webhook auto-registration failed (non-fatal — connection proceeds)', {
        brand_id: brandId,
        err,
      });
      webhookRegistrationErrors.push(`webhook auto-registration error: ${String(err)}`);
    }

    // Audit hook — no credential values in payload (I-S09).
    await this.emitEvent('connector.connected', {
      brand_id: brandId,
      connector_instance_id: connectorInstanceId,
      provider: 'woocommerce',
      idempotency_key: idempotencyKey,
      site_url: normalizedSiteUrl,
      webhooks_registered: webhooksRegistered,
      // NO consumer_key, NO consumer_secret, NO webhook_secret in event payload (I-S09)
    });

    return { connectorInstanceId, status: 'connected', webhooksRegistered, webhookRegistrationErrors };
  }
}
