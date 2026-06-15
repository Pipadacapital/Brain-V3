/**
 * GetConnectorStatusQuery — returns real connector + sync status for a brand.
 *
 * Connection health = actual connector_sync_status row (never simulated).
 * Also returns Meta/Google as coming_soon flags (zero backend — §5.1).
 */
import type { IConnectorInstanceRepository } from '../../domain/repositories/IConnectorInstanceRepository.js';
import type { IConnectorSyncStatusRepository } from '../../domain/repositories/IConnectorSyncStatusRepository.js';

export interface ConnectorStatusView {
  shopify: {
    connected: boolean;
    status: 'connected' | 'disconnected' | 'error' | 'not_connected';
    shopDomain: string | null;
    connectorInstanceId: string | null;
    syncState: 'connected' | 'syncing' | 'waiting_for_data' | 'error' | null;
    lastSyncAt: string | null;
    lastError: string | null;
  };
  meta: { coming_soon: true };
  google: { coming_soon: true };
}

export class GetConnectorStatusQuery {
  constructor(
    private readonly connectorRepo: IConnectorInstanceRepository,
    private readonly syncStatusRepo: IConnectorSyncStatusRepository,
  ) {}

  async execute(brandId: string): Promise<ConnectorStatusView> {
    const instance = await this.connectorRepo.findByBrandAndProvider(brandId, 'shopify');

    if (!instance) {
      return {
        shopify: {
          connected: false,
          status: 'not_connected',
          shopDomain: null,
          connectorInstanceId: null,
          syncState: null,
          lastSyncAt: null,
          lastError: null,
        },
        meta: { coming_soon: true },
        google: { coming_soon: true },
      };
    }

    const syncStatus = await this.syncStatusRepo.findByConnectorInstanceId(
      instance.id,
      brandId,
    );

    return {
      shopify: {
        connected: instance.status === 'connected',
        status: instance.status,
        shopDomain: instance.shopDomain,
        connectorInstanceId: instance.id,
        syncState: syncStatus?.state ?? null,
        lastSyncAt: syncStatus?.lastSyncAt?.toISOString() ?? null,
        lastError: syncStatus?.lastError ?? null,
      },
      meta: { coming_soon: true },
      google: { coming_soon: true },
    };
  }
}
