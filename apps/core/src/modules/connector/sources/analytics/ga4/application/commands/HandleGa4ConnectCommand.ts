/**
 * HandleGa4ConnectCommand — the GENERIC per-brand GA4 connect path (GA4 rebuild, 2026-07-12).
 *
 * The brand pastes its GCP SERVICE-ACCOUNT JSON key + the numeric GA4 property id (+ an optional
 * reporting currency). NO browser OAuth redirect and NO shared Google app: auth is the
 * service-account JWT-bearer grant with scope analytics.readonly, via the SHARED
 * @brain/connector-core helper — the exact same code path the stream-worker Ga4DataClient uses at
 * repull time, so connect-time validation can never drift from run-time auth.
 *
 * Flow (mirrors ConnectShopifyWithCredentialsCommand — NN-2/I-S09 preserved):
 *   1. Validate the property id (numeric) + parse the pasted service-account JSON key.
 *   2. VALIDATE the credentials for real: mint an SA access token (JWT-bearer) and run a CHEAP
 *      runReport (1-day range, 1 metric, limit 1) against the property. A 401/403/404 ⇒
 *      Ga4CredentialsInvalidError (user-facing: wrong key, or the SA email lacks Viewer on the
 *      property). NEVER `connected` without proof the credentials work (honest-empty rule).
 *   3. Store the SA bundle per-brand+property (Secrets Manager) — JSON with
 *      { auth_method:'service_account', client_email, private_key, property_id, currency_code? }.
 *      resolveGa4Credentials (ga4-repull/run.ts) reads EXACTLY this shape.
 *   4. Create/activate the connector_instance (secret_ref = ARN only, NN-2; accountKey=property id).
 *   5. Mirror the property id into connector_instance.ad_account_id via the injected setter —
 *      the generic repull contract (ingestion-backfill run.ts §IngestionConnectorRow: for ga4 the
 *      ad_account_id column stores the property id).
 *   6. connector_sync_status row + connector.connected event.
 *
 * I-S09: the private key and the minted access token are NEVER logged and never returned.
 */
import { randomUUID } from 'node:crypto';
import type {
  IConnectorInstanceRepository,
  IConnectorSyncStatusRepository,
} from '@brain/connector-core';
import {
  ConnectorInstance,
  ConnectorSyncStatus,
  parseServiceAccountKeyJson,
  mintServiceAccountAccessToken,
  GOOGLE_SA_AUTH_ERROR,
  type GoogleServiceAccountKey,
} from '@brain/connector-core';
import type { ISecretsManager } from '@brain/connector-secrets';
import type { SetAdAccountIdFn } from '../../../../advertising/meta/application/commands/HandleMetaOAuthCallbackCommand.js';
import { log } from '../../../../../../../log.js';

/** GA4 Data API base (v1beta — the stable GA4 Reporting endpoint, same as the repull client). */
const GA4_DATA_API_BASE = 'https://analyticsdata.googleapis.com/v1beta';
/** Read-only Analytics scope — least privilege, matches the repull client. */
const GA4_ANALYTICS_READONLY_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const CONNECT_TIMEOUT_MS = 15_000;

export class Ga4InvalidPropertyIdError extends Error {
  public readonly code = 'GA4_INVALID_PROPERTY_ID';
  public readonly statusCode = 400;
  constructor(propertyId: string) {
    super(
      `"${propertyId}" is not a valid GA4 property id — enter the NUMERIC property id from ` +
        `GA4 Admin → Property settings (e.g. 123456789), not the "G-…" measurement id.`,
    );
    this.name = 'Ga4InvalidPropertyIdError';
  }
}

export class Ga4ServiceAccountKeyInvalidError extends Error {
  public readonly code = 'GA4_SERVICE_ACCOUNT_KEY_INVALID';
  public readonly statusCode = 400;
  constructor(detail: string) {
    super(
      `The pasted service-account key is not usable: ${detail}. Paste the FULL JSON key file ` +
        `downloaded from Google Cloud (IAM & Admin → Service Accounts → Keys → Add key → JSON).`,
    );
    this.name = 'Ga4ServiceAccountKeyInvalidError';
  }
}

export class Ga4CredentialsInvalidError extends Error {
  public readonly code = 'GA4_CREDENTIALS_INVALID';
  public readonly statusCode = 422;
  constructor(detail?: string) {
    super(
      'Google rejected these credentials for the GA4 property. Check that the JSON key is current ' +
        "(not deleted/rotated) and that the service account's email has been granted Viewer access " +
        `on this property (GA4 Admin → Property access management).${detail ? ` (${detail})` : ''}`,
    );
    this.name = 'Ga4CredentialsInvalidError';
  }
}

export interface ConnectGa4Input {
  /** Server-resolved brand (session), never client input (MT-1). */
  brandId: string;
  /** Numeric GA4 property id (merchant-entered). */
  propertyId: string;
  /** The pasted service-account JSON key string — NEVER logged (I-S09). */
  serviceAccountJson: string;
  /** Optional ISO-4217 property reporting currency (blank ⇒ USD downstream). */
  currencyCode?: string;
  /** Idempotency key from the request header. */
  idempotencyKey: string;
}

export interface ConnectGa4Result {
  connectorInstanceId: string;
  brandId: string;
  propertyId: string;
  status: 'connected';
}

export class HandleGa4ConnectCommand {
  constructor(
    private readonly secretsManager: ISecretsManager,
    private readonly connectorRepo: IConnectorInstanceRepository,
    private readonly syncStatusRepo: IConnectorSyncStatusRepository,
    private readonly emitEvent: (eventName: string, payload: Record<string, unknown>) => Promise<void>,
    /** Mirrors the property id into connector_instance.ad_account_id (generic repull contract). */
    private readonly setAdAccountId?: SetAdAccountIdFn,
    /** Injectable for deterministic tests. */
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: ConnectGa4Input): Promise<ConnectGa4Result> {
    const { brandId, idempotencyKey } = input;

    // ── 1a. Property id: numeric only (the Data API path segment) ─────────────
    const propertyId = (input.propertyId ?? '').trim();
    if (!propertyId || !/^\d+$/.test(propertyId)) {
      throw new Ga4InvalidPropertyIdError(input.propertyId ?? '');
    }

    // ── 1b. Parse the pasted service-account JSON key (structural gate) ───────
    let key: GoogleServiceAccountKey;
    try {
      key = parseServiceAccountKeyJson(input.serviceAccountJson ?? '');
    } catch (err) {
      // The helper's message is structural only (never the key material — I-S09).
      const msg = (err as Error).message.replace(`${GOOGLE_SA_AUTH_ERROR}: `, '');
      throw new Ga4ServiceAccountKeyInvalidError(msg);
    }

    const currencyCode = (input.currencyCode ?? '').trim().toUpperCase();

    // ── 2. Prove the credentials work: SA token mint + a cheap runReport ──────
    await this.validateWithRunReport(key, propertyId);

    // ── 3. Store the SA bundle (NN-2: only the ARN leaves this scope) ─────────
    // EXACTLY the shape resolveGa4Credentials (ga4-repull/run.ts) reads.
    const { arn: secretRef } = await this.secretsManager.storeSecret(
      brandId,
      { connectorType: 'ga4', subKey: propertyId },
      {
        auth_method: 'service_account',
        client_email: key.clientEmail,
        private_key: key.privateKeyPem,
        property_id: propertyId,
        ...(currencyCode ? { currency_code: currencyCode } : {}),
      },
    );

    // ── 4. connector_instance (ADR-CM-5 connect ⇒ Healthy/safe) ───────────────
    const nowDate = this.now();
    const instanceId = randomUUID();
    const instance = ConnectorInstance.create({
      id: instanceId,
      brandId,
      provider: 'ga4',
      shopDomain: '',
      secretRef,
      status: 'connected',
      healthState: 'Healthy',
      safetyRating: 'safe',
      connectedAt: nowDate,
      disconnectedAt: null,
      createdAt: nowDate,
      updatedAt: nowDate,
      accountKey: propertyId,
      providerConfig: {
        ga4_property_id: propertyId,
        auth_method: 'service_account',
        ...(currencyCode ? { currency_code: currencyCode } : {}),
      },
    });
    const savedInstance = await this.connectorRepo.save(instance);

    // ── 5. Mirror the property id → ad_account_id column (repull contract) ────
    if (this.setAdAccountId) {
      await this.setAdAccountId(brandId, savedInstance.id, propertyId);
    }

    // ── 6. sync status + connector.connected event ─────────────────────────────
    const syncStatus = ConnectorSyncStatus.create({
      id: randomUUID(),
      brandId,
      connectorInstanceId: savedInstance.id,
      state: 'waiting_for_data',
      lastSyncAt: null,
      lastError: null,
      updatedAt: nowDate,
    });
    await this.syncStatusRepo.save(syncStatus);

    await this.emitEvent('connector.connected', {
      brand_id: brandId,
      connector_instance_id: savedInstance.id,
      provider: 'ga4',
      property_id: propertyId,
      auth_method: 'service_account',
      // key / secret_ref intentionally NOT in the event payload (I-S09)
      idempotency_key: idempotencyKey,
    });

    log.info(`[HandleGa4Connect] connected property=${propertyId} brand=${brandId}`);

    return {
      connectorInstanceId: savedInstance.id,
      brandId,
      propertyId,
      status: 'connected',
    };
  }

  /**
   * Connect-time validation: mint an SA access token (JWT-bearer, shared helper) and run the
   * CHEAPEST possible runReport against the property (1-day range, 1 metric, limit 1).
   *   - JWT/key rejected by Google        → Ga4CredentialsInvalidError (bad/rotated key)
   *   - 401/403/404 from the Data API      → Ga4CredentialsInvalidError (no Viewer grant / wrong id)
   *   - other failures propagate as 5xx-class (retryable — nothing persisted yet).
   * The token stays in this frame — NEVER logged, NEVER stored (I-S09).
   */
  private async validateWithRunReport(key: GoogleServiceAccountKey, propertyId: string): Promise<void> {
    let accessToken: string;
    try {
      ({ accessToken } = await mintServiceAccountAccessToken({
        key,
        scope: GA4_ANALYTICS_READONLY_SCOPE,
        timeoutMs: CONNECT_TIMEOUT_MS,
        fetchImpl: this.fetchImpl,
      }));
    } catch (err) {
      if ((err as { code?: string }).code === GOOGLE_SA_AUTH_ERROR) {
        throw new Ga4CredentialsInvalidError('the service-account key was rejected by Google');
      }
      throw err;
    }

    const res = await this.fetchImpl(`${GA4_DATA_API_BASE}/properties/${propertyId}:runReport`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        dateRanges: [{ startDate: 'yesterday', endDate: 'today' }],
        metrics: [{ name: 'sessions' }],
        limit: '1',
      }),
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    });

    if (res.ok) return;
    // MED-02-style: never surface the Google response body (only the status class).
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      throw new Ga4CredentialsInvalidError(`GA4 Data API returned ${res.status} for property ${propertyId}`);
    }
    throw new Error(`[HandleGa4Connect] validation runReport failed (${res.status})`);
  }
}
