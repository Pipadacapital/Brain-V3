/**
 * ConnectShiprocketCommand — wires up a Shiprocket credential connector (logistics).
 *
 * Mirror of ConnectGokwikCommand. Shiprocket auth is a dedicated API user (email +
 * password) exchanged at POST /v1/external/auth/login for a 10-day Bearer JWT (minted +
 * cached by the repull job, NOT here). Slice 1 has no inbound webhook — ingestion is the
 * shipment-lifecycle trailing-window re-pull, keyed by shiprocket_channel_id for enumeration.
 *
 * Stores the credential bundle as ONE composite JSON secret under a single secret_ref:
 *   { email, password }
 *
 * Constraints:
 *   - password is NEVER logged at any level (I-S09).
 *   - shiprocket_channel_id is the (non-secret) channel/account identifier — stored on
 *     connector_instance.shiprocket_channel_id (migration 0059) for re-pull enumeration via
 *     list_shiprocket_connectors_for_repull() (SECURITY DEFINER). Optional.
 *   - provider = 'shiprocket' (migration 0059 extends the provider CHECK constraint).
 *   - NN-2: only the secret_ref (ARN) is stored on connector_instance — never values.
 */

import type { ISecretsManager } from '@brain/connector-secrets';
import type { IConnectorInstanceRepository } from '@brain/connector-core';
import type { IConnectorSyncStatusRepository } from '@brain/connector-core';
import { ConnectorInstance } from '@brain/connector-core';
import { ConnectorSyncStatus } from '@brain/connector-core';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';

export interface ConnectShiprocketInput {
  brandId: string;
  /** Shiprocket API-user email. Part of the login credential — never logged (I-S09). */
  email: string;
  /** Shiprocket API-user password. Never logged (I-S09). */
  password: string;
  /** Shiprocket channel/account identifier (non-secret enumeration key). Optional. */
  channelId?: string | null;
  idempotencyKey: string;
}

export interface ConnectShiprocketResult {
  connectorInstanceId: string;
  status: 'connected';
}

export class ConnectShiprocketCommand {
  constructor(
    private readonly secretsManager: ISecretsManager,
    private readonly connectorRepo: IConnectorInstanceRepository,
    private readonly syncStatusRepo: IConnectorSyncStatusRepository,
    private readonly rawPgPool: pg.Pool,
    private readonly emitEvent: (eventName: string, payload: Record<string, unknown>) => Promise<void>,
  ) {}

  async execute(input: ConnectShiprocketInput): Promise<ConnectShiprocketResult> {
    const { brandId, email, password, channelId, idempotencyKey } = input;

    // Store composite credential bundle as ONE secret. subKey = channelId or email (non-secret).
    // I-S09: password NEVER logged — only the resulting ARN is.
    const { arn } = await this.secretsManager.storeSecret(
      brandId,
      { connectorType: 'shiprocket', subKey: channelId ?? email },
      {
        email,
        password,
      },
    );

    const now = new Date();
    const connectorInstanceId = randomUUID();

    const instance = ConnectorInstance.create({
      id: connectorInstanceId,
      brandId,
      provider: 'shiprocket',
      shopDomain: '', // not applicable for Shiprocket
      secretRef: arn,
      status: 'connected',
      healthState: 'Healthy',
      safetyRating: 'safe',
      connectedAt: now,
      disconnectedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    await this.connectorRepo.save(instance);

    // Set shiprocket_channel_id on the connector_instance row (migration 0059 column) under
    // brand GUC. Read by list_shiprocket_connectors_for_repull() enumeration. Optional.
    if (channelId) {
      const client = await this.rawPgPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.current_brand_id', $1, true)`, [brandId]);
        await client.query(
          `UPDATE connector_instance
           SET shiprocket_channel_id = $1
           WHERE id = $2 AND brand_id = $3`,
          [channelId, connectorInstanceId, brandId],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    }

    const syncStatus = ConnectorSyncStatus.create({
      id: randomUUID(),
      brandId,
      connectorInstanceId,
      state: 'connected',
      lastSyncAt: null,
      lastError: null,
      updatedAt: now,
    });
    await this.syncStatusRepo.save(syncStatus);

    // Audit hook — no credential values in payload (I-S09).
    await this.emitEvent('connector.connected', {
      brand_id: brandId,
      connector_instance_id: connectorInstanceId,
      provider: 'shiprocket',
      idempotency_key: idempotencyKey,
      // NO password in event payload (I-S09)
    });

    return { connectorInstanceId, status: 'connected' };
  }
}
