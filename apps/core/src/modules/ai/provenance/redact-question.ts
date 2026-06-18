/**
 * redactQuestion — deterministic, Tier-0 (NO model call) PII/free-text redaction (D4).
 *
 * The RAW natural-language question is passed to the NLQ resolver IN-MEMORY ONLY and is
 * NEVER written to disk, DB, or logs. Only `redactQuestion(raw)` is persisted to
 * ai_provenance.question_redacted and emitted in any log line (I-S08 / privacy invariant).
 *
 * Redaction is PURE and DETERMINISTIC (same input → same output, no randomness, no clock,
 * no network) so the provenance row is reproducible and the redaction is unit-testable
 * against a PII corpus (must contain ZERO email / phone / long-digit run / URL after redaction).
 *
 * Strategy: strip high-risk PII tokens (emails, URLs, phone numbers, long digit runs such as
 * order/card numbers), normalize whitespace + lowercase, and cap length. The result retains
 * only coarse intent words — enough to audit "what kind of question was asked" without
 * exposing any free-text PII. We REDACT (replace with a token), never silently drop, so the
 * audit trail records that PII was present and stripped.
 *
 * @see 02-architecture.md §D4
 */

/** Replacement tokens — visible, deterministic markers (never the original value). */
const EMAIL_TOKEN = '[email]';
const URL_TOKEN = '[url]';
const PHONE_TOKEN = '[phone]';
const NUMBER_TOKEN = '[number]';

/** Max persisted length — caps unbounded free-text (defense against log/DB bloat + leakage). */
const MAX_REDACTED_LEN = 256;

// Ordered: URLs and emails BEFORE bare number/phone runs so their embedded digits don't
// get partially tokenized first. Each regex is global + deterministic.
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s]+/gi;
// Phone-like: optional +, then 7+ digits possibly separated by space/dash/parens/dot.
const PHONE_RE = /\+?\d[\d\s().-]{6,}\d/g;
// Any remaining run of 5+ digits (order ids, card fragments, pincodes-with-context).
const LONG_DIGITS_RE = /\d{5,}/g;
// Short numbers (1-4 digits) are kept as a generic token — dates/ranges carry intent but
// the literal value is not needed in the redacted audit (the binding params hold the real range).
const SHORT_DIGITS_RE = /\d{1,4}/g;

/**
 * redactQuestion — deterministic PII/free-text strip.
 *
 * @param raw - The raw natural-language question (held in memory only; never persisted).
 * @returns The redacted question safe to persist/log. Always non-empty (falls back to
 *          '[redacted]' if the input redacts to nothing) so the NOT NULL column is satisfied.
 */
export function redactQuestion(raw: string): string {
  let s = String(raw ?? '');

  // 1. High-risk structured PII first (order matters — URL/email before bare digit runs).
  s = s.replace(EMAIL_RE, EMAIL_TOKEN);
  s = s.replace(URL_RE, URL_TOKEN);
  s = s.replace(PHONE_RE, PHONE_TOKEN);
  s = s.replace(LONG_DIGITS_RE, NUMBER_TOKEN);
  s = s.replace(SHORT_DIGITS_RE, NUMBER_TOKEN);

  // 2. Normalize: lowercase, collapse whitespace, trim.
  s = s.toLowerCase().replace(/\s+/g, ' ').trim();

  // 3. Cap length (deterministic truncation at a word-safe-ish boundary).
  if (s.length > MAX_REDACTED_LEN) {
    s = s.slice(0, MAX_REDACTED_LEN).trim();
  }

  // 4. NOT NULL guarantee — never persist an empty string.
  return s.length > 0 ? s : '[redacted]';
}
