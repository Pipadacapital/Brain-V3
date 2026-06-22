/**
 * IConnectorCursorRepository — neutral connector-kernel domain repository interface.
 * Idempotent upsert on (brandId, connectorInstanceId, resource) (I-ST04).
 */
import type { ConnectorCursor } from '../entities/ConnectorCursor.js';

export interface IConnectorCursorRepository {
  findByResource(
    brandId: string,
    connectorInstanceId: string,
    resource: string,
  ): Promise<ConnectorCursor | null>;

  /** Upsert — INSERT ... ON CONFLICT (brand_id, connector_instance_id, resource) DO UPDATE. */
  upsert(cursor: ConnectorCursor): Promise<ConnectorCursor>;
}
