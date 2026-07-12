/**
 * ConnectMetaWithSystemUserTokenCommand — the credential (system-user token) Meta connect path.
 *
 * RECOMMENDED path for production tenants (mirrors the generic per-brand Shopify connect,
 * owner requirement 2026-07-12): the brand creates a SYSTEM USER in Meta Business Settings,
 * assigns it the ad account with the ads_read permission, generates a NEVER-EXPIRING token,
 * and pastes it (plus optionally the ad account id) into the connect form. No browser OAuth
 * redirect, no ~60-day token death, no proactive re-exchange needed.
 *
 * Flow (mirrors HandleMetaOAuthCallbackCommand's post-exchange steps — NN-2/I-S09 preserved):
 *   1. Validate the pasted token via GET /me (the token has no OAuth handshake to prove it;
 *      this call IS the validation) → MetaSystemUserTokenInvalidError (user-facing 422).
 *   2. Resolve the ad account(s):
 *      - ad_account_id supplied → fetch THAT account with the token (proves the system user
 *        was actually assigned the account) → MetaAdAccountAccessError when unreachable.
 *      - absent → resolveAllMetaAdAccounts (the SAME /me/adaccounts resolution the OAuth
 *        callback uses); empty → a single __default__ instance (honest fallback).
 *   3. Store the token in Secrets Manager → ARN only proceeds (NN-2 / I-S09). The bundle is
 *      stamped `token_type: 'system_user'` so the proactive meta-token-refresh job SKIPS it
 *      (system-user tokens never expire; fb_exchange_token would fail on them anyway).
 *   4. One ConnectorInstance per account (Gap B), 0106 auto-activate iff exactly one.
 *   5. connector_sync_status per instance + connector.connected event (NO token in payload).
 *
 * brandId comes from the caller's authenticated session (writeRoutes getBrandId) — this is a
 * same-request credential connect, not a callback, so there is no state-nonce step.
 */
import { randomUUID } from 'node:crypto';
import { ConnectorInstance, DEFAULT_ACCOUNT_KEY } from '@brain/connector-core';
import { ConnectorSyncStatus } from '@brain/connector-core';
import type { IConnectorInstanceRepository } from '@brain/connector-core';
import type { IConnectorSyncStatusRepository } from '@brain/connector-core';
import type { ISecretsManager } from '@brain/connector-secrets';
import type { SetAdAccountIdFn } from './HandleMetaOAuthCallbackCommand.js';
import {
  resolveAllMetaAdAccounts,
  validateMetaAccessToken,
  fetchMetaAdAccount,
  type MetaAdAccount,
} from '../meta-graph.js';

/** Bundle marker: a system-user token never expires → meta-token-refresh must skip it. */
export const META_SYSTEM_USER_TOKEN_TYPE = 'system_user' as const;

export interface ConnectMetaWithSystemUserTokenInput {
  /** Server-trusted brand id (from the authenticated session — never a request body). */
  brandId: string;
  /** The system-user access token the brand pasted. NEVER logged/returned (I-S09). */
  accessToken: string;
  /** Optional ad account id (`act_123` or bare digits). Absent → enumerate /me/adaccounts. */
  adAccountId?: string;
  idempotencyKey: string;
}

export interface ConnectMetaWithSystemUserTokenResult {
  connectorInstanceId: string;
  brandId: string;
  /** First resolved account id (back-compat single-account shape), or null (honest). */
  adAccountId: string | null;
  adAccountIds: string[];
  status: 'connected';
}

/** Meta rejected the pasted token on /me — wrong/expired/revoked token (user-facing 422). */
export class MetaSystemUserTokenInvalidError extends Error {
  readonly code = 'META_TOKEN_INVALID';
  constructor(
    message = 'Meta rejected this token. Generate a system-user token with ads_read in Business Settings and try again.',
  ) {
    super(message);
    this.name = 'MetaSystemUserTokenInvalidError';
  }
}

/** The token is valid but cannot reach the given ad account (not assigned to the system user). */
export class MetaAdAccountAccessError extends Error {
  readonly code = 'META_AD_ACCOUNT_INACCESSIBLE';
  constructor(adAccountId: string) {
    super(
      `This token cannot access ad account ${adAccountId}. Assign the account to the system user in Business Settings, then retry.`,
    );
    this.name = 'MetaAdAccountAccessError';
  }
}

export class ConnectMetaWithSystemUserTokenCommand {
  constructor(
    private readonly secretsManager: ISecretsManager,
    private readonly connectorRepo: IConnectorInstanceRepository,
    private readonly syncStatusRepo: IConnectorSyncStatusRepository,
    private readonly emitEvent: (eventName: string, payload: Record<string, unknown>) => Promise<void>,
    /** Optional — persists ad_account_id onto the row (same hook the OAuth callback uses). */
    private readonly setAdAccountId?: SetAdAccountIdFn,
  ) {}

  async execute(
    input: ConnectMetaWithSystemUserTokenInput,
  ): Promise<ConnectMetaWithSystemUserTokenResult> {
    const { brandId, idempotencyKey } = input;
    const accessToken = input.accessToken.trim();
    if (!accessToken) {
      throw new MetaSystemUserTokenInvalidError('access_token is required');
    }

    // ── Step 1: token validation — GET /me IS the auth proof for a pasted token ──
    const tokenValid = await validateMetaAccessToken(accessToken);
    if (!tokenValid) {
      throw new MetaSystemUserTokenInvalidError();
    }

    // ── Step 2: resolve ad account(s) ────────────────────────────────────────────
    let adAccounts: MetaAdAccount[];
    const requestedAccountId = input.adAccountId?.trim();
    if (requestedAccountId) {
      // Explicit account: the fetch proves the system user was assigned THIS account.
      const account = await fetchMetaAdAccount(accessToken, requestedAccountId);
      if (!account) {
        throw new MetaAdAccountAccessError(requestedAccountId);
      }
      adAccounts = [account];
    } else {
      // Same enumeration as the OAuth callback (Gap B). Empty → __default__ instance.
      adAccounts = await resolveAllMetaAdAccounts(accessToken);
    }
    const adAccountIds = adAccounts.map((a) => a.id);
    const adAccountId = adAccountIds[0] ?? null;

    // ── Step 3: Secrets Manager bundle → ARN (NN-2 / I-S09) ─────────────────────
    // token_type=system_user marks the token as never-expiring so meta-token-refresh skips it.
    const { arn: secretRef } = await this.secretsManager.storeSecret(
      brandId,
      { connectorType: 'meta', subKey: adAccountId ?? undefined },
      {
        access_token: accessToken,
        access_token_issued_at: new Date().toISOString(),
        token_type: META_SYSTEM_USER_TOKEN_TYPE,
      },
    );
    // accessToken is now discarded — only secretRef (ARN) proceeds.

    // ── Step 4: one ConnectorInstance per account (Gap B, 0106 activation) ───────
    const accountsToCreate: Array<MetaAdAccount | null> =
      adAccounts.length > 0 ? adAccounts : [null];
    const autoActivate = accountsToCreate.length === 1;

    const now = new Date();
    let firstInstanceId = '';

    for (const account of accountsToCreate) {
      const accountId = account?.id ?? null;
      const accountName = account?.name ?? null;
      const instanceId = randomUUID();
      if (!firstInstanceId) firstInstanceId = instanceId;

      const instance = ConnectorInstance.create({
        id: instanceId,
        brandId,
        provider: 'meta',
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
        // auth_method lets read surfaces distinguish the system-user connect from OAuth.
        providerConfig: {
          auth_method: 'system_user_token',
          ...(accountId ? { ad_account_id: accountId } : {}),
          ...(accountName ? { ad_account_name: accountName } : {}),
        },
        // 0106: auto-activate only when there's a single account; otherwise wait for selection.
        activatedAt: autoActivate ? now : null,
      });
      const savedInstance = await this.connectorRepo.save(instance);

      if (accountId && this.setAdAccountId) {
        await this.setAdAccountId(brandId, savedInstance.id, accountId);
      }

      // ── Step 5: connector_sync_status per instance ─────────────────────────────
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

    // ── connector.connected (NO token, NO secret_ref) ────────────────────────────
    await this.emitEvent('connector.connected', {
      brand_id: brandId,
      connector_instance_id: firstInstanceId,
      provider: 'meta',
      auth_method: 'system_user_token',
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
}
