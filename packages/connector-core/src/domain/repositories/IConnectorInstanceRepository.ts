/**
 * IConnectorInstanceRepository — neutral connector-kernel domain repository interface.
 * Concrete implementation in each consumer's infrastructure/repositories/.
 *
 * A1 (feat-connector-marketplace): widened provider from literal 'shopify' to string;
 * added findAllByBrand for the catalog⨝instance marketplace join query.
 */
import type { ConnectorInstance } from '../entities/ConnectorInstance.js';

export interface IConnectorInstanceRepository {
  /** Find by brand+provider. Returns null if not connected. */
  findByBrandAndProvider(
    brandId: string,
    provider: string,
  ): Promise<ConnectorInstance | null>;

  /** Find by primary key, brand-scoped. */
  findById(id: string, brandId: string): Promise<ConnectorInstance | null>;

  /**
   * List all connector instances for a brand (for catalog⨝instance join).
   * Added A1 for the marketplace GET response.
   */
  findAllByBrand(brandId: string): Promise<ConnectorInstance[]>;

  /**
   * List all connector instances for a brand+provider pair (Gap B — multi-account-per-provider).
   * Returns all accounts; caller handles per-account dispatch.
   */
  findAllByBrandAndProvider(brandId: string, provider: string): Promise<ConnectorInstance[]>;

  /** Persist a new connector instance. Idempotent on (brand_id, provider, account_key). */
  save(instance: ConnectorInstance): Promise<ConnectorInstance>;

  /** Update an existing connector instance (status, health_state, safety_rating, etc.). */
  update(instance: ConnectorInstance): Promise<ConnectorInstance>;
}
