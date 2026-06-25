/**
 * IResourceBackfillStateRepository — neutral connector-kernel repository for per-resource backfill
 * progress. Idempotent upsert on (brandId, connectorInstanceId, resource) (I-ST04), mirroring the
 * jobs.resource_backfill_state table (migration 0111).
 */
import type {
  ResourceBackfillState,
  ResourceBackfillStatus,
} from '../entities/ResourceBackfillState.js';

export interface IResourceBackfillStateRepository {
  /** Load the backfill state for one resource, or null if none registered yet. */
  findByResource(
    brandId: string,
    connectorInstanceId: string,
    resource: string,
  ): Promise<ResourceBackfillState | null>;

  /** All backfill states for a connector instance (the per-connector progress view). */
  listByConnector(
    brandId: string,
    connectorInstanceId: string,
  ): Promise<readonly ResourceBackfillState[]>;

  /** All states in a given status for a connector (e.g. find 'paused' resources to resume). */
  listByStatus(
    brandId: string,
    connectorInstanceId: string,
    status: ResourceBackfillStatus,
  ): Promise<readonly ResourceBackfillState[]>;

  /** Upsert — INSERT ... ON CONFLICT (brand_id, connector_instance_id, resource) DO UPDATE. */
  upsert(state: ResourceBackfillState): Promise<ResourceBackfillState>;
}
