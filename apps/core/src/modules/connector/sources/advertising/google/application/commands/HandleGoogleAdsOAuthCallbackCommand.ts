/**
 * HandleGoogleAdsOAuthCallbackCommand — processes the Google Ads OAuth callback.
 *
 * feat-ad-connectors Track 1 (ADR-AD-2). Same shape as the Meta callback with two
 * divergences specific to Google:
 *   - Google issues short-lived access tokens; we persist the REFRESH token (offline
 *     access) so the repull job can mint access tokens at run start. The secret is a
 *     JSON bundle `{ refresh_token, client_id, client_secret, developer_token?,
 *     ad_account_id, login_customer_id? }` (same multi-cred-bundle pattern as the
 *     Razorpay credential bundle). client_id/client_secret are the creds that RESOLVED
 *     this exchange (brand BYO-app else env) — a refresh_token is only valid against the
 *     client that minted it, so the repull must refresh with the SAME client (BYO bug).
 *   - ad_account_id here is the Google Ads customer id (digits only, no dashes). It is
 *     stored INSIDE the bundle (the repull client needs it) AND on the connector_instance
 *     row (for enumeration / webhook-free brand resolution).
 *
 * Gap B (multi-account-per-provider, migration 0092):
 *   - resolveAllCustomerIds returns ALL accessible customer ids (not just the first).
 *   - One ConnectorInstance is created per customer id, keyed by customer_id.
 *   - Falls back to a single __default__ instance if no customers are resolvable.
 *
 * Invariants (identical to Meta):
 *   - NO HMAC. The state nonce IS the auth. brand_id from consumeAndGetBrandId(state) ONLY (D-1).
 *   - The refresh token NEVER touches Postgres (NN-2 / I-S09) — only the ARN is stored.
 *   - provider='google_ads', shopDomain=''.
 */
import { randomUUID } from 'node:crypto';
import { ConnectorInstance, DEFAULT_ACCOUNT_KEY } from '@brain/connector-core';
import { ConnectorSyncStatus } from '@brain/connector-core';
import type { IConnectorInstanceRepository } from '@brain/connector-core';
import type { IConnectorSyncStatusRepository } from '@brain/connector-core';
import type { ISecretsManager } from '@brain/connector-secrets';
import type { IOAuthStateStore } from '../../../../storefront/shopify/infrastructure/state/IOAuthStateStore.js';
import type { SetAdAccountIdFn } from '../../../meta/application/commands/HandleMetaOAuthCallbackCommand.js';
import { resolveBrandOAuthAppCreds } from '../../../../../oauth-app-creds.js';

export interface GoogleAdsOAuthCallbackInput {
  query: Record<string, string | string[] | undefined>;
  idempotencyKey: string;
}

export interface GoogleAdsOAuthCallbackResult {
  connectorInstanceId: string;
  brandId: string;
  /** Google Ads customer id (digits only), or null if not resolvable (honest). */
  adAccountId: string | null;
  /** All resolved Google Ads customer ids (Gap B). */
  adAccountIds: string[];
  status: 'connected';
}

export class GoogleAdsStateNonceError extends Error {
  constructor(message = 'State nonce invalid or expired') {
    super(message);
    this.name = 'GoogleAdsStateNonceError';
  }
}

export class GoogleAdsOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleAdsOAuthError';
  }
}

export class HandleGoogleAdsOAuthCallbackCommand {
  constructor(
    private readonly secretsManager: ISecretsManager,
    private readonly stateStore: IOAuthStateStore,
    private readonly connectorRepo: IConnectorInstanceRepository,
    private readonly syncStatusRepo: IConnectorSyncStatusRepository,
    private readonly emitEvent: (eventName: string, payload: Record<string, unknown>) => Promise<void>,
    private readonly setAdAccountId?: SetAdAccountIdFn,
  ) {}

  async execute(input: GoogleAdsOAuthCallbackInput): Promise<GoogleAdsOAuthCallbackResult> {
    const { query, idempotencyKey } = input;

    // ── Step 1: State nonce → brand_id (D-1) ──────────────────────────────────
    const state = typeof query['state'] === 'string' ? query['state'] : '';
    if (!state) {
      throw new GoogleAdsStateNonceError('State parameter missing');
    }
    const stateRecord = await this.stateStore.consumeAndGetBrandId(state);
    if (!stateRecord) {
      throw new GoogleAdsStateNonceError('State nonce not found, expired, or already used');
    }
    const brandId = stateRecord.brandId; // server-trusted — never from query

    // ── Step 2: Token exchange → refresh_token ────────────────────────────────
    const code = typeof query['code'] === 'string' ? query['code'] : '';
    if (!code) {
      throw new GoogleAdsOAuthError('Authorization code missing from callback');
    }
    const { refreshToken, accessToken, clientId, clientSecret, developerToken } =
      await this.exchangeCodeForTokens(code, brandId);

    // ── Step 3: Resolve ALL LEAF customer ids + their required manager login-CID (Gap B + MCC) ──
    // listAccessibleCustomers returns whatever the OAuth user can reach — for an agency/MCC login
    // that's the MANAGER CID, NOT the spend-carrying leaf clients. We expand each accessible CID via
    // `customer_client` to enumerate the real leaf accounts and capture the manager CID each leaf must
    // be queried THROUGH (login-customer-id). Without this, an MCC login offers only the manager (no
    // spend) → permanent zero spend, the prod symptom. developerToken is the RESOLVED one (brand's
    // BYO developer_token when stored, else env) — not a raw env read.
    const leaves = await this.resolveLeafCustomers(accessToken, developerToken);
    const adAccountIds = leaves.map((l) => l.customerId);
    const adAccountId = adAccountIds[0] ?? null;

    // ── Step 4: one ConnectorInstance per LEAF, each with its OWN per-account secret bundle ──
    // The bundle carries the per-account login_customer_id so the repull resolver reads the correct
    // manager CID PER CONNECTOR (no global env fallback for MCC accounts). refresh_token is shared.
    const now = new Date();
    let firstInstanceId = '';

    // 0106 ad-account activation: an MCC login exposes every accessible customer id (often other
    // brands'). Don't ingest any until the user picks ONE. EXCEPTION: a single account is
    // auto-activated (nothing to choose). Multiple → all NULL → the UI prompts for a selection.
    const accountsToCreate: Array<GoogleAdsLeaf | null> =
      leaves.length > 0 ? leaves : [null];
    const autoActivate = accountsToCreate.length === 1;

    for (const account of accountsToCreate) {
      const accountId = account?.customerId ?? null;
      const loginCustomerId = account?.loginCustomerId ?? null;

      // Per-account bundle → ARN (NN-2 / I-S09). __default__ (no account) keeps a single
      // refresh-token-only bundle so a credentials-only connect still has a resolvable secret.
      //
      // AUDIT FIX (BYO refresh bug, zero-spend defect): the bundle ALSO carries the client_id /
      // client_secret (+ developer_token) that RESOLVED this exchange. A brand on BYO app creds
      // minted its refresh_token against ITS OWN client — refreshing that token with the env
      // app's client_id/client_secret is invalid_grant → permanent zero spend. Persisting the
      // resolving creds per-account lets the repull (resolveGoogleCredentials) prefer the bundle
      // over env, so ingestion + backfill inherit the correct client automatically.
      const bundle: Record<string, string> = {
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      };
      if (developerToken) bundle['developer_token'] = developerToken;
      if (accountId) bundle['ad_account_id'] = accountId;
      if (loginCustomerId) bundle['login_customer_id'] = loginCustomerId;
      const { arn: secretRef } = await this.secretsManager.storeSecret(
        brandId,
        { connectorType: 'google_ads', subKey: accountId ?? undefined },
        bundle,
      );

      const instanceId = randomUUID();
      if (!firstInstanceId) firstInstanceId = instanceId;

      const providerConfig: Record<string, string> = {};
      if (accountId) providerConfig['google_ads_customer_id'] = accountId;
      if (loginCustomerId) providerConfig['google_ads_login_customer_id'] = loginCustomerId;
      // ad_account_name = the human label the UI shows for this account's sub-card (Google Ads
      // descriptive_name from customer_client). readRoutes derives account_label from it — mirrors Meta.
      if (account?.name) providerConfig['ad_account_name'] = account.name;

      const instance = ConnectorInstance.create({
        id: instanceId,
        brandId,
        provider: 'google_ads',
        shopDomain: '',
        secretRef,
        status: 'connected',
        healthState: 'Healthy',
        safetyRating: 'safe',
        connectedAt: now,
        disconnectedAt: null,
        createdAt: now,
        updatedAt: now,
        accountKey: accountId ?? DEFAULT_ACCOUNT_KEY,
        providerConfig,
        // 0106: auto-activate only when there's a single account; otherwise wait for selection.
        activatedAt: autoActivate ? now : null,
      });
      const savedInstance = await this.connectorRepo.save(instance);

      if (accountId && this.setAdAccountId) {
        await this.setAdAccountId(brandId, savedInstance.id, accountId);
      }

      // ── Step 6: connector_sync_status per instance ──────────────────────────
      const syncStatus = ConnectorSyncStatus.create({
        id: randomUUID(),
        brandId,
        connectorInstanceId: savedInstance.id,
        state: 'waiting_for_data',
        lastSyncAt: null,
        lastError: null,
        updatedAt: now,
      });
      await this.syncStatusRepo.save(syncStatus);
    }

    // ── Step 7: emit connector.connected (NO token, NO secret_ref) ────────────
    await this.emitEvent('connector.connected', {
      brand_id: brandId,
      connector_instance_id: firstInstanceId,
      provider: 'google_ads',
      ad_account_id: adAccountId,
      ad_account_ids: adAccountIds,
      idempotency_key: idempotencyKey,
    });

    return {
      connectorInstanceId: firstInstanceId,
      brandId,
      adAccountId,
      adAccountIds,
      status: 'connected',
    };
  }

  /**
   * Exchange the authorization code for {refresh_token, access_token} via Google's token endpoint.
   * ALSO returns the creds that resolved the exchange (brand BYO-app else env) so the caller can
   * persist them into each per-account secret bundle — the refresh_token is only ever valid
   * against the client that minted it (BYO refresh bug).
   */
  private async exchangeCodeForTokens(
    code: string,
    brandId: string,
  ): Promise<{
    refreshToken: string;
    accessToken: string;
    clientId: string;
    clientSecret: string;
    developerToken?: string;
  }> {
    const creds = await resolveBrandOAuthAppCreds(this.secretsManager, 'google_ads', brandId, {
      clientId: process.env['GOOGLE_ADS_CLIENT_ID'] ?? '',
      clientSecret: process.env['GOOGLE_ADS_CLIENT_SECRET'] ?? '',
      ...(process.env['GOOGLE_ADS_DEVELOPER_TOKEN']
        ? { developerToken: process.env['GOOGLE_ADS_DEVELOPER_TOKEN'] }
        : {}),
    });
    const callbackUrl = process.env['GOOGLE_ADS_CALLBACK_URL'];
    if (!creds?.clientId || !creds?.clientSecret) {
      throw new Error(
        '[HandleGoogleAdsOAuthCallbackCommand] GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET not configured',
      );
    }

    const body = new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      code,
      grant_type: 'authorization_code',
      ...(callbackUrl ? { redirect_uri: callbackUrl } : {}),
    });

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new GoogleAdsOAuthError(`Token exchange failed (${response.status})`);
    }

    const data = (await response.json()) as { refresh_token?: string; access_token?: string };
    if (!data.refresh_token) {
      // No refresh token = offline access was not granted (user previously consented without
      // prompt=consent). Surface honestly — without it the repull cannot mint access tokens.
      throw new GoogleAdsOAuthError(
        'Token exchange: refresh_token missing (offline access not granted — re-consent required)',
      );
    }
    return {
      refreshToken: data.refresh_token,
      accessToken: data.access_token ?? '',
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      ...(creds.developerToken ? { developerToken: creds.developerToken } : {}),
    };
  }

  /**
   * Resolve ALL accessible Google Ads customer ids via customers:listAccessibleCustomers (Gap B).
   * Returns an array of customer ids (digits only, e.g. ['1234567890', '9876543210']).
   * Returns empty array on any failure — caller falls back to __default__ instance.
   */
  private async resolveAllCustomerIds(
    accessToken: string,
    developerToken?: string,
  ): Promise<string[]> {
    // Prefer the RESOLVED developer token (brand BYO bundle) — env is the shared-app fallback.
    const devToken = developerToken ?? process.env['GOOGLE_ADS_DEVELOPER_TOKEN'];
    if (!accessToken || !devToken) return [];
    try {
      const response = await fetch(
        'https://googleads.googleapis.com/v24/customers:listAccessibleCustomers',
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'developer-token': devToken,
          },
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!response.ok) return [];
      const data = (await response.json()) as { resourceNames?: string[] };
      return (data.resourceNames ?? [])
        .map((name) => name.split('/')[1])
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
    } catch {
      return [];
    }
  }

  /**
   * Resolve the real LEAF (spend-carrying) customers + the manager CID each must be queried
   * through (MCC fix). For every accessible CID we run a `customer_client` GAQL pass:
   *   - a direct (non-manager) account returns just itself → leaf with loginCustomerId=null.
   *   - a manager returns itself + descendants → each non-manager descendant is a leaf whose
   *     loginCustomerId is the manager CID we queried through.
   * Best-effort & fail-soft: if the expansion call fails, the accessible CID is kept as a direct
   * leaf (preserves the pre-MCC behaviour; never collapses to zero accounts). De-duped by leaf CID.
   */
  private async resolveLeafCustomers(
    accessToken: string,
    developerToken?: string,
  ): Promise<GoogleAdsLeaf[]> {
    const accessibleCids = await this.resolveAllCustomerIds(accessToken, developerToken);
    const byLeaf = new Map<string, GoogleAdsLeaf>();

    for (const cid of accessibleCids) {
      const expanded = await this.expandCustomerClients(accessToken, cid, developerToken);
      if (expanded === null) {
        // Expansion failed — keep the accessible CID itself as a direct leaf (fail-soft; no name).
        if (!byLeaf.has(cid)) byLeaf.set(cid, { customerId: cid, loginCustomerId: null, name: null });
        continue;
      }
      for (const leaf of expanded) {
        if (!byLeaf.has(leaf.customerId)) byLeaf.set(leaf.customerId, leaf);
      }
    }
    return [...byLeaf.values()];
  }

  /**
   * Enumerate the leaf (non-manager) clients reachable from a single accessible CID via the
   * `customer_client` resource (manager CID = login-customer-id). Returns null on any failure so the
   * caller can fail-soft. A leaf's loginCustomerId is the manager CID only when it differs from the
   * leaf itself (a directly-accessible non-manager account needs no login-customer-id header).
   */
  private async expandCustomerClients(
    accessToken: string,
    managerCid: string,
    developerToken?: string,
  ): Promise<GoogleAdsLeaf[] | null> {
    // Prefer the RESOLVED developer token (brand BYO bundle) — env is the shared-app fallback.
    const devToken = developerToken ?? process.env['GOOGLE_ADS_DEVELOPER_TOKEN'];
    if (!accessToken || !devToken) return null;
    const query =
      'SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager, ' +
      "customer_client.level, customer_client.status FROM customer_client WHERE customer_client.status = 'ENABLED'";
    try {
      const response = await fetch(
        `https://googleads.googleapis.com/v24/customers/${managerCid}/googleAds:searchStream`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'developer-token': devToken,
            'login-customer-id': managerCid,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query }),
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!response.ok) return null;
      const batches = (await response.json()) as
        | Array<{ results?: CustomerClientResult[] }>
        | { results?: CustomerClientResult[] };
      const arr = Array.isArray(batches) ? batches : [batches];
      const leaves: GoogleAdsLeaf[] = [];
      for (const batch of arr) {
        for (const r of batch.results ?? []) {
          const id = r.customerClient?.id;
          if (!id) continue;
          const isManager = r.customerClient?.manager === true;
          if (isManager) continue; // managers don't carry spend; only leaves ingest
          // login-customer-id is required only when the leaf is reached THROUGH a different manager.
          leaves.push({
            customerId: id,
            loginCustomerId: id === managerCid ? null : managerCid,
            name: r.customerClient?.descriptiveName ?? null,  // human account name for the UI sub-card
          });
        }
      }
      // A non-manager accessible account returns a single self row → that's a direct leaf.
      return leaves;
    } catch {
      return null;
    }
  }
}

/** A single `customer_client` GAQL result (subset). */
interface CustomerClientResult {
  customerClient?: { id?: string; manager?: boolean; level?: string; status?: string; descriptiveName?: string };
}

/** A resolved leaf (spend-carrying) Google Ads account + the manager CID it's queried through.
 * `name` = customer_client.descriptive_name (the human account name shown in the UI), null when
 * Google omits it (unnamed account) or the metadata pass failed (fail-soft). */
type GoogleAdsLeaf = { customerId: string; loginCustomerId: string | null; name: string | null };
