/**
 * NN-6 PII redaction — span attribute wrapper + logger redaction helper.
 *
 * Two-layer approach (both are required — NN-6):
 *  Layer 1 (this file): SDK-level wrapper that refuses to set PII-keyed span attributes.
 *  Layer 2 (OTel collector): transform/attributes processor redacts the PII key list before
 *            signals reach Grafana Cloud. Config is in infra/observability (sibling track C).
 *
 * PII key list: keys whose names match these patterns are treated as PII-bearing and
 * dropped/redacted at the SDK layer. The list is conservative — it grows, never shrinks.
 *
 * INVARIANT: brand_id IS NOT PII. It is a UUID tenant identifier. However, it MUST be
 * present on every span for tenant-scoped query and isolation audit.
 */

// ── PII key patterns ──────────────────────────────────────────────────────────

/**
 * Exact key names that are always PII and must be dropped.
 * Any span attribute key in this set is silently dropped (not sent to the exporter).
 */
const PII_EXACT_KEYS = new Set([
  'email',
  'phone',
  'mobile',
  'name',
  'full_name',
  'first_name',
  'last_name',
  'address',
  'ip',
  'ip_address',
  'user_agent',
  'dob',
  'date_of_birth',
  'pan',
  'aadhaar',
  'passport',
  'card_number',
  'cvv',
  'bank_account',
]);

/**
 * Prefix patterns — any key whose lowercase form starts with these prefixes is PII.
 */
const PII_PREFIX_PATTERNS = [
  'pan_',
  'card_',
  'aadhaar_',
  'passport_',
  'contact_',
  'pii_',
  'email_',
  'phone_',
  'address_',
];

/**
 * Suffix patterns — any key whose lowercase form ends with these suffixes is PII.
 * CAUTION: be specific. '_name' would catch 'service_name', 'event_name', etc.
 * Use 'person_name', 'full_name', 'display_name' patterns via exact keys instead.
 */
const PII_SUFFIX_PATTERNS = [
  '_email',
  '_phone',
  '_mobile',
  '_address',
  '_pan',
  '_aadhaar',
  '_passport',
];

/**
 * Returns true if the given attribute key should be treated as PII and dropped.
 * The check is case-insensitive.
 */
export function isPiiKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (PII_EXACT_KEYS.has(lower)) return true;
  for (const prefix of PII_PREFIX_PATTERNS) {
    if (lower.startsWith(prefix)) return true;
  }
  for (const suffix of PII_SUFFIX_PATTERNS) {
    if (lower.endsWith(suffix)) return true;
  }
  return false;
}

// ── Span attribute type (minimal, avoids @opentelemetry/api dep at this layer) ─

/** Allowed OTel attribute value types. */
export type AttributeValue = string | number | boolean | string[] | number[] | boolean[];

export type Attributes = Record<string, AttributeValue | undefined>;

/**
 * Filter an attributes object to remove PII-bearing keys.
 *
 * Usage:
 *   span.setAttributes(redactAttributes({ brand_id, correlation_id, user_email, ... }));
 *   // user_email is silently dropped; brand_id + correlation_id pass through.
 *
 * @param attributes — Raw attributes dict.
 * @returns A new attributes dict with PII keys removed.
 */
export function redactAttributes(attributes: Attributes): Attributes {
  const safe: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (isPiiKey(key)) {
      // Silently drop — do not log the value (that would itself be a PII log violation).
      continue;
    }
    safe[key] = value;
  }
  return safe;
}

// ── Logger redaction ─────────────────────────────────────────────────────────

/**
 * Redact PII values from a pino/structlog-style log record.
 *
 * Call this before serialising a log record to JSON. Any field whose key
 * matches the PII key patterns has its value replaced with '[REDACTED]'.
 *
 * @param record — Arbitrary log record (key-value pairs).
 * @returns A new record with PII values replaced.
 */
export function redactLogRecord(record: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (isPiiKey(key)) {
      safe[key] = '[REDACTED]';
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      // Recursively redact nested objects
      safe[key] = redactLogRecord(value as Record<string, unknown>);
    } else {
      safe[key] = value;
    }
  }
  return safe;
}
