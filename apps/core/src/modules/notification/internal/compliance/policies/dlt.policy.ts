/**
 * DLT policy — maps a DLT template-approval result to a fail-closed gate outcome.
 *
 * TRAI DLT requires an approved template before any SMS/WhatsApp commercial send.
 * Default-closed: not approved → blocked. The real registry is a platform follow-up;
 * the shipped adapter (StubDltRegistry) returns false, so this policy blocks.
 */

export type DltOutcome =
  | { blocked: false }
  | { blocked: true; reason: 'dlt_unregistered' };

export function evaluateDlt(templateApproved: boolean): DltOutcome {
  return templateApproved
    ? { blocked: false }
    : { blocked: true, reason: 'dlt_unregistered' };
}
