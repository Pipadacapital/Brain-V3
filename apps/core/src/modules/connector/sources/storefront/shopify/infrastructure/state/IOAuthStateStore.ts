/**
 * IOAuthStateStore — interface for server-side OAuth state nonce storage.
 *
 * NN-4: state nonce is server-stored, brand-bound, single-use, ≤15-min TTL.
 * MED-CALLBACK-01: brand_id is bound INTO the state record at initiation time so
 * the callback can derive it from the server-side record, never from the query string.
 *
 * In production: backed by Redis with TTL.
 * In dev: backed by an in-process Map with manual TTL check.
 */

export interface IOAuthStateStore {
  /**
   * Store a state nonce keyed by state value, with brandId embedded in the record.
   *
   * MED-CALLBACK-01: brandId is stored server-side so the callback handler can
   * retrieve it from the record rather than trusting the attacker-controlled query param.
   *
   * @param brandId     Brand UUID — stored as part of the nonce record.
   * @param state       The nonce value (hex string) — used as the lookup key.
   * @param ttlSeconds  Expiry in seconds (default: 900 / 15 min).
   */
  set(brandId: string, state: string, ttlSeconds: number): Promise<void>;

  /**
   * Consume (validate + delete) a state nonce by state value alone.
   * Returns the server-stored brandId if the nonce was present and not expired,
   * then deletes it (single-use). Returns null if not found, expired, or already consumed.
   *
   * MED-CALLBACK-01: caller must NOT supply brandId — the brandId is authoritative
   * from the server-side record, not from any client-supplied parameter.
   *
   * NN-4: single-use — the nonce MUST be deleted on first successful consume.
   */
  consumeAndGetBrandId(state: string): Promise<{ brandId: string } | null>;
}
