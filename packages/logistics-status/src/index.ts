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
 * Build a TRULY immutable lookup set. `Object.freeze(new Set(...))` does NOT stop `.add`/`.delete`
 * (Set mutators don't go through property assignment), so the mutate methods are overridden to throw.
 * Returned as `ReadonlySet<string>` so consumers can't even reach the mutators at compile time —
 * this is what enforces the "frozen authority, no per-source drift" invariant the whole package exists for.
 */
function frozenSet(values: readonly string[]): ReadonlySet<string> {
  const set = new Set(values);
  const blocked = (op: string) => () => {
    throw new TypeError(`@brain/logistics-status: terminal-state sets are immutable — ${op}() is forbidden`);
  };
  set.add = blocked('add') as Set<string>['add'];
  set.delete = blocked('delete') as Set<string>['delete'];
  set.clear = blocked('clear') as Set<string>['clear'];
  return Object.freeze(set);
}

/**
 * Terminal RTO end-states (union of GoKwik + Shiprocket vocabularies). A CoD order reaching
 * any of these → cod_rto_clawback. GoKwik subset: rto, rto initiated, rto in transit,
 * rto undelivered, rto out for delivery, rto delivered. Shiprocket adds: rto ofd,
 * rto acknowledged, rto rejected, rto ndr, rto disposed.
 */
export const RTO_TERMINAL_STATES: ReadonlySet<string> = frozenSet([
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
export const DELIVERED_TERMINAL_STATES: ReadonlySet<string> = frozenSet([
  'delivered',
  'completed',
]);

/** Other hard terminal end-states (no ledger effect in Slice 1 — recorded for provenance). */
export const OTHER_TERMINAL_STATES: ReadonlySet<string> = frozenSet([
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

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// SR-4 — RETURN family (the revenue-truth correctness fix).
//
// A customer/merchant RETURN is a SEPARATE lifecycle from both forward delivery and RTO. It is
// classified by a DEDICATED authority (classifyReturnStatus) — NEVER by classifyShipmentStatus —
// because the return vocabulary COLLIDES with the forward terminal vocabulary: a return whose status
// is "delivered" / "completed" means delivered-BACK-to-origin / refund-closed, NOT a sale
// confirmation. Routing a return through classifyShipmentStatus would map return.completed →
// 'delivered' = a FALSE delivery confirmation that corrupts the CoD/recognition ledger (the SR-4
// bug). The disambiguator is the TOPIC / event type (shiprocket.return_status.v1 vs
// shiprocket.shipment_status.v1), so the return mapper owns its own classifier here.
//
// This is an ADD-ONLY change: the frozen TerminalClass + classifyShipmentStatus above are untouched
// (byte-identical → GoKwik parity preserved). RETURN_* is a NEW, parallel class family.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export type ReturnClass =
  | 'return_initiated'   // return.created — return raised / approved (customer or merchant initiated)
  | 'return_in_transit'  // return.picked_up — courier has the return parcel, moving back to origin
  | 'return_delivered'   // return.delivered — physically back at origin / warehouse
  | 'return_completed'   // return.completed — refund / closure done (the TERMINAL return state)
  | 'none';              // unknown / un-mappable return status

const RETURN_INITIATED_STATES: ReadonlySet<string> = frozenSet([
  'created', 'initiated', 'requested', 'approved', 'raised', 'qc pending',
]);
const RETURN_IN_TRANSIT_STATES: ReadonlySet<string> = frozenSet([
  'picked up', 'pickup', 'pickup done', 'pickup generated', 'in transit', 'out for pickup',
]);
const RETURN_DELIVERED_STATES: ReadonlySet<string> = frozenSet([
  'delivered', 'received', 'reached',
]);
const RETURN_COMPLETED_STATES: ReadonlySet<string> = frozenSet([
  'completed', 'closed', 'refunded', 'refund processed',
]);

/**
 * Fold a return status OR a return topic to its bare canonical form. Beyond the shared
 * normalizeStatus folding (case / `_` / `-` / whitespace), this ALSO collapses dots (so the topic
 * form `return.completed` folds) and strips a leading `return ` token (so both `return.completed`
 * and a bare body status `completed` reduce to `completed`). Kept LOCAL to the return path — the
 * frozen normalizeStatus used by GoKwik is unchanged.
 */
function normalizeReturnStatus(raw: string | null | undefined): string {
  return normalizeStatus((raw ?? '').replace(/\./g, ' ')).replace(/^return\s+/, '');
}

/**
 * Classify a RETURN status/topic into its ReturnClass (deterministic — no model). NEVER returns a
 * forward TerminalClass: a return is never 'delivered'/'rto'/'other'. Used ONLY by the return mapper
 * on the return lane.
 */
export function classifyReturnStatus(rawStatus: string | null | undefined): ReturnClass {
  const s = normalizeReturnStatus(rawStatus);
  if (RETURN_COMPLETED_STATES.has(s)) return 'return_completed';
  if (RETURN_DELIVERED_STATES.has(s)) return 'return_delivered';
  if (RETURN_IN_TRANSIT_STATES.has(s)) return 'return_in_transit';
  if (RETURN_INITIATED_STATES.has(s)) return 'return_initiated';
  return 'none';
}

/** True iff the return has reached its terminal (refund/closure) state. */
export function isReturnComplete(rawStatus: string | null | undefined): boolean {
  return classifyReturnStatus(rawStatus) === 'return_completed';
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// SR-5 — forward state machine: a NON-TERMINAL EXCEPTION / NDR sub-class.
//
// `delayed` / `exception` / NDR (non-delivery-report) / bare `undelivered` previously fell through
// classifyShipmentStatus to 'none' (lumped into generic in-flight). They are HIGH-SIGNAL for RTO
// prediction, so they get a dedicated, queryable EXCEPTION class. This is a SEPARATE dimension from
// terminal_class: it is explicitly NON-TERMINAL (the shipment is still in flight), so classifyShipmentStatus
// is left byte-identical (these stay 'none' there, is_terminal stays false) and the exception signal is
// carried alongside as exception_class. GoKwik never emits these labels → GoKwik behavior is unchanged.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export type ExceptionClass = 'delayed' | 'ndr';

const EXCEPTION_STATES: ReadonlySet<string> = frozenSet([
  'delayed',
  'exception',
  'ndr',
  'undelivered',
  'address issue',
  'customer unavailable',
  'failed delivery attempt',
]);

/** The enumerated forward (in-flight, non-terminal) lifecycle states — exported for funnel queries. */
export const FORWARD_TRANSIT_STATES: ReadonlySet<string> = frozenSet([
  'created',
  'pickup scheduled',
  'pickup generated',
  'pickup',
  'picked up',
  'in transit',
  'out for delivery',
]);

/**
 * Classify a forward-lifecycle exception. 'delayed' → 'delayed'; any NDR / undelivered / delivery
 * exception → 'ndr'; everything else (forward transit, terminal) → null. NON-TERMINAL by definition —
 * does NOT alter terminal_class. A SEPARATE dimension from classifyShipmentStatus.
 */
export function classifyException(rawStatus: string | null | undefined): ExceptionClass | null {
  const s = normalizeStatus(rawStatus);
  if (s === 'delayed') return 'delayed';
  if (EXCEPTION_STATES.has(s)) return 'ndr';
  return null;
}

/** True iff the forward status is an exception / NDR (delivery delay or non-delivery report). */
export function isExceptionStatus(rawStatus: string | null | undefined): boolean {
  return classifyException(rawStatus) !== null;
}
