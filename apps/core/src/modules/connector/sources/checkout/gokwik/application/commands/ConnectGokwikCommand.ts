/**
 * ConnectGokwikCommand — wires up a GoKwik credential connector (Track B).
 *
 * Clone of ConnectRazorpayCommand WITHOUT a webhook_secret — GoKwik exposes no
 * self-serve inbound webhook in Slice 1 (POC-mediated, research finding 5). Its
 * ingestion seams are the RTO-Predict events + the AWB-lifecycle trailing-window
 * re-pull, both keyed by gokwik_appid for connector enumeration.
 *
 * Stores two credentials as ONE composite JSON bundle under a single secret_ref:
 *   { appid, appsecret }
 *
 * Constraints:
 *   - appsecret is NEVER logged at any level (I-S09).
 *   - appid is the (non-secret) application identifier — stored on
 *     connector_instance.gokwik_appid (migration 0030) for AWB re-pull enumeration
 *     via list_gokwik_connectors_for_awb_repull() (SECURITY DEFINER).
 *   - provider = 'gokwik' (migration 0030 extends the provider CHECK constraint).
 *   - NN-2: only the secret_ref (ARN) is stored on connector_instance — never values.
 */

import type { ISecretsManager } from '../../../../storefront/shopify/infrastructure/secrets/ISecretsManager.js';
import type { IConnectorInstanceRepository } from '../../../../storefront/shopify/domain/repositories/IConnectorInstanceRepository.js';
import type { IConnectorSyncStatusRepository } from '../../../../storefront/shopify/domain/repositories/IConnectorSyncStatusRepository.js';
import { ConnectorInstance } from '../../../../storefront/shopify/domain/entities/ConnectorInstance.js';
import { ConnectorSyncStatus } from '../../../../storefront/shopify/domain/entities/ConnectorSyncStatus.js';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';

export interface ConnectGokwikInput {
  brandId: string;
  /** GoKwik application id (header credential). NOT a secret — the lookup/enumeration key. */
  appid: string;
  /** GoKwik application secret (header credential). Never logged (I-S09). */
  appsecret: string;
  idempotencyKey: string;
}

export interface ConnectGokwikResult {
  connectorInstanceId: string;
  status: 'connected';
}

export class ConnectGokwikCommand {
  constructor(
    private readonly secretsManager: ISecretsManager,
    private readonly connectorRepo: IConnectorInstanceRepository,
    private readonly syncStatusRepo: IConnectorSyncStatusRepository,
    private readonly rawPgPool: pg.Pool,
    private readonly emitEvent: (eventName: string, payload: Record<string, unknown>) => Promise<void>,
  ) {}

  async execute(input: ConnectGokwikInput): Promise<ConnectGokwikResult> {
    const { brandId, appid, appsecret, idempotencyKey } = input;

    // Store composite credential bundle as ONE secret. subKey = appid (non-secret).
    // I-S09: appsecret NEVER logged — only the resulting ARN is.
    const { arn } = await this.secretsManager.storeSecret(
      brandId,
      { connectorType: 'gokwik', subKey: appid },
      {
        appid,
        appsecret,
      },
    );

    const now = new Date();
    const connectorInstanceId = randomUUID();

    const instance = ConnectorInstance.create({
      id: connectorInstanceId,
      brandId,
      provider: 'gokwik',
      shopDomain: '', // not applicable for GoKwik
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

    // Set gokwik_appid on the connector_instance row (migration 0030 column) under
    // brand GUC. Required by list_gokwik_connectors_for_awb_repull() enumeration.
    const client = await this.rawPgPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_brand_id', $1, true)`, [brandId]);
      await client.query(
        `UPDATE connector_instance
         SET gokwik_appid = $1
         WHERE id = $2 AND brand_id = $3`,
        [appid, connectorInstanceId, brandId],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
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
      provider: 'gokwik',
      idempotency_key: idempotencyKey,
      // NO appsecret in event payload (I-S09)
    });

    return { connectorInstanceId, status: 'connected' };
  }
}
