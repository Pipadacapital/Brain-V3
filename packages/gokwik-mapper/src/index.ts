/**
 * @brain/gokwik-mapper — Frozen shared mapper for GoKwik AWB-lifecycle + RTO-Predict.
 *
 * FROZEN API — do not change after commit without Architect sign-off.
 *
 * Two seams (05-architecture.md §3 + §1b):
 *   1. AWB lifecycle (trailing-window re-pull) — a late-changing shipment status that moves
 *      through transition states → TERMINAL end-states (RTO* / Delivered / Cancelled / Lost).
 *      Terminal RTO drives the cod_rto_clawback ledger; terminal Delivered confirms recognition.
 *   2. RTO-Predict risk events — order-keyed, CATEGORICAL risk_flag (High/Medium/Low/Control).
 *      GoKwik exposes NO numeric score (research finding 1) — we record the categorical string
 *      VERBATIM and NEVER fabricate a numeric value.
 *
 * Binding decisions:
 *   BOUNDARY-HASH — awb_number is hashed at the boundary: sha256(per-brand-salt || normalized).
 *                   The raw AWB exists only in-memory here; the order_id (ledger spine key) is NOT
 *                   PII and is passed through.
 *   STATE-MACHINE — is_terminal is computed deterministically from the documented end-state list.
 *                   No model, no score — pure classification (deterministic tier).
 *   uuidV5        — AWB:  uuidV5(brand:awb:status:status_changed_at) → DISTINCT per transition →
 *                         a new Bronze row per state change → terminal states RESTATED idempotently.
 *                   RTO:  uuidV5(brand:order_id:request_id) → one event per prediction call.
 *   DEV-HONESTY   — data_source stamped into properties ('real' | 'synthetic') for the UI badge.
 *
 * brandId is ALWAYS passed by the caller (from the connector row / enumeration fn — MT-1),
 * NEVER read from the GoKwik payload.
 */

import { createHash } from 'node:crypto';
import { hashToUuidShaped } from '@brain/connector-core';
import {
  classifyShipmentStatus,
  isTerminalStatus as isTerminalStatusShared,
  type TerminalClass,
} from '@brain/logistics-status';

// ── Event name constants ─────────────────────────────────────────────────────

export const GOKWIK_AWB_STATUS_V1_EVENT_NAME = 'gokwik.awb_status.v1' as const;
export const GOKWIK_RTO_PREDICT_V1_EVENT_NAME = 'gokwik.rto_predict.v1' as const;

// ── data_source provenance (DEV-HONESTY — §4) ────────────────────────────────

export type DataSource = 'real' | 'synthetic';

// ── AWB terminal-state taxonomy ───────────────────────────────────────────────
// The status→terminal_class authority now lives in @brain/logistics-status (the SHARED
// normalizer used by every logistics source — no per-source drift). We re-export the GoKwik
// names below for back-compat; behavior is byte-identical (GoKwik labels are a subset of the
// shared union). See packages/logistics-status/src/index.ts.

export type { TerminalClass };
export {
  RTO_TERMINAL_STATES,
  DELIVERED_TERMINAL_STATES,
  OTHER_TERMINAL_STATES,
} from '@brain/logistics-status';

/** Classify an AWB status into its terminal class (deterministic — shared authority). */
export function classifyAwbStatus(rawStatus: string | null | undefined): TerminalClass {
  return classifyShipmentStatus(rawStatus);
}

export function isTerminalStatus(rawStatus: string | null | undefined): boolean {
  return isTerminalStatusShared(rawStatus);
}

// ── Raw GoKwik shapes ─────────────────────────────────────────────────────────

export interface GokwikAwbRecord {
  awb_number?: string | null;
  order_id?: string | null;          // ledger spine key — NOT PII, passed through
  status?: string | null;
  status_changed_at?: string | null; // ISO — when the status changed (the cursor high-water)
  payment_method?: string | null;    // 'cod' | 'prepaid' (if provided)
  pincode?: string | null;           // destination pincode (for RTO%-by-pincode — research finding 4)
  [key: string]: unknown;
}

export interface GokwikRtoPredictRecord {
  order_id?: string | null;          // order this prediction is for (the spine key)
  request_id?: string | null;        // GoKwik request_id
  risk_flag?: string | null;         // CATEGORICAL: High / Medium / Low Risk / Control — VERBATIM
  risk_reason?: string | null;       // free-text reason
  occurred_at?: string | null;
  [key: string]: unknown;
}

// ── Output Silver shapes ──────────────────────────────────────────────────────

export interface GokwikAwbProperties {
  source: 'gokwik';
  data_source: DataSource;
  awb_number_hash: string | null;    // sha256(salt || normalized AWB) — raw DROPPED
  order_id: string;                  // ledger spine key (NOT PII)
  status: string;                    // raw status string (verbatim, normalized casing preserved)
  terminal_class: TerminalClass;     // 'rto' | 'delivered' | 'other' | 'none'
  is_terminal: boolean;
  payment_method: 'cod' | 'prepaid' | null;
  pincode: string | null;
  status_changed_at: string;         // ISO-8601
  occurred_at: string;               // ISO-8601 (= status_changed_at)
}

export interface MappedGokwikAwbEvent {
  event_name: typeof GOKWIK_AWB_STATUS_V1_EVENT_NAME;
  occurred_at: string;
  properties: GokwikAwbProperties;
}

/** Categorical risk flag — normalized to a closed set; the original string is preserved verbatim. */
export type RiskFlag = 'high' | 'medium' | 'low' | 'control' | 'unknown';

export interface GokwikRtoPredictProperties {
  source: 'gokwik';
  data_source: DataSource;
  order_id: string;                  // spine key
  request_id: string | null;
  risk_flag: RiskFlag;               // categorical, closed set
  risk_flag_raw: string | null;      // the verbatim GoKwik string (never a fabricated number)
  risk_reason: string | null;
  occurred_at: string;
}

export interface MappedGokwikRtoPredictEvent {
  event_name: typeof GOKWIK_RTO_PREDICT_V1_EVENT_NAME;
  occurred_at: string;
  properties: GokwikRtoPredictProperties;
}

// ── UUID util — shared kernel util (@brain/connector-core), IDENTICAL byte layout (I-ST04) ──

/**
 * Deterministic event_id for an AWB status transition.
 * Seed: sha256(`${brandId}:${awbNumber}:${status}:${statusChangedAt}:gokwik.awb_status.v1`)
 *
 * DISTINCT per (awb, status, status_changed_at) → each transition lands a new Bronze row.
 * A re-pull that re-reads the same transition → same id → Bronze ON CONFLICT DO NOTHING dedup.
 * This is the restatement-safe key: terminal RTO/Delivered states are re-emitted idempotently.
 */
export function uuidV5FromAwb(
  brandId: string,
  awbNumber: string,
  status: string,
  statusChangedAt: string,
): string {
  return hashToUuidShaped(
    `${brandId}:${awbNumber}:${status}:${statusChangedAt}:gokwik.awb_status.v1`,
  );
}

/**
 * Deterministic event_id for an RTO-Predict risk event.
 * Seed: sha256(`${brandId}:${orderId}:${requestId}:gokwik.rto_predict.v1`)
 * One event per prediction call (request_id distinguishes re-predictions for the same order).
 */
export function uuidV5FromRtoPredict(
  brandId: string,
  orderId: string,
  requestId: string,
): string {
  return hashToUuidShaped(`${brandId}:${orderId}:${requestId}:gokwik.rto_predict.v1`);
}

// ── Boundary hash for the AWB number (DPDP pseudonymous shipment identifier) ──

/**
 * Hash an AWB number at the boundary: sha256(per-brand-salt-hex || normalized AWB).
 * The raw AWB is consumed here and DROPPED — only the hash survives.
 */
export function hashAwbNumber(rawAwb: string, saltHex: string): string {
  const normalized = rawAwb.trim().toLowerCase();
  return createHash('sha256')
    .update(Buffer.from(saltHex, 'hex'))
    .update(normalized, 'utf8')
    .digest('hex');
}

// ── Payment-method + risk-flag normalizers ────────────────────────────────────

function resolvePaymentMethod(raw: string | null | undefined): 'cod' | 'prepaid' | null {
  const s = (raw ?? '').trim().toLowerCase();
  if (s === 'cod' || s === 'cash_on_delivery' || s === 'cash on delivery') return 'cod';
  if (s === 'prepaid' || s === 'online' || s === 'paid') return 'prepaid';
  return null;
}

/** Normalize the categorical risk_flag to a closed set. The verbatim string is preserved separately. */
export function normalizeRiskFlag(raw: string | null | undefined): RiskFlag {
  const s = (raw ?? '').trim().toLowerCase();
  if (s.includes('high')) return 'high';
  if (s.includes('medium') || s.includes('med')) return 'medium';
  if (s.includes('low')) return 'low';
  if (s.includes('control')) return 'control';
  return 'unknown';
}

// ── AWB mapper ─────────────────────────────────────────────────────────────────

/**
 * Map a raw GoKwik AWB record to a canonical Silver event.
 *
 * @param record      Raw AWB record (awb_number, order_id, status, status_changed_at, ...)
 * @param brandId     Brand UUID (from connector enumeration — MT-1, never from payload)
 * @param saltHex     Per-brand 64-char hex salt for AWB hashing
 * @param dataSource  'real' shape; in dev the SOURCE is synthetic → 'synthetic' (DEV-HONESTY §4)
 */
export function mapGokwikAwb(
  record: GokwikAwbRecord,
  brandId: string,
  saltHex: string,
  dataSource: DataSource = 'real',
): MappedGokwikAwbEvent {
  const orderId = String(record.order_id ?? '').trim();
  if (!orderId) {
    throw new Error('[gokwik-mapper] AWB record missing order_id (ledger spine key)');
  }

  const rawStatus = String(record.status ?? '').trim();
  const statusChangedAt = new Date(
    record.status_changed_at ?? new Date().toISOString(),
  ).toISOString();

  const rawAwb = record.awb_number != null ? String(record.awb_number).trim() : '';
  const awbHash = rawAwb ? hashAwbNumber(rawAwb, saltHex) : null;
  // rawAwb dropped here — never leaves this scope.

  const terminalClass = classifyAwbStatus(rawStatus);

  const properties: GokwikAwbProperties = {
    source: 'gokwik',
    data_source: dataSource,
    awb_number_hash: awbHash,
    order_id: orderId,
    status: rawStatus,
    terminal_class: terminalClass,
    is_terminal: terminalClass !== 'none',
    payment_method: resolvePaymentMethod(record.payment_method),
    pincode: record.pincode != null ? String(record.pincode).trim() : null,
    status_changed_at: statusChangedAt,
    occurred_at: statusChangedAt,
  };

  return {
    event_name: GOKWIK_AWB_STATUS_V1_EVENT_NAME,
    occurred_at: statusChangedAt,
    properties,
  };
}

// ── RTO-Predict mapper ─────────────────────────────────────────────────────────

/**
 * Map a raw GoKwik RTO-Predict record to a canonical Silver event.
 * The risk_flag is CATEGORICAL — recorded verbatim in risk_flag_raw + normalized into a closed set.
 * NEVER fabricate a numeric score (GoKwik does not expose one — research finding 1).
 */
export function mapGokwikRtoPredict(
  record: GokwikRtoPredictRecord,
  brandId: string,
  dataSource: DataSource = 'real',
): MappedGokwikRtoPredictEvent {
  const orderId = String(record.order_id ?? '').trim();
  if (!orderId) {
    throw new Error('[gokwik-mapper] RTO-Predict record missing order_id');
  }

  const occurredAt = new Date(record.occurred_at ?? new Date().toISOString()).toISOString();
  const riskFlagRaw = record.risk_flag != null ? String(record.risk_flag).trim() : null;

  const properties: GokwikRtoPredictProperties = {
    source: 'gokwik',
    data_source: dataSource,
    order_id: orderId,
    request_id: record.request_id != null ? String(record.request_id).trim() : null,
    risk_flag: normalizeRiskFlag(riskFlagRaw),
    risk_flag_raw: riskFlagRaw,
    risk_reason: record.risk_reason != null ? String(record.risk_reason) : null,
    occurred_at: occurredAt,
  };

  return {
    event_name: GOKWIK_RTO_PREDICT_V1_EVENT_NAME,
    occurred_at: occurredAt,
    properties,
  };
}
