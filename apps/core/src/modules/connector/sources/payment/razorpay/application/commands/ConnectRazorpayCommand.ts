/**
 * ConnectRazorpayCommand — wires up a Razorpay credential connector (C2 / ADR-RZ-8).
 *
 * Stores three Razorpay credentials as ONE composite JSON bundle under a single
 * secret_ref per connector_instance (mirrors Shopify secret_ref pattern):
 *   { key_id, key_secret, webhook_secret }
 *
 * C2 constraints:
 *   - webhook_secret is independently rotatable via RotateWebhookSecretCommand
 *     without touching key_id/key_secret.
 *   - The credential bundle is NEVER logged at any level (I-S09 / C5).
 *   - razorpay_account_id is stored on connector_instance for brand resolution
 *     by resolve_razorpay_connector_by_account() (SECURITY DEFINER fn — ADR-RZ-7).
 *   - provider = 'razorpay' (migration 0027 extended the CHECK constraint).
 *
 * NN-2: only the ARN (secret_ref) is stored in connector_instance — never credential values.
 */

import type { ISecretsManager } from '@brain/connector-secrets';
import type { IConnectorInstanceRepository } from '@brain/connector-core';
import type { IConnectorSyncStatusRepository } from '@brain/connector-core';
import { ConnectorInstance } from '@brain/connector-core';
import { ConnectorSyncStatus } from '@brain/connector-core';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { getDefinition } from '../../../../../catalog/index.js';
import { planCredentialConnect } from '../../../../../credential-schema.js';

export interface ConnectRazorpayInput {
  brandId: string;
  /** Razorpay API key_id (rzp_live_XXXX or rzp_test_XXXX). Never logged (I-S09). */
  keyId: string;
  /** Razorpay API key_secret. Never logged (I-S09). */
  keySecret: string;
  /** Razorpay webhook signing secret. Independently rotatable (C2). Never logged (I-S09). */
  webhookSecret: string;
  /**
   * Razorpay account_id (merchant account identifier).
   * Used by resolve_razorpay_connector_by_account() for webhook brand resolution (ADR-RZ-7).
   * NOT a secret — it is a merchant identifier visible in the Razorpay dashboard.
   */
  razorpayAccountId: string;
  idempotencyKey: string;
}

export interface ConnectRazorpayResult {
  connectorInstanceId: string;
  status: 'connected';
}

export class ConnectRazorpayCommand {
  constructor(
    private readonly secretsManager: ISecretsManager,
    private readonly connectorRepo: IConnectorInstanceRepository,
    private readonly syncStatusRepo: IConnectorSyncStatusRepository,
    private readonly rawPgPool: pg.Pool,
    private readonly emitEvent: (eventName: string, payload: Record<string, unknown>) => Promise<void>,
  ) {}

  async execute(input: ConnectRazorpayInput): Promise<ConnectRazorpayResult> {
    const {
      brandId,
      keyId,
      keySecret,
      webhookSecret,
      razorpayAccountId,
      idempotencyKey,
    } = input;

    // Derive the secret bundle from the declarative catalog (single SoR for the secret/non-secret
    // split — see credential-schema.ts). The flat value map keys MUST match the connector's
    // authFields. For razorpay the plan yields { key_id, key_secret, webhook_secret } (key_id is a
    // non-secret bundleNonSecretField the settlement-repull client reads from the bundle).
    const def = getDefinition('razorpay')!;
    const { secretBundle } = planCredentialConnect(def.authFields!, def.credentialConnect!, {
      key_id: keyId,
      key_secret: keySecret,
      webhook_secret: webhookSecret,
      razorpay_account_id: razorpayAccountId,
    });

    // Store composite credential bundle as ONE secret (C2 — single secret_ref per connector).
    // The bundle keys are the field names expected by the webhook handler and re-pull job.
    // I-S09 / C5: credential values NEVER logged — only the resulting ARN is.
    const { arn } = await this.secretsManager.storeSecret(
      brandId,
      { connectorType: 'razorpay', subKey: razorpayAccountId },
      secretBundle,
    );

    const now = new Date();
    const connectorInstanceId = randomUUID();

    // Create connector_instance with provider='razorpay' + razorpay_account_id.
    // The ConnectorInstance entity currently stores shopDomain for Shopify.
    // For Razorpay, shopDomain is empty string (no Shopify concept).
    // razorpay_account_id is set directly via raw SQL since the entity doesn't expose it
    // (to avoid coupling the shared entity to Razorpay-specific columns).
    const instance = ConnectorInstance.create({
      id: connectorInstanceId,
      brandId,
      provider: 'razorpay',
      shopDomain: '',  // not applicable for Razorpay
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

    // Set razorpay_account_id on the connector_instance row (Razorpay-specific column
    // added in migration 0027 — not in the shared entity model).
    const client = await this.rawPgPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_brand_id', $1, true)`, [brandId]);
      await client.query(
        `UPDATE connector_instance
         SET razorpay_account_id = $1
         WHERE id = $2 AND brand_id = $3`,
        [razorpayAccountId, connectorInstanceId, brandId],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    // Create initial connector_sync_status row.
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

    // Emit connector.connected event (audit hook — no credential values in payload, I-S09).
    await this.emitEvent('connector.connected', {
      brand_id: brandId,
      connector_instance_id: connectorInstanceId,
      provider: 'razorpay',
      idempotency_key: idempotencyKey,
      // NO key_id, NO key_secret, NO webhook_secret in event payload (I-S09)
    });

    return { connectorInstanceId, status: 'connected' };
  }
}
