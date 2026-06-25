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
 * driven entirely by the declarative ConnectorAuthField[] from the catalog. It is the generic
 * replacement for the hand-written per-connector "which key goes where" branches in
 * bootstrap/registerConnectors.ts.
 *
 * ADDITIVE-ONLY: nothing calls this yet. It changes no runtime behavior; it exists so the
 * per-connector credential branches can be unified onto a single, schema-driven path later.
 */

import type { ConnectorAuthField } from './catalog/index.js';

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
