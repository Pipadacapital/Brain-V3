/**
 * credential-fields.ts — connector connect-form field helpers.
 *
 * SINGLE SOURCE OF TRUTH: the server catalog. The marketplace renders from `tile.auth_fields`
 * (GET /api/v1/connectors), mapped via authFieldsToCredentialFields(). There is NO hardcoded
 * per-connector field set here anymore — the previous fallback sets duplicated the catalog and,
 * worse, a connector without auth_fields used to fall through to RAZORPAY's fields (so GA4 / an
 * OAuth tile could render Razorpay's credential form). credentialFieldsFor() now returns an EMPTY
 * set for an unknown connector: a tile with no server-declared fields renders NO credential inputs,
 * never another connector's.
 *
 * A field marked secret=true is stored in the backend secret bundle and NEVER echoed back to the
 * client (renders as type="password", autoComplete="off"). Non-secret fields are merchant
 * identifiers visible in the provider dashboard. The backend bundles secret fields under ONE
 * secret_ref per connector and writes the routing identifier to provider_config.
 */
import type { ConnectorAuthFieldDto } from '@/lib/api/types';

export interface CredentialField {
  key: string;
  label: string;
  placeholder: string;
  secret: boolean;
  /** When true, the field may be left blank (the connect submit isn't gated on it). */
  optional?: boolean;
  /** Optional helper text rendered beneath the input. */
  hint?: string;
}

/**
 * Offline fallback for a tile that arrives with no server `auth_fields` (an older server). The
 * server catalog is the SoR, so there is intentionally NO hardcoded per-connector field set and NO
 * cross-connector default: an unknown / field-less connector returns an empty set and the tile
 * simply renders no credential inputs. This prevents the class of bug where one connector rendered
 * another connector's credential form. Kept (returning []) so existing imports stay valid.
 */
export function credentialFieldsFor(_tileId: string): CredentialField[] {
  return [];
}

/** Generic placeholder for a server-declared field (the catalog carries no per-field placeholder). */
function placeholderFor(f: ConnectorAuthFieldDto): string {
  if (f.secret) return '••••••••••••';
  if (f.type === 'url') return 'https://your-store.example.com';
  return '';
}

/** Map ONE server auth field (catalog SoR) → the form's CredentialField shape. */
export function authFieldToCredentialField(f: ConnectorAuthFieldDto): CredentialField {
  return {
    key: f.key,
    label: f.label,
    placeholder: placeholderFor(f),
    secret: f.secret,
    optional: f.optional,
    ...(f.hint ? { hint: f.hint } : {}),
  };
}

/**
 * Map the server-supplied auth fields (tile.auth_fields) → the connect form's fields. This is the
 * ONLY path that produces credential inputs — the marketplace renders exclusively from the catalog,
 * so a connector's fields are defined in exactly one place (apps/core catalog/registry.ts).
 */
export function authFieldsToCredentialFields(fields: ConnectorAuthFieldDto[]): CredentialField[] {
  return fields.map(authFieldToCredentialField);
}
