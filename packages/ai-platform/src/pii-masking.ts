// SPEC: F.2
/**
 * pii-masking.ts — the redacted-PII prompt-store MASKING HOOK (port + NotImplemented stub).
 *
 * §F: logging to ops_llm_calls stores "prompt hashes + redacted-PII store; masking hook stub".
 * §1.3: raw PII never leaves its boundary unhashed/unredacted.
 *
 * SCAFFOLD-ONLY (PLAN-OF-RECORD §PART 6): this is a PORT (the interface the future logger depends
 * on) plus a failing-by-design adapter behind the `ai.gateway.call_logging` flag (default OFF).
 * There is NO real redaction model here — a masking model/library is DEFERRED. The scaffold exists
 * so that ops_llm_calls can NEVER be wired to store a raw prompt: the only way to obtain a storable
 * prompt is through this hook, which today refuses.
 *
 * HARD RULE: `prompt_hash` (SHA-256) is the ONLY prompt provenance stored inline in ops_llm_calls.
 * A human-readable prompt is stored SEPARATELY and ONLY after passing this hook.
 */

/** The result of masking a prompt for the redacted store — an opaque ref, never the raw prompt. */
export interface MaskedPrompt {
  /** The redacted, PII-safe prompt text (safe to persist in the separate redacted store). */
  readonly redactedText: string;
  /** Opaque pointer written to ops_llm_calls.redacted_prompt_ref. Never an inline raw prompt. */
  readonly redactedPromptRef: string;
  /** SHA-256 hex of the NORMALIZED raw prompt — the inline provenance in ops_llm_calls.prompt_hash. */
  readonly promptHash: string;
}

/**
 * PiiMaskingHook — the PORT the ops_llm_calls logger depends on. A real adapter (Wave F logic)
 * detects + redacts PII (email/phone/name/address/…) before returning a storable prompt. brand_id
 * is threaded so a per-brand redaction policy / crypto-shred envelope can be applied.
 */
export interface PiiMaskingHook {
  /**
   * maskPromptForStore — redact PII from a raw prompt and produce the storable, referenced result.
   * @throws MaskingNotImplementedError in the scaffold (no redaction model is wired).
   */
  maskPromptForStore(brandId: string, rawPrompt: string): Promise<MaskedPrompt>;
}

/** Thrown by the scaffold masking hook — a raw prompt can NEVER be stored until Wave F ships. */
export class MaskingNotImplementedError extends Error {
  readonly code = 'PII_MASKING_NOT_IMPLEMENTED';
  constructor() {
    super(
      'PII masking hook is a scaffold stub (SPEC:F.2): no redaction model is wired. A raw prompt ' +
        'cannot be stored. Only prompt_hash (SHA-256) is recorded until Wave F logic ships.',
    );
    this.name = 'MaskingNotImplementedError';
  }
}

/**
 * NotImplementedPiiMaskingHook — the failing-by-design adapter. Fails CLOSED: rather than risk
 * persisting un-redacted PII, it refuses. This is the ONLY masking hook the scaffold ships, so
 * the redacted-PII store is structurally empty until a real hook replaces this behind the flag.
 */
export class NotImplementedPiiMaskingHook implements PiiMaskingHook {
  async maskPromptForStore(_brandId: string, _rawPrompt: string): Promise<MaskedPrompt> {
    throw new MaskingNotImplementedError();
  }
}
