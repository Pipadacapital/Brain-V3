/**
 * oauth-app-creds.ts — per-brand "bring-your-own-app" OAuth credential resolution.
 *
 * The three OAuth connectors (Shopify, Meta, Google Ads) historically used ONE app-level
 * client_id/client_secret from process.env. This seam lets each BRAND supply its own OAuth app's
 * credentials (entered in the connect UI), so connections are fully tenant-isolated.
 *
 * STORAGE: the client_secret is a secret → Secrets Manager only (never on connector_instance — the
 * NN-2 column-name guard forbids *_secret columns). We co-locate the non-secret client_id in the
 * SAME per-brand secret bundle so the OAuth callback can retrieve both by (brand, provider) with no
 * connector_instance row (which does not exist yet at initiate time). The secret name is
 * deterministic — `brain/connector/<provider>_app/<brandId>` — so initiate (store) and callback
 * (resolve) agree without threading anything through the OAuth state (state stays brandId-only).
 *
 * RESOLUTION ORDER: the brand's stored app creds (Secrets Manager) → the env app creds (back-compat,
 * so existing single-app deployments keep working) → null (caller treats as not-configured).
 *
 * I-S09: credential values are never logged here or returned to anywhere that logs them.
 */
import { loadCoreConfig } from '@brain/config';
import type { ISecretsManager } from '@brain/connector-secrets';

/** OAuth connector providers that support per-brand BYO-app credentials. */
export type OAuthProvider = 'shopify' | 'meta' | 'google_ads';

export interface OAuthAppCreds {
  clientId: string;
  clientSecret: string;
  /**
   * Provider-level API token that must travel WITH the OAuth app creds (google_ads only today:
   * the Google Ads developer_token). Optional — providers without one never set it, and a brand
   * on the shared env app inherits the env developer token. Secret-tier: bundle-only, never PG.
   */
  developerToken?: string;
}

/** The pseudo connector-type under which a brand's OAuth APP creds are stored (vs the token). */
function appConnectorType(provider: OAuthProvider): string {
  return `${provider}_app`;
}

/** Deterministic per-brand secret name — must match AwsSecretsManager/LocalSecretsManager naming. */
function appSecretName(provider: OAuthProvider, brandId: string): string {
  return `brain/connector/${appConnectorType(provider)}/${brandId}`;
}

/** The app-level (env) client_id for a provider — the back-compat fallback when a brand has no own app. */
function envClientId(provider: OAuthProvider): string | undefined {
  const cfg = loadCoreConfig();
  switch (provider) {
    case 'shopify':
      return cfg.SHOPIFY_CLIENT_ID;
    case 'meta':
      return cfg.META_APP_ID;
    case 'google_ads':
      return cfg.GOOGLE_ADS_CLIENT_ID;
  }
}

/**
 * Resolve the client_id to use when building a brand's authorize URL: the brand's stored app
 * client_id (Secrets Manager) → the env app client_id (back-compat) → undefined (not configured).
 * Only the client_id is needed at initiation; the secret is resolved at callback.
 */
export async function resolveBrandOAuthClientId(
  secretsManager: ISecretsManager,
  provider: OAuthProvider,
  brandId: string,
): Promise<string | undefined> {
  try {
    const bundle = await secretsManager.getSecret(appSecretName(provider, brandId));
    if (bundle?.['client_id']) return bundle['client_id'];
  } catch {
    // fall through to env
  }
  return envClientId(provider);
}

/**
 * Store (UPSERT) a brand's OAuth app credentials. Idempotent: re-entering creds overwrites the
 * value, preserving the secret ARN (reconnect-safe). Both values go into ONE Secrets Manager bundle.
 */
export async function storeBrandOAuthAppCreds(
  secretsManager: ISecretsManager,
  provider: OAuthProvider,
  brandId: string,
  creds: OAuthAppCreds,
): Promise<void> {
  await secretsManager.storeSecret(
    brandId,
    { connectorType: appConnectorType(provider) },
    {
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      // developer_token rides the SAME app bundle when supplied (google_ads BYO-app: the brand's
      // own Google Ads developer token). Absent for providers without one — key omitted entirely.
      ...(creds.developerToken ? { developer_token: creds.developerToken } : {}),
    },
  );
}

/**
 * Resolve the OAuth app creds to use for a brand: the brand's stored creds first, else the provided
 * env fallback (back-compat), else null. The env fallback is passed by the caller because each
 * connector sources it differently (Shopify's secret comes via getShopifyClientSecret).
 */
export async function resolveBrandOAuthAppCreds(
  secretsManager: ISecretsManager,
  provider: OAuthProvider,
  brandId: string,
  envFallback: OAuthAppCreds | null,
): Promise<OAuthAppCreds | null> {
  try {
    const bundle = await secretsManager.getSecret(appSecretName(provider, brandId));
    const clientId = bundle?.['client_id'];
    const clientSecret = bundle?.['client_secret'];
    if (clientId && clientSecret) {
      // Brand bundle wins. developer_token: the brand's own when stored, else the env fallback's —
      // a brand may BYO the OAuth app pair while still riding the shared env developer token.
      const developerToken = bundle?.['developer_token'] ?? envFallback?.developerToken;
      return { clientId, clientSecret, ...(developerToken ? { developerToken } : {}) };
    }
  } catch {
    // fall through to env fallback
  }
  if (envFallback?.clientId && envFallback?.clientSecret) return envFallback;
  return null;
}
