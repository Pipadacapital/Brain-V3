/**
 * ConnectorSyncStatus — domain entity tracking Shopify sync lifecycle state.
 *
 * Connection health = this entity's `state` field (never simulated).
 * State transitions: waiting_for_data → syncing → connected → error.
 */

export type SyncState = 'connected' | 'syncing' | 'waiting_for_data' | 'error';

export interface ConnectorSyncStatusProps {
  readonly id: string;
  readonly brandId: string;
  readonly connectorInstanceId: string;
  readonly state: SyncState;
  readonly lastSyncAt: Date | null;
  readonly lastError: string | null;
  readonly updatedAt: Date;
}

export class ConnectorSyncStatus {
  readonly id: string;
  readonly brandId: string;
  readonly connectorInstanceId: string;
  readonly state: SyncState;
  readonly lastSyncAt: Date | null;
  readonly lastError: string | null;
  readonly updatedAt: Date;

  private constructor(props: ConnectorSyncStatusProps) {
    this.id = props.id;
    this.brandId = props.brandId;
    this.connectorInstanceId = props.connectorInstanceId;
    this.state = props.state;
    this.lastSyncAt = props.lastSyncAt;
    this.lastError = props.lastError;
    this.updatedAt = props.updatedAt;
  }

  static create(props: ConnectorSyncStatusProps): ConnectorSyncStatus {
    return new ConnectorSyncStatus(props);
  }

  startSync(): ConnectorSyncStatus {
    return new ConnectorSyncStatus({
      ...this.toProps(),
      state: 'syncing',
      lastError: null,
      updatedAt: new Date(),
    });
  }

  markConnected(): ConnectorSyncStatus {
    return new ConnectorSyncStatus({
      ...this.toProps(),
      state: 'connected',
      lastSyncAt: new Date(),
      lastError: null,
      updatedAt: new Date(),
    });
  }

  markError(errorMessage: string): ConnectorSyncStatus {
    return new ConnectorSyncStatus({
      ...this.toProps(),
      state: 'error',
      lastError: errorMessage,
      updatedAt: new Date(),
    });
  }

  toProps(): ConnectorSyncStatusProps {
    return {
      id: this.id,
      brandId: this.brandId,
      connectorInstanceId: this.connectorInstanceId,
      state: this.state,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
      updatedAt: this.updatedAt,
    };
  }
}
