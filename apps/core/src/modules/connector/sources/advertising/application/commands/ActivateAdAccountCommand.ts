/**
 * ActivateAdAccountCommand — choose the ONE ad account that ingests for a brand+platform (0106).
 *
 * An ad-platform OAuth login (agency / MCC) exposes many ad accounts that may belong to DIFFERENT
 * brands. Brain must ingest only ONE chosen account per (brand, platform) or cross-brand spend
 * pollutes the brand's ROAS/attribution. The connect callbacks discover all accounts as
 * activated_at=NULL (no ingestion); this command is how the user picks the one to ingest.
 *
 * GENERIC across platforms: it gates on isAdPlatformProvider, so meta/google_ads today and
 * tiktok/x/… tomorrow all flow through the same command (and the same repo switch).
 *
 * Switch semantics (user-confirmed): activating account B deactivates A in the SAME transaction
 * (repo.activateAccount) — exactly one active per (brand, platform), never a two-active window.
 *
 * Invariants:
 *   - MT-1: brandId comes from the SESSION (getBrandId) — never the request body. The repo switch
 *           runs under app.current_brand_id (RLS FORCE).
 *   - I-S09: no secret_ref / token is read or logged; activation touches only activated_at.
 */

import type { AuditWriter } from '@brain/audit';
import type { IConnectorInstanceRepository } from '@brain/connector-core';
import { isAdPlatformProvider } from '@brain/connector-core';

export type ActivateAdAccountErrorCode =
  | 'CONNECTOR_NOT_FOUND'
  | 'NOT_AD_PLATFORM'
  | 'CONNECTOR_NOT_CONNECTED';

export interface ActivateAdAccountSuccess {
  ok: true;
  connectorInstanceId: string;
  provider: string;
  accountKey: string;
  activatedAt: string;
}

export interface ActivateAdAccountFailure {
  ok: false;
  code: ActivateAdAccountErrorCode;
  message: string;
}

export type ActivateAdAccountResult = ActivateAdAccountSuccess | ActivateAdAccountFailure;

export interface ActivateAdAccountInput {
  connectorInstanceId: string;
  /** brand_id from the SESSION (getBrandId) — never the request body (MT-1). */
  brandId: string;
  correlationId: string;
  actorId: string | null;
  actorRole: string;
}

export class ActivateAdAccountCommand {
  constructor(
    private readonly connectorRepo: IConnectorInstanceRepository,
    private readonly auditWriter: AuditWriter,
  ) {}

  async execute(input: ActivateAdAccountInput): Promise<ActivateAdAccountResult> {
    const { connectorInstanceId, brandId, actorId, actorRole } = input;

    // Step 1: load the target — brand-scoped (RLS FORCE / MT-1).
    const connector = await this.connectorRepo.findById(connectorInstanceId, brandId);
    if (!connector) {
      return { ok: false, code: 'CONNECTOR_NOT_FOUND', message: 'Connector not found for this brand.' };
    }

    // Step 2: activation only applies to ad-platform connectors (storefront/payment always ingest).
    if (!isAdPlatformProvider(connector.provider)) {
      return {
        ok: false,
        code: 'NOT_AD_PLATFORM',
        message: `Account activation only applies to ad platforms; ${connector.provider} ingests automatically.`,
      };
    }

    // Step 3: can't activate a disconnected/errored account — reconnect first.
    if (connector.status !== 'connected') {
      return {
        ok: false,
        code: 'CONNECTOR_NOT_CONNECTED',
        message: 'This ad account is not connected. Reconnect the platform before activating it.',
      };
    }

    // Step 4: the atomic switch — activate this one, deactivate its siblings (exactly one active).
    const activated = await this.connectorRepo.activateAccount(connectorInstanceId, brandId);
    if (!activated) {
      // Lost a race (disconnected between load and switch) — treat as not-found, idempotent-safe.
      return { ok: false, code: 'CONNECTOR_NOT_FOUND', message: 'Connector not found for this brand.' };
    }

    // Step 5: audit — which account became the active ingesting one (no secret_ref / token, I-S09).
    await this.auditWriter.append({
      brand_id: brandId,
      actor_id: actorId,
      actor_role: actorRole,
      action: 'connector.ad_account.activated',
      entity_type: 'connector_instance',
      entity_id: connectorInstanceId,
      payload: {
        connector_instance_id: connectorInstanceId,
        provider: activated.provider,
        account_key: activated.accountKey,
      },
    });

    return {
      ok: true,
      connectorInstanceId,
      provider: activated.provider,
      accountKey: activated.accountKey,
      activatedAt: (activated.activatedAt ?? new Date()).toISOString(),
    };
  }
}
