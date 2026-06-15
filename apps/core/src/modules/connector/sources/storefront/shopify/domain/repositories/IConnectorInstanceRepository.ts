/**
 * IConnectorInstanceRepository — domain repository interface.
 * Concrete implementation in infrastructure/repositories/.
 */
import type { ConnectorInstance } from '../entities/ConnectorInstance.js';

export interface IConnectorInstanceRepository {
  /** Find by brand+provider. Returns null if not connected. */
  findByBrandAndProvider(
    brandId: string,
    provider: 'shopify',
  ): Promise<ConnectorInstance | null>;

  /** Find by primary key. */
  findById(id: string, brandId: string): Promise<ConnectorInstance | null>;

  /** Persist a new connector instance. Idempotent on (brand_id, provider). */
  save(instance: ConnectorInstance): Promise<ConnectorInstance>;

  /** Update an existing connector instance. */
  update(instance: ConnectorInstance): Promise<ConnectorInstance>;
}
