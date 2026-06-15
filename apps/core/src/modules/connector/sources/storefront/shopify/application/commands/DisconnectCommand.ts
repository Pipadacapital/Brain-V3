/**
 * DisconnectCommand — disconnects a Shopify connector instance.
 *
 * Marks the connector_instance as 'disconnected', deletes the secret from
 * Secrets Manager, and emits connector.disconnected event.
 */
import type { IConnectorInstanceRepository } from '../../domain/repositories/IConnectorInstanceRepository.js';
import type { IConnectorSyncStatusRepository } from '../../domain/repositories/IConnectorSyncStatusRepository.js';
import type { ISecretsManager } from '../../infrastructure/secrets/ISecretsManager.js';

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

    // Mark disconnected
    const disconnected = instance.disconnect();
    await this.connectorRepo.update(disconnected);

    // Delete secret from Secrets Manager
    await this.secretsManager.deleteShopifyToken(instance.secretRef);

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
      provider: 'shopify',
      idempotency_key: idempotencyKey,
    });
  }
}
