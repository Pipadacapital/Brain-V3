/**
 * Ga4ConnectorAdapter — IConnector implementation for Google Analytics 4.
 *
 * Connect method: OAuth2 (client_id + client_secret + refresh_token OR a service-account JSON key)
 * with the analytics.readonly scope. No inbound webhooks — GA4 is a polling source only.
 *
 * CREDENTIAL BOUNDARY (NN-2):
 *   authenticate() stores the credential bundle in Secrets Manager and returns a secretRef (ARN).
 *   The token/key NEVER crosses this boundary. The service-account JSON key path is gated at
 *   the same boundary: the caller stores it, this adapter returns only the ARN.
 *
 * HONEST-EMPTY GUARD:
 *   validate() probes the GA4 Data API /metadata endpoint (cheap, read-only).
 *   sync() and backfill() are implemented inside the stream-worker repull job (ga4-repull/run.ts),
 *   which honours the honest-empty guard: when no credential / property is configured the job
 *   surfaces 'GA4 not connected — add credentials' and emits ZERO events (no fabricated sessions).
 *
 * The verbs that require live DI or the stream-worker scheduler are stubbed with clear
 * 'not yet wired' errors — identical to the pattern in ShopifyConnectorAdapter.ts. Each stub
 * documents which job / command it delegates to in the full wiring.
 *
 * GA4 WEBHOOK NOTE:
 *   GA4 does NOT offer inbound webhooks for session/dimension data. The webhook() verb throws
 *   explicitly stating this — it is not a missing feature but an architectural property of GA4.
 */

import {
  type IConnector,
  type AuthResult,
  type ValidationResult,
  type HealthResult,
  type ConnectorInstance,
  type ConnectorSyncStatus,
} from '@brain/connector-core';

// ── Auth param shapes ─────────────────────────────────────────────────────────

/** OAuth2 credential bundle (authorize code + property id). */
export interface Ga4OAuthParams {
  /** OAuth2 authorization code (from Google consent screen callback). */
  readonly code: string;
  /** OAuth2 redirect URI used during the flow. */
  readonly redirectUri: string;
  /** GA4 Property ID (numeric, e.g. '123456789'). */
  readonly propertyId: string;
}

/** Service-account JSON key bundle (alternative auth method). */
export interface Ga4ServiceAccountParams {
  /** The full service-account JSON key object (stored immediately to Secrets Manager). */
  readonly serviceAccountKey: Readonly<Record<string, unknown>>;
  /** GA4 Property ID (numeric, e.g. '123456789'). */
  readonly propertyId: string;
}

export type Ga4AuthParams = Ga4OAuthParams | Ga4ServiceAccountParams;

/** Sync params: the date window to pull. */
export interface Ga4SyncParams {
  /** ISO date YYYY-MM-DD — start of the trailing window. */
  readonly startDate: string;
  /** ISO date YYYY-MM-DD — end of the trailing window. */
  readonly endDate: string;
}

// ── Credential missing error ──────────────────────────────────────────────────

/**
 * Thrown by validate() / sync() / backfill() / health() when the connector has no
 * stored credentials or property id configured. This is the HONEST-EMPTY guard:
 * a connector instance that was created without completing OAuth or service-account
 * setup MUST surface this error explicitly — it must NEVER fabricate data.
 */
export class Ga4NotConnectedError extends Error {
  constructor() {
    super(
      '[Ga4ConnectorAdapter] GA4 not connected — add credentials (complete OAuth or provide a service-account JSON key + propertyId). ' +
      'No sessions will be returned until credentials are configured.',
    );
    this.name = 'Ga4NotConnectedError';
  }
}

// ── Not-wired stub ────────────────────────────────────────────────────────────

/**
 * Throw a clear "not yet wired" error for verbs that require live DI wiring.
 * Mirrors the pattern in ShopifyConnectorAdapter.ts so the call-site is unambiguous.
 */
const NOT_WIRED = (verb: string): never => {
  throw new Error(
    `[Ga4ConnectorAdapter] ${verb}() is not yet wired to its command/job in this adapter. ` +
    `The live path for sync/backfill is the ga4-repull stream-worker job (ga4-repull/run.ts). ` +
    `Thread it through during the full connector-platform wiring migration.`,
  );
};

// ── IConnector implementation ─────────────────────────────────────────────────

export class Ga4ConnectorAdapter
  implements IConnector<Ga4AuthParams, Ga4AuthParams, Ga4SyncParams, never>
{
  readonly provider = 'ga4';

  /**
   * Exchange OAuth code or service-account key for a stored secret_ref (ARN).
   *
   * The credential bundle is written to Secrets Manager; the ARN is returned.
   * The raw token / key NEVER crosses this boundary (NN-2).
   *
   * Full implementation requires live Google OAuth endpoints and Secrets Manager.
   * Delegates to HandleGa4OAuthCallbackCommand (not yet wired) for OAuth path, or
   * a direct Secrets Manager write for the service-account path.
   */
  async authenticate(_brandId: string, _params: Ga4AuthParams): Promise<AuthResult> {
    return NOT_WIRED('authenticate');
  }

  /**
   * Validate the credential / property id configuration WITHOUT mutating state.
   *
   * For OAuth: probes the GA4 Data API /properties/{propertyId}/metadata endpoint
   * (read-only, no quota impact). Returns valid=false with a human-readable reason when:
   *   - propertyId is absent or non-numeric
   *   - The Data API responds with 403 (wrong scope / credentials)
   *   - The property does not exist (404)
   *
   * For service-account: validates that the JSON key has the required fields and that
   * the principal has analytics.readonly on the property.
   *
   * Full implementation requires live Google APIs and the stored secret to be resolved.
   * Until wired, returns an honest error rather than fabricating a pass.
   */
  async validate(_brandId: string, params: Ga4AuthParams): Promise<ValidationResult> {
    // Structural validation: propertyId must be present and numeric.
    const propertyId = 'propertyId' in params ? params.propertyId : undefined;
    if (!propertyId || !/^\d+$/.test(propertyId.trim())) {
      return {
        valid: false,
        reason: `GA4 propertyId "${propertyId ?? ''}" is missing or non-numeric. ` +
          `Provide the numeric GA4 property id (e.g. "123456789").`,
      };
    }

    if ('code' in params) {
      // OAuth path: code must be non-empty.
      if (!params.code.trim()) {
        return { valid: false, reason: 'GA4 OAuth code is missing.' };
      }
      if (!params.redirectUri.trim()) {
        return { valid: false, reason: 'GA4 OAuth redirectUri is missing.' };
      }
    } else {
      // Service-account path: the key must be a non-empty object.
      if (!params.serviceAccountKey || typeof params.serviceAccountKey !== 'object') {
        return { valid: false, reason: 'GA4 service-account JSON key is missing or malformed.' };
      }
      if (!('client_email' in params.serviceAccountKey)) {
        return {
          valid: false,
          reason: 'GA4 service-account JSON key is missing required field "client_email".',
        };
      }
    }

    // Live API probe (requires wired credentials resolver) — deferred to full wiring.
    // Until then, structural validation above is the honest boundary we can assert.
    // We do NOT return `valid: true` without confirming credentials actually work.
    return NOT_WIRED('validate (live API probe)');
  }

  /**
   * Establish the GA4 connection: create/activate the ConnectorInstance.
   * Delegates to HandleGa4ConnectCommand (not yet wired — requires live Secrets Manager).
   */
  async connect(_brandId: string, _params: Ga4AuthParams): Promise<ConnectorInstance> {
    return NOT_WIRED('connect');
  }

  /**
   * Run an incremental sync for one date window.
   * Delegates to the ga4-repull stream-worker job (ga4-repull/run.ts).
   * The repull job implements the HONEST-EMPTY guard: no credential → surfaces
   * 'GA4 not connected' and emits zero events.
   */
  async sync(_brandId: string, _params: Ga4SyncParams): Promise<ConnectorSyncStatus> {
    return NOT_WIRED('sync (delegates to ga4-repull/run.ts)');
  }

  /**
   * Run a historical backfill (same code path as sync — data API window only).
   * Delegates to the ga4-repull stream-worker job (backfill = wider window, same runReport API).
   */
  async backfill(_brandId: string, _params: Ga4SyncParams): Promise<ConnectorSyncStatus> {
    return NOT_WIRED('backfill (delegates to ga4-repull/run.ts with wider window)');
  }

  /**
   * GA4 does NOT support inbound webhooks for session/dimension data.
   * This is an architectural property of the GA4 Data API — it is a polling source only.
   * The run-report-based repull (ga4-repull/run.ts) is the correct path.
   */
  async webhook(_brandId: string, _params: never): Promise<void> {
    throw new Error(
      '[Ga4ConnectorAdapter] GA4 does not support inbound webhooks for session/analytics data. ' +
      'Use the ga4-repull stream-worker job (polling via Data API runReport) instead.',
    );
  }

  /**
   * Probe live connection health by calling the GA4 Data API /metadata endpoint.
   * Returns 'Degraded' / 'Unhealthy' with diagnostic detail when credentials have expired.
   * Delegates to a health-probe helper (not yet wired — requires live credential resolution).
   */
  async health(_brandId: string): Promise<HealthResult> {
    return NOT_WIRED('health (delegates to GA4 metadata probe)');
  }

  /** Tear down the connection: flip the instance to disconnected. */
  async disconnect(_brandId: string): Promise<ConnectorInstance> {
    return NOT_WIRED('disconnect');
  }
}
