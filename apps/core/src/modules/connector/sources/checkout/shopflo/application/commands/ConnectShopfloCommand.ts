/**
 * ConnectShopfloCommand — wires up a Shopflo credential connector (Track B).
 *
 * Clone of ConnectRazorpayCommand. Stores three Shopflo credentials as ONE composite
 * JSON bundle under a single secret_ref per connector_instance:
 *   { api_token, merchant_id, webhook_secret }
 *
 * Constraints:
 *   - api_token + webhook_secret are NEVER logged at any level (I-S09).
 *   - merchant_id is the (non-secret) Shopflo merchant identifier — stored on
 *     connector_instance.shopflo_merchant_id (migration 0030) for webhook brand
 *     resolution via resolve_shopflo_connector_by_merchant() (SECURITY DEFINER).
 *   - provider = 'shopflo' (migration 0030 extends the provider CHECK constraint).
 *   - NN-2: only the secret_ref (ARN) is stored on connector_instance — never values.
 *   - Brand is resolved server-side from this connector row at webhook time —
 *     NEVER trusted from the webhook body (MT-1).
 */

import type { ISecretsManager } from '@brain/connector-secrets';
import type { IConnectorInstanceRepository } from '../../../../storefront/shopify/domain/repositories/IConnectorInstanceRepository.js';
import type { IConnectorSyncStatusRepository } from '../../../../storefront/shopify/domain/repositories/IConnectorSyncStatusRepository.js';
import { ConnectorInstance } from '../../../../storefront/shopify/domain/entities/ConnectorInstance.js';
import { ConnectorSyncStatus } from '../../../../storefront/shopify/domain/entities/ConnectorSyncStatus.js';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';

export interface ConnectShopfloInput {
  brandId: string;
  /** Shopflo static API Access Token (API-key, NOT OAuth). Never logged (I-S09). */
  apiToken: string;
  /**
   * Shopflo merchant identifier (from Shopflo support). NOT a secret — it is the
   * lookup key used by resolve_shopflo_connector_by_merchant() for webhook brand
   * resolution. Stored on connector_instance.shopflo_merchant_id.
   */
  merchantId: string;
  /** Shopflo webhook signing secret. Never logged (I-S09). */
  webhookSecret: string;
  idempotencyKey: string;
}

export interface ConnectShopfloResult {
  connectorInstanceId: string;
  status: 'connected';
}

export class ConnectShopfloCommand {
  constructor(
    private readonly secretsManager: ISecretsManager,
    private readonly connectorRepo: IConnectorInstanceRepository,
    private readonly syncStatusRepo: IConnectorSyncStatusRepository,
    private readonly rawPgPool: pg.Pool,
    private readonly emitEvent: (eventName: string, payload: Record<string, unknown>) => Promise<void>,
  ) {}

  async execute(input: ConnectShopfloInput): Promise<ConnectShopfloResult> {
    const { brandId, apiToken, merchantId, webhookSecret, idempotencyKey } = input;

    // Store composite credential bundle as ONE secret (single secret_ref per connector).
    // I-S09 / C5: credential values NEVER logged — only the resulting ARN is.
    // subKey = merchantId (the non-secret merchant identifier).
    const { arn } = await this.secretsManager.storeSecret(
      brandId,
      { connectorType: 'shopflo', subKey: merchantId },
      {
        api_token: apiToken,
        merchant_id: merchantId,
        webhook_secret: webhookSecret,
      },
    );

    const now = new Date();
    const connectorInstanceId = randomUUID();

    const instance = ConnectorInstance.create({
      id: connectorInstanceId,
      brandId,
      provider: 'shopflo',
      shopDomain: '', // not applicable for Shopflo
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

    // Set shopflo_merchant_id on the connector_instance row (migration 0030 column)
    // under brand GUC. Required by resolve_shopflo_connector_by_merchant() for
    // webhook brand resolution (MT-1 — brand is from this row, never the body).
    const client = await this.rawPgPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_brand_id', $1, true)`, [brandId]);
      await client.query(
        `UPDATE connector_instance
         SET shopflo_merchant_id = $1
         WHERE id = $2 AND brand_id = $3`,
        [merchantId, connectorInstanceId, brandId],
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

    // Audit hook — no credential values in payload (I-S09).
    await this.emitEvent('connector.connected', {
      brand_id: brandId,
      connector_instance_id: connectorInstanceId,
      provider: 'shopflo',
      idempotency_key: idempotencyKey,
      // NO api_token, NO webhook_secret in event payload (I-S09)
    });

    return { connectorInstanceId, status: 'connected' };
  }
}
