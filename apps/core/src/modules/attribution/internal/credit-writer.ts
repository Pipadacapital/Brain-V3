/**
 * credit-writer.ts — re-export shim.
 *
 * The attribution credit-ledger writer (AttributionCreditWriter + createAttributionReversalHook)
 * moved to the shared package @brain/attribution-writer (D1) so BOTH the hourly reconcile job
 * (this app) AND the live ledger consumer (apps/stream-worker) call the SAME writer — closing the
 * dual-writer debt rather than re-implementing the I/O in two places. This shim preserves every
 * existing in-app import path (`./credit-writer.js`).
 */
export * from '@brain/attribution-writer';
