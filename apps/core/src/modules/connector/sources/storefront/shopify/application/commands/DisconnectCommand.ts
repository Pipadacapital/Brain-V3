/**
 * DisconnectCommand — disconnects a connector instance (generic + Shopify).
 *
 * Marks the connector_instance as 'disconnected', sets health_state→Disconnected,
 * safety_rating→blocked (ADR-CM-5), deletes the secret from Secrets Manager,
 * and emits connector.disconnected event.
 *
 * A3 (feat-connector-marketplace): uses generic deleteSecret (not deleteShopifyToken)
 * so credential connectors also revoke. Shopify-specific delete path is unchanged
 * at the Secrets Manager level (ARN-based deletion works for both).
 */
import type { IConnectorInstanceRepository } from '../../domain/repositories/IConnectorInstanceRepository.js';
import type { IConnectorSyncStatusRepository } from '../../domain/repositories/IConnectorSyncStatusRepository.js';
import type { ISecretsManager } from '@brain/connector-secrets';

export interface DisconnectInput {
  connectorInstanceId: string;
  brandId: string;
  idempotencyKey: string;
}

export class ConnectorNotFoundError extends Error {
  constructor(id: string) {
    super(`Connector instance not found: ${id}`);
    this.name = 'ConnectorNotFoundError';
  }
}

export class DisconnectCommand {
  constructor(
    private readonly connectorRepo: IConnectorInstanceRepository,
    private readonly syncStatusRepo: IConnectorSyncStatusRepository,
    private readonly secretsManager: ISecretsManager,
    private readonly emitEvent: (eventName: string, payload: Record<string, unknown>) => Promise<void>,
  ) {}

  async execute(input: DisconnectInput): Promise<void> {
    const { connectorInstanceId, brandId, idempotencyKey } = input;

    const instance = await this.connectorRepo.findById(connectorInstanceId, brandId);
    if (!instance) {
      throw new ConnectorNotFoundError(connectorInstanceId);
    }

    // ADR-CM-5: disconnect ⇒ health_state=Disconnected, safety_rating=blocked
    const disconnected = instance.disconnect();
    await this.connectorRepo.update(disconnected);

    // Delete secret from Secrets Manager (generic path — works for both oauth and credential)
    // Sec-C3: provider-side OAuth revocation is out of scope for M1 (non-goal, documented).
    // Shared-secret refcount (Gap B): multi-account providers (meta/google_ads) store ONE token
    // secret shared by every sibling instance's secret_ref. Only delete it when NO other
    // NON-DISCONNECTED instance of this brand+provider references the same ARN — otherwise
    // disconnecting one ad account kills the surviving accounts' credentials. NOTE: spare it for
    // ANY status except 'disconnected' (i.e. 'connected' OR 'error'): an instance in 'error' is a
    // live install with a transient problem (rate-limit / re-pull failure) that still needs the
    // secret to recover — only 'disconnected' has truly released it (ConnectorInstance.status is
    // 'connected' | 'disconnected' | 'error').
    const siblings = await this.connectorRepo.findAllByBrandAndProvider(brandId, instance.provider);
    const sharedByLiveSibling = siblings.some(
      (s) =>
        s.id !== connectorInstanceId &&
        s.status !== 'disconnected' &&
        s.secretRef === instance.secretRef,
    );
    if (!sharedByLiveSibling) {
      await this.secretsManager.deleteSecret(instance.secretRef);
    }

    // Update sync status to error/disconnected state
    const syncStatus = await this.syncStatusRepo.findByConnectorInstanceId(
      connectorInstanceId,
      brandId,
    );
    if (syncStatus) {
      const updated = syncStatus.markError('Connector disconnected by user');
      await this.syncStatusRepo.update(updated);
    }

    // Emit connector.disconnected event
    await this.emitEvent('connector.disconnected', {
      brand_id: brandId,
      connector_instance_id: connectorInstanceId,
      provider: instance.provider,
      idempotency_key: idempotencyKey,
      // NO secret_ref, NO token in event payload (I-S02/I-S09)
    });
  }
}
