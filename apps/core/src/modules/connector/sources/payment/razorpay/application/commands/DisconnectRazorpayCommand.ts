/**
 * DisconnectRazorpayCommand — disconnects a Razorpay connector instance (C2 / ADR-RZ-8).
 *
 * C2 disconnect flow (3 required steps):
 *   (a) Call Razorpay API to deregister the webhook endpoint registration.
 *       DEV: env-gated no-op (same as Shopify RegisterWebhooksCommand pattern — D-8 honesty).
 *       PROD: real Razorpay API call to DELETE /v1/webhooks/<webhook_id>.
 *   (b) Invalidate the secret_ref in Secrets Manager (deleteSecret — existing generic path).
 *       No silent disconnect with live secrets.
 *   (c) status='disconnected' + halt all processing.
 *
 * I-S09: No credential values in event payload or logs.
 * NN-2: No secret_ref in event payload.
 */

import type { IConnectorInstanceRepository } from '../../../../storefront/shopify/domain/repositories/IConnectorInstanceRepository.js';
import type { IConnectorSyncStatusRepository } from '../../../../storefront/shopify/domain/repositories/IConnectorSyncStatusRepository.js';
import type { ISecretsManager } from '../../../../storefront/shopify/infrastructure/secrets/ISecretsManager.js';

export interface DisconnectRazorpayInput {
  connectorInstanceId: string;
  brandId: string;
  idempotencyKey: string;
}

export class RazorpayConnectorNotFoundError extends Error {
  constructor(id: string) {
    super(`Razorpay connector instance not found: ${id}`);
    this.name = 'RazorpayConnectorNotFoundError';
  }
}

export class DisconnectRazorpayCommand {
  constructor(
    private readonly connectorRepo: IConnectorInstanceRepository,
    private readonly syncStatusRepo: IConnectorSyncStatusRepository,
    private readonly secretsManager: ISecretsManager,
    private readonly emitEvent: (eventName: string, payload: Record<string, unknown>) => Promise<void>,
    /** Whether to attempt real Razorpay webhook deregister (false in dev — D-8 env-gate). */
    private readonly deregisterWebhook: (secretRef: string) => Promise<void>,
  ) {}

  async execute(input: DisconnectRazorpayInput): Promise<void> {
    const { connectorInstanceId, brandId, idempotencyKey } = input;

    const instance = await this.connectorRepo.findById(connectorInstanceId, brandId);
    if (!instance) {
      throw new RazorpayConnectorNotFoundError(connectorInstanceId);
    }

    // (a) Deregister Razorpay webhook (C2.a)
    // In dev: no-op (env-gated, same as Shopify RegisterWebhooksCommand pattern).
    // In prod: calls Razorpay API to DELETE the webhook registration.
    // The deregisterWebhook fn receives the secret_ref so the caller can resolve
    // the key_id/key_secret from Secrets Manager if needed.
    // I-S09: the caller MUST NOT log secret values.
    await this.deregisterWebhook(instance.secretRef);

    // (b) Invalidate secret_ref in Secrets Manager (C2.b)
    // deleteSecret uses the generic path — works for both Shopify and credential connectors.
    // FAIL-LOUD: if this fails, do NOT continue (live secrets must not persist after disconnect).
    await this.secretsManager.deleteSecret(instance.secretRef);

    // (c) Mark connector_instance as 'disconnected' — halts all processing (C2.c).
    // ADR-CM-5: disconnect ⇒ health_state=Disconnected, safety_rating=blocked.
    const disconnected = instance.disconnect();
    await this.connectorRepo.update(disconnected);

    // Update sync status to error/disconnected state.
    const syncStatus = await this.syncStatusRepo.findByConnectorInstanceId(
      connectorInstanceId,
      brandId,
    );
    if (syncStatus) {
      const updated = syncStatus.markError('Razorpay connector disconnected by user');
      await this.syncStatusRepo.update(updated);
    }

    // Emit connector.disconnected event (audit trace).
    // I-S09 / NN-2: NO secret_ref, NO credential values in payload.
    await this.emitEvent('connector.disconnected', {
      brand_id: brandId,
      connector_instance_id: connectorInstanceId,
      provider: 'razorpay',
      idempotency_key: idempotencyKey,
    });
  }
}
