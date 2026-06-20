/**
 * redactShopifyPii — structure-preserving PII redaction for the raw-webhook archive.
 *
 * Goal: let an operator SEE the raw Shopify webhook shape (every key, nesting, and
 * non-PII value) WITHOUT ever persisting raw PII (I-S02). We deep-walk the parsed
 * body and replace PII *leaf values* with REDACTION_TOKEN — keys and structure are
 * untouched, so the archived JSON is a faithful template of what Shopify sent.
 *
 * Conservative by key name (not by value heuristics). PII keys are masked anywhere
 * in the tree; inside an address container, the full-name `name` is masked too
 * (top-level `order.name` — the order number like "#1001" — is intentionally kept).
 *
 * Pure + side-effect-free: input is never mutated (it deep-clones as it walks).
 */

export const REDACTION_TOKEN = '[REDACTED:PII]';

/** PII leaf keys masked wherever they appear in the tree (case-insensitive). */
const PII_KEYS: ReadonlySet<string> = new Set([
  'email',
  'contact_email',
  'phone',
  'first_name',
  'last_name',
  'address1',
  'address2',
  'company',
  'zip',
  'latitude',
  'longitude',
]);

/** Address containers: inside these, `name` (full name) is also PII and masked. */
const ADDRESS_CONTAINER_KEYS: ReadonlySet<string> = new Set([
  'billing_address',
  'shipping_address',
  'default_address',
]);

/**
 * Returns a redacted deep copy of `value`. Non-null PII leaves become REDACTION_TOKEN;
 * `null`/absent values stay as-is (so "field was present but empty" remains visible).
 *
 * @param value      the parsed JSON value to redact
 * @param parentKey  the key under which `value` sits (drives address-name masking)
 * @param inAddress  true when walking inside an address container
 */
export function redactShopifyPii(
  value: unknown,
  parentKey?: string,
  inAddress = false,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactShopifyPii(item, parentKey, inAddress));
  }

  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const lower = key.toLowerCase();
      const childInAddress = inAddress || ADDRESS_CONTAINER_KEYS.has(lower);
      const isPiiKey =
        PII_KEYS.has(lower) || (childInAddress && lower === 'name');

      if (isPiiKey) {
        // Mask the leaf value but keep the key + a null as null (preserve emptiness).
        out[key] = child === null || child === undefined ? child : REDACTION_TOKEN;
      } else {
        out[key] = redactShopifyPii(child, lower, childInAddress);
      }
    }
    return out;
  }

  // Primitive at a non-PII key — keep as-is.
  return value;
}
