/**
 * @brain/logistics-status — the SHARED, deterministic logistics status→terminal_class
 * normalizer used by EVERY logistics source (GoKwik AWB feed + Shiprocket tracking, …).
 *
 * WHY THIS EXISTS (SPEC 3 consolidation requirement):
 *   Brain ingests shipment lifecycle from more than one source. Each vendor uses its own
 *   status vocabulary (GoKwik: "RTO Delivered"; Shiprocket: "RTO-OFD", "Disposed Of", …), but
 *   the REVENUE meaning must be ONE deterministic mapping — otherwise GoKwik and Shiprocket
 *   could classify the same physical outcome differently and the CoD/RTO ledger would drift.
 *   So status→terminal_class lives HERE, once, and both mappers import it. No per-source drift.
 *
 * TERMINAL CLASS — the canonical revenue-bearing outcome of a shipment:
 *   'rto'       → the order is returning to origin → recognized CoD revenue is clawed back.
 *   'delivered' → the order was delivered → confirms recognition.
 *   'other'     → a hard terminal end-state with no Slice-1 ledger effect (lost/damaged/…).
 *   'none'      → an in-flight / transition state (forward OFD, in-transit, NDR reattempt, …).
 *
 * DETERMINISTIC — pure classification over a frozen label set (no model, no score). Matched
 * case-insensitively after normalization (`_`/`-`/whitespace folded). This is Tier-0.
 *
 * EXTRACTED FROM @brain/gokwik-mapper (which now re-exports these) — the GoKwik label set is a
 * subset of the union below, so GoKwik behavior is byte-identical (its unit tests are the guard).
 */

export type TerminalClass = 'rto' | 'delivered' | 'other' | 'none';

/** Fold a raw vendor status string to a canonical lowercase, single-spaced form. */
export function normalizeStatus(raw: string | null | undefined): string {
  return (raw ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

/**
 * Terminal RTO end-states (union of GoKwik + Shiprocket vocabularies). A CoD order reaching
 * any of these → cod_rto_clawback. GoKwik subset: rto, rto initiated, rto in transit,
 * rto undelivered, rto out for delivery, rto delivered. Shiprocket adds: rto ofd,
 * rto acknowledged, rto rejected, rto ndr, rto disposed.
 */
export const RTO_TERMINAL_STATES = new Set([
  // GoKwik (frozen — must remain for byte-identical GoKwik behavior)
  'rto',
  'rto initiated',
  'rto in transit',
  'rto undelivered',
  'rto out for delivery',
  'rto delivered',
  // Shiprocket additions
  'rto ofd',
  'rto acknowledged',
  'rto rejected',
  'rto ndr',
  'rto disposed',
]);

/** Terminal Delivered end-states → confirms recognition (cod_delivery_confirmed). */
export const DELIVERED_TERMINAL_STATES = new Set([
  'delivered',
  'completed',
]);

/** Other hard terminal end-states (no ledger effect in Slice 1 — recorded for provenance). */
export const OTHER_TERMINAL_STATES = new Set([
  // GoKwik (frozen)
  'cancelled',
  'lost',
  'damaged',
  'returned',
  // Shiprocket additions
  'canceled',
  'destroyed',
  'disposed',
  'disposed of',
]);

/**
 * Classify a shipment status into its terminal class (deterministic — no model).
 * The single authority shared by all logistics sources.
 */
export function classifyShipmentStatus(rawStatus: string | null | undefined): TerminalClass {
  const s = normalizeStatus(rawStatus);
  if (RTO_TERMINAL_STATES.has(s)) return 'rto';
  if (DELIVERED_TERMINAL_STATES.has(s)) return 'delivered';
  if (OTHER_TERMINAL_STATES.has(s)) return 'other';
  return 'none';
}

/** True iff the status is a terminal end-state (any class other than 'none'). */
export function isTerminalStatus(rawStatus: string | null | undefined): boolean {
  return classifyShipmentStatus(rawStatus) !== 'none';
}
