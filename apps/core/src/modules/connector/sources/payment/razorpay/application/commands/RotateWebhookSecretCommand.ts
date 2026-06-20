/**
 * RotateWebhookSecretCommand — independently rotates webhook_secret (C2 / ADR-RZ-8).
 *
 * C2 rotation path: updates ONLY the webhook_secret key in the composite credential
 * bundle in Secrets Manager, WITHOUT touching key_id or key_secret.
 *
 * SLA: < 5 minutes to complete rotation (documented in C2 — target revocation SLA).
 *
 * Steps:
 *   1. Fetch current composite bundle from secret_ref.
 *   2. Replace only the webhook_secret key.
 *   3. Re-store the bundle under the SAME secret_ref (update, not delete+create).
 *      This preserves the ARN stored in connector_instance.secret_ref.
 *
 * I-S09: no credential values logged at any level.
 * NN-2: the ARN (secret_ref) is the stable identifier — it does NOT change on rotation.
 *
 * Note: storeSecret() with the same brandId + connectorRef will UPDATE the existing
 * secret in AWS (put-secret-value on the existing ARN) in AwsSecretsManager, or
 * overwrite in LocalSecretsManager. The returned ARN is the same.
 */

import type { ISecretsManager } from '@brain/connector-secrets';
import type { IConnectorInstanceRepository } from '../../../../storefront/shopify/domain/repositories/IConnectorInstanceRepository.js';

export interface RotateWebhookSecretInput {
  connectorInstanceId: string;
  brandId: string;
  /** New webhook_secret value. MUST NOT be logged (I-S09). */
  newWebhookSecret: string;
  /** Razorpay account_id — needed to reconstruct the secret name (same subKey as connect). */
  razorpayAccountId: string;
}

export class RazorpayConnectorNotFoundForRotationError extends Error {
  constructor(id: string) {
    super(`Razorpay connector instance not found for rotation: ${id}`);
    this.name = 'RazorpayConnectorNotFoundForRotationError';
  }
}

export class RotateWebhookSecretCommand {
  constructor(
    private readonly secretsManager: ISecretsManager,
    private readonly connectorRepo: IConnectorInstanceRepository,
  ) {}

  async execute(input: RotateWebhookSecretInput): Promise<void> {
    const { connectorInstanceId, brandId, newWebhookSecret, razorpayAccountId } = input;

    const instance = await this.connectorRepo.findById(connectorInstanceId, brandId);
    if (!instance) {
      throw new RazorpayConnectorNotFoundForRotationError(connectorInstanceId);
    }

    // Fetch the current composite bundle to preserve key_id and key_secret.
    // I-S09: the returned bundle is used in-memory and NOT logged.
    const currentBundle = await this.secretsManager.getSecret(instance.secretRef);
    if (!currentBundle) {
      throw new Error(
        `[RotateWebhookSecretCommand] Composite secret bundle not found for connector ${connectorInstanceId}. ` +
        `Reconnect the Razorpay connector before rotating webhook_secret.`,
      );
    }

    const keyId = currentBundle['key_id'];
    const keySecret = currentBundle['key_secret'];
    if (!keyId || !keySecret) {
      throw new Error(
        `[RotateWebhookSecretCommand] Malformed credential bundle for connector ${connectorInstanceId}: ` +
        `key_id or key_secret missing. Re-connect before rotating webhook_secret.`,
      );
    }

    // Update ONLY the webhook_secret — key_id and key_secret preserved (C2 independent rotation).
    // storeSecret() with the same brandId + razorpayAccountId subKey will overwrite the bundle
    // under the SAME ARN (no new connector_instance.secret_ref needed).
    await this.secretsManager.storeSecret(
      brandId,
      { connectorType: 'razorpay', subKey: razorpayAccountId },
      {
        key_id: keyId,
        key_secret: keySecret,
        webhook_secret: newWebhookSecret,  // ONLY this key changes (C2)
      },
    );

    // I-S09: no logging of old or new webhook_secret values.
    // The caller can emit an audit event at the application layer if desired.
  }
}
