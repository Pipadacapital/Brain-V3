/**
 * credential-schema.ts — the generic credential split helper (ADDITIVE foundation).
 *
 * Unified credential-storage model (the target this helper enables):
 *   - SECRET fields  (authField.secret === true)  → the Secrets Manager bundle, i.e. the
 *     single per-connector secret stored via connectorSecretsManager.storeSecret(...). These
 *     are never echoed back to the client and never written to connector_instance columns.
 *   - NON-SECRET fields (authField.secret === false) → connector_instance.provider_config,
 *     the merchant identifiers (URLs, account/merchant/app IDs) that are safe to display.
 *
 * splitConnectorCredentials() partitions a flat `values` map by each field's `secret` flag,
 * driven entirely by the declarative ConnectorAuthField[] from the catalog.
 *
 * planCredentialConnect() builds on it to produce the FULL storage plan (secret bundle + the
 * provider_config/column routing identifier + sub-key + shop_domain + missing-required check) for
 * a credential connector, driven by its CredentialConnectSpec. It is the generic replacement for
 * the hand-written per-connector connect branches that used to live in bootstrap/registerConnectors.ts.
 */

import type { ConnectorAuthField, CredentialConnectSpec } from './catalog/index.js';

export interface SplitCredentials {
  /** secret:true fields → Secrets Manager bundle (storeSecret). */
  secrets: Record<string, string>;
  /** secret:false fields → connector_instance.provider_config. */
  config: Record<string, string>;
}

/**
 * Partition provided credential values into the secret bundle vs the non-secret provider_config,
 * using the connector's declarative authFields. Only keys that are PRESENT and non-empty (after
 * trimming) are included — absent/blank optional fields are simply omitted from both maps.
 *
 * Keys in `values` that have no matching authField are ignored (the schema is authoritative).
 */
export function splitConnectorCredentials(
  authFields: ConnectorAuthField[],
  values: Record<string, string | undefined>,
): SplitCredentials {
  const secrets: Record<string, string> = {};
  const config: Record<string, string> = {};

  for (const field of authFields) {
    const raw = values[field.key];
    if (raw === undefined || raw === null) continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;

    if (field.secret) {
      secrets[field.key] = trimmed;
    } else {
      config[field.key] = trimmed;
    }
  }

  return { secrets, config };
}

/** A complete, store-ready plan for connecting one credential connector. */
export interface CredentialConnectPlan {
  /** Secrets Manager bundle: secret:true fields ∪ spec.bundleNonSecretFields (present, trimmed). */
  secretBundle: Record<string, string>;
  /** Per-account sub-key for the secret ref + connector_instance.account_key. */
  accountKey: string;
  /** provider_config (and the dedicated instanceColumn) = the routing identifier; {} when absent. */
  providerConfig: Record<string, string>;
  /** value for connector_instance.shop_domain ('' when the spec has no shopDomainField). */
  shopDomain: string;
  /** The dedicated column to set + its value, when the routing field is present; null otherwise. */
  instanceColumnUpdate: { column: string; value: string } | null;
  /** Required (non-optional) authField keys that are missing/blank. Empty ⇒ valid submission. */
  missingRequired: string[];
}

/** SQL-identifier guard for the catalog-supplied instance column (defence-in-depth; it is static). */
const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]*$/;

function trimmed(values: Record<string, string | undefined>, key: string): string {
  return (values[key] ?? '').trim();
}

/**
 * Build the full credential-connect storage plan from the connector's declarative authFields +
 * CredentialConnectSpec. Pure (no I/O) and side-effect free, so it is unit-tested directly and the
 * connect handler stays a thin orchestration of storeSecret → save → column update → audit.
 *
 * The plan preserves the exact secret-bundle and column shape each connector's runtime read path
 * (repull jobs, token providers, webhook receivers) already expects — see CredentialConnectSpec.
 */
export function planCredentialConnect(
  authFields: ConnectorAuthField[],
  spec: CredentialConnectSpec,
  values: Record<string, string | undefined>,
): CredentialConnectPlan {
  if (!SAFE_IDENTIFIER.test(spec.instanceColumn)) {
    throw new Error(`Invalid instanceColumn in connector spec: ${spec.instanceColumn}`);
  }

  const missingRequired = authFields
    .filter((f) => !f.optional)
    .filter((f) => trimmed(values, f.key).length === 0)
    .map((f) => f.key);

  const { secrets } = splitConnectorCredentials(authFields, values);
  const secretBundle: Record<string, string> = { ...secrets };
  for (const key of spec.bundleNonSecretFields ?? []) {
    const v = trimmed(values, key);
    if (v.length > 0) secretBundle[key] = v;
  }

  const routingValue = trimmed(values, spec.accountKeyField);
  const fallbackValue = spec.accountKeyFallbackField ? trimmed(values, spec.accountKeyFallbackField) : '';
  const accountKey = routingValue.length > 0 ? routingValue : fallbackValue;

  // The dedicated column + provider_config carry the routing identifier ONLY when it was supplied
  // (e.g. Shiprocket's optional channel_id — when blank, no column/config is written, sub-key=email).
  const hasRouting = routingValue.length > 0;
  const providerConfig: Record<string, string> = hasRouting ? { [spec.instanceColumn]: routingValue } : {};
  const instanceColumnUpdate = hasRouting ? { column: spec.instanceColumn, value: routingValue } : null;

  const shopDomain = spec.shopDomainField ? trimmed(values, spec.shopDomainField) : '';

  return { secretBundle, accountKey, providerConfig, shopDomain, instanceColumnUpdate, missingRequired };
}

/** Result of minting the spec's generated secrets onto a connect plan's bundle. */
export interface GeneratedSecretsResult {
  /** The secret bundle with newly-minted values merged in (generated keys added when absent). */
  bundle: Record<string, string>;
  /** The newly minted key→value pairs — surfaced ONCE to the merchant (e.g. the webhook token). */
  generated: Record<string, string>;
}

/**
 * Mint cryptographically-random values for the spec's `generatedSecretFields` that the merchant did
 * NOT supply, merging them into the secret bundle. This is the connect-time provisioning step for
 * connectors where Brain MINTS the webhook token rather than the merchant entering it (Shiprocket:
 * Brain generates the X-Api-Key, the merchant pastes it into their Shiprocket dashboard — so
 * `webhook_secret` is generated here, not a form input).
 *
 * Impure-by-design (calls `generate`), so it is SEPARATE from the pure planCredentialConnect — the
 * plan's bundle shape stays deterministic + unit-pinned, and generation is layered on top by the
 * connect handler. A key already present in the bundle (user-supplied) is left untouched (never
 * regenerated), and only the freshly minted keys are returned in `generated` for the connect response.
 *
 * `generate` MUST return a high-entropy secret (e.g. randomBytes(24).toString('hex')); the value is
 * stored in the Secrets Manager bundle and NEVER logged.
 */
export function provisionGeneratedSecrets(
  bundle: Record<string, string>,
  spec: CredentialConnectSpec,
  generate: () => string,
): GeneratedSecretsResult {
  const out: Record<string, string> = { ...bundle };
  const generated: Record<string, string> = {};
  for (const key of spec.generatedSecretFields ?? []) {
    if ((out[key] ?? '').trim().length > 0) continue; // user-supplied wins — never regenerate
    const value = generate();
    out[key] = value;
    generated[key] = value;
  }
  return { bundle: out, generated };
}
