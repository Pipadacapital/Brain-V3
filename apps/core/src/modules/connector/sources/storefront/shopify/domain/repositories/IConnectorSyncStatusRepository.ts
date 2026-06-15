/**
 * IConnectorSyncStatusRepository — domain repository interface.
 */
import type { ConnectorSyncStatus } from '../entities/ConnectorSyncStatus.js';

export interface IConnectorSyncStatusRepository {
  findByConnectorInstanceId(
    connectorInstanceId: string,
    brandId: string,
  ): Promise<ConnectorSyncStatus | null>;

  save(status: ConnectorSyncStatus): Promise<ConnectorSyncStatus>;

  update(status: ConnectorSyncStatus): Promise<ConnectorSyncStatus>;
}
