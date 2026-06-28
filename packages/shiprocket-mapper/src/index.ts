/**
 * @brain/shiprocket-mapper — Frozen shared mapper for the Shiprocket shipment-tracking feed.
 *
 * FROZEN API — do not change after commit without Architect sign-off.
 *
 * Shiprocket is a logistics-category source. It is the SECOND source (after the GoKwik AWB feed)
 * to populate Brain's logistics canonical surface, so it maps to the SAME shape and uses the SAME
 * status→terminal_class authority (@brain/logistics-status) — no per-source drift. Terminal RTO →
 * the cod_rto_clawback ledger; terminal Delivered → confirms recognition. (Mirrors @brain/gokwik-mapper.)
 *
 * Binding decisions (identical to @brain/gokwik-mapper):
 *   BOUNDARY-HASH — awb is hashed at the boundary: sha256(per-brand-salt || normalized). The raw
 *                   AWB exists only in-memory here; order_id (ledger spine key) is NOT PII, passed through.
 *   STATE-MACHINE — terminal_class is computed deterministically by the shared normalizer. No model, no score.
 *   uuidV5        — uuidV5(brand:awb:status:status_changed_at) → DISTINCT per transition → a new Bronze
 *                   row per state change → terminal states RESTATED idempotently across re-pulls.
 *   DEV-HONESTY   — data_source stamped into properties ('real' | 'synthetic') for the UI badge.
 *
 * brandId is ALWAYS passed by the caller (from the connector enumeration fn — MT-1), NEVER read
 * from the Shiprocket payload.
 */

import { createHash } from 'node:crypto';
import { hashToUuidShaped } from '@brain/connector-core';
import { hashIdentifier, normalizePhone } from '@brain/identity-core';
import {
  classifyShipmentStatus,
  classifyReturnStatus,
  classifyException,
  type TerminalClass,
  type ReturnClass,
  type ExceptionClass,
} from '@brain/logistics-status';

// ── Event name constants ──────────────────────────────────────────────────────

export const SHIPROCKET_SHIPMENT_STATUS_V1_EVENT_NAME = 'shiprocket.shipment_status.v1' as const;
/** SR-4: the NEW canonical RETURN event — a SEPARATE lane from the forward shipment status. */
export const SHIPROCKET_RETURN_STATUS_V1_EVENT_NAME = 'shiprocket.return_status.v1' as const;

// ── data_source provenance (DEV-HONESTY) ──────────────────────────────────────

export type DataSource = 'real' | 'synthetic';

// ── Raw Shiprocket shape ──────────────────────────────────────────────────────
// Field names follow Shiprocket's tracking vocabulary. NOTE (SPEC 3 gap): the exact
// tracking-webhook payload keys are not in public docs and must be confirmed against a live
// payload; the repull client normalizes its source rows into THIS record shape, so any key
// drift is absorbed at the client edge, not here.

export interface ShiprocketShipmentRecord {
  awb?: string | null;               // AWB / waybill number (hashed at boundary)
  order_id?: string | null;          // channel/order reference — ledger spine key, NOT PII
  status?: string | null;            // current_status label (e.g. "RTO Initiated", "Delivered")
  status_changed_at?: string | null; // ISO — when the status changed (the cursor high-water)
  payment_method?: string | null;    // 'cod' | 'prepaid' (if provided)
  pincode?: string | null;           // destination pincode (RTO%-by-pincode)
  courier?: string | null;           // courier_name (carrier dimension)
  customer_phone?: string | null;    // SR-6 — hashed at the boundary (raw DROPPED), links to customer 360
  customer_email?: string | null;    // SR-6 — hashed at the boundary (raw DROPPED), links to customer 360
  [key: string]: unknown;
}

// ── Output Silver shape (mirrors GokwikAwbProperties + courier dimension) ──────

export interface ShiprocketShipmentProperties {
  source: 'shiprocket';
  data_source: DataSource;
  awb_number_hash: string | null;    // sha256(salt || normalized AWB) — raw DROPPED
  order_id: string;                  // ledger spine key (NOT PII)
  status: string;                    // raw status string (verbatim)
  terminal_class: TerminalClass;     // 'rto' | 'delivered' | 'other' | 'none' (shared authority)
  is_terminal: boolean;
  exception_class: ExceptionClass | null; // SR-5 — 'delayed' | 'ndr' | null (NON-terminal in-flight signal)
  payment_method: 'cod' | 'prepaid' | null;
  pincode: string | null;
  courier: string | null;            // carrier name (new vs GoKwik — courier performance)
  status_changed_at: string;         // ISO-8601
  occurred_at: string;               // ISO-8601 (= status_changed_at)
  hashed_customer_email?: string;    // SR-6 — sha256(salt || normalized email); raw DROPPED, absent when unknown
  hashed_customer_phone?: string;    // SR-6 — sha256(salt || E.164 phone); raw DROPPED, absent when unknown
}

export interface MappedShiprocketShipmentEvent {
  event_name: typeof SHIPROCKET_SHIPMENT_STATUS_V1_EVENT_NAME;
  occurred_at: string;
  properties: ShiprocketShipmentProperties;
}

// ── UUID util — shared kernel util (@brain/connector-core), IDENTICAL byte layout (I-ST04) ──

/**
 * Deterministic event_id for a Shiprocket shipment status transition.
 * Seed: sha256(`${brandId}:${awb}:${status}:${statusChangedAt}:shiprocket.shipment_status.v1`)
 *
 * DISTINCT per (awb, status, status_changed_at) → each transition lands a new Bronze row; a
 * re-pull re-reading the same transition → same id → Bronze ON CONFLICT DO NOTHING dedup.
 */
export function uuidV5FromShipment(
  brandId: string,
  awb: string,
  status: string,
  statusChangedAt: string,
): string {
  return hashToUuidShaped(
    `${brandId}:${awb}:${status}:${statusChangedAt}:shiprocket.shipment_status.v1`,
  );
}

// ── Boundary hash for the AWB number (DPDP pseudonymous shipment identifier) ──
// Same algorithm as @brain/gokwik-mapper.hashAwbNumber so a shipment carried by both feeds
// hashes identically per brand (cross-source AWB equality holds).

export function hashAwbNumber(rawAwb: string, saltHex: string): string {
  const normalized = rawAwb.trim().toLowerCase();
  return createHash('sha256')
    .update(Buffer.from(saltHex, 'hex'))
    .update(normalized, 'utf8')
    .digest('hex');
}

function resolvePaymentMethod(raw: string | null | undefined): 'cod' | 'prepaid' | null {
  const s = (raw ?? '').trim().toLowerCase();
  if (s === 'cod' || s === 'cash_on_delivery' || s === 'cash on delivery') return 'cod';
  if (s === 'prepaid' || s === 'online' || s === 'paid') return 'prepaid';
  return null;
}

// ── SR-6 — customer identity hashing at the boundary ─────────────────────────────
// Same salt regime + algorithm as @brain/gokwik-mapper (hashIdentifier/normalizePhone from
// @brain/identity-core), so a customer carried by both feeds hashes IDENTICALLY per brand
// (cross-source identity equality holds). The raw phone/email exist only in-memory here and are
// DROPPED — only the hash survives. Returns undefined when the field is absent, so it is omitted
// from the canonical envelope entirely (never an empty/placeholder hash).

const EMAIL_KEYS = ['customer_email', 'email', 'user_email'] as const;
const PHONE_KEYS = ['customer_phone', 'phone', 'mobile', 'contact', 'user_phone'] as const;

function firstField(rec: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = rec[k];
    if (v != null && String(v).trim().length > 0) return String(v).trim();
  }
  return undefined;
}

function hashCustomerEmail(rec: Record<string, unknown>, saltHex: string, regionCode: string): string | undefined {
  const email = firstField(rec, EMAIL_KEYS);
  return email ? hashIdentifier(email, 'email', saltHex, regionCode) : undefined;
}

function hashCustomerPhone(rec: Record<string, unknown>, saltHex: string, regionCode: string): string | undefined {
  const phone = firstField(rec, PHONE_KEYS);
  if (!phone) return undefined;
  const { normalized } = normalizePhone(phone, regionCode);
  return hashIdentifier(normalized, 'phone', saltHex, regionCode);
}

// ── Shipment mapper ─────────────────────────────────────────────────────────────

/**
 * Map a raw Shiprocket shipment record to a canonical Silver event.
 *
 * @param record      Raw shipment record (awb, order_id, status, status_changed_at, courier, …)
 * @param brandId     Brand UUID (from connector enumeration — MT-1, never from payload)
 * @param saltHex     Per-brand 64-char hex salt for AWB + identity hashing
 * @param dataSource  'real' shape; in dev the SOURCE is synthetic → 'synthetic' (DEV-HONESTY)
 * @param regionCode  Brand region code (E.164 phone normalization — SR-6); defaults 'IN'
 */
export function mapShiprocketShipment(
  record: ShiprocketShipmentRecord,
  brandId: string,
  saltHex: string,
  dataSource: DataSource = 'real',
  regionCode = 'IN',
): MappedShiprocketShipmentEvent {
  const orderId = String(record.order_id ?? '').trim();
  if (!orderId) {
    throw new Error('[shiprocket-mapper] shipment record missing order_id (ledger spine key)');
  }

  const rawStatus = String(record.status ?? '').trim();
  const statusChangedAt = new Date(
    record.status_changed_at ?? new Date().toISOString(),
  ).toISOString();

  const rawAwb = record.awb != null ? String(record.awb).trim() : '';
  const awbHash = rawAwb ? hashAwbNumber(rawAwb, saltHex) : null;
  // rawAwb dropped here — never leaves this scope.

  const terminalClass = classifyShipmentStatus(rawStatus);
  // SR-6: hash phone/email at the boundary; raw PII never leaves this scope.
  const hashedEmail = hashCustomerEmail(record, saltHex, regionCode);
  const hashedPhone = hashCustomerPhone(record, saltHex, regionCode);

  const properties: ShiprocketShipmentProperties = {
    source: 'shiprocket',
    data_source: dataSource,
    awb_number_hash: awbHash,
    order_id: orderId,
    status: rawStatus,
    terminal_class: terminalClass,
    is_terminal: terminalClass !== 'none',
    // SR-5: non-terminal exception/NDR signal — does NOT alter terminal_class / is_terminal.
    exception_class: classifyException(rawStatus),
    payment_method: resolvePaymentMethod(record.payment_method),
    pincode: record.pincode != null ? String(record.pincode).trim() : null,
    courier: record.courier != null ? String(record.courier).trim() || null : null,
    status_changed_at: statusChangedAt,
    occurred_at: statusChangedAt,
    ...(hashedEmail !== undefined ? { hashed_customer_email: hashedEmail } : {}),
    ...(hashedPhone !== undefined ? { hashed_customer_phone: hashedPhone } : {}),
  };

  return {
    event_name: SHIPROCKET_SHIPMENT_STATUS_V1_EVENT_NAME,
    occurred_at: statusChangedAt,
    properties,
  };
}

// ── SR-4 — Return mapper (a SEPARATE canonical lane: shiprocket.return_status.v1) ──────────────────
// A return is mapped to its OWN canonical event with its OWN classifier (classifyReturnStatus) — it
// NEVER goes through classifyShipmentStatus, so a return whose status is "delivered"/"completed" can
// never be mis-classified as a forward DELIVERED (the false-delivery / revenue-truth bug SR-4 fixes).

export interface ShiprocketReturnProperties {
  source: 'shiprocket';
  data_source: DataSource;
  awb_number_hash: string | null;    // sha256(salt || normalized AWB) — raw DROPPED
  order_id: string;                  // ledger spine key (NOT PII) — links the return to the order/shipment
  status: string;                    // raw return status string (verbatim)
  return_class: ReturnClass;         // 'return_initiated' | 'return_in_transit' | 'return_delivered' | 'return_completed' | 'none'
  is_return_complete: boolean;       // return_class === 'return_completed' (the terminal return state)
  payment_method: 'cod' | 'prepaid' | null;
  pincode: string | null;
  courier: string | null;
  status_changed_at: string;         // ISO-8601
  occurred_at: string;               // ISO-8601 (= status_changed_at)
  hashed_customer_email?: string;    // SR-6 — absent when unknown
  hashed_customer_phone?: string;    // SR-6 — absent when unknown
}

export interface MappedShiprocketReturnEvent {
  event_name: typeof SHIPROCKET_RETURN_STATUS_V1_EVENT_NAME;
  occurred_at: string;
  properties: ShiprocketReturnProperties;
}

/**
 * Deterministic event_id for a Shiprocket RETURN status transition. Seed mirrors the shipment seed
 * but is namespaced by the return event name, so a return transition and a shipment transition with
 * the same (awb, status, status_changed_at) get DISTINCT ids (no cross-lane collision):
 *   sha256(`${brandId}:${awb}:${status}:${statusChangedAt}:shiprocket.return_status.v1`)
 */
export function uuidV5FromReturn(
  brandId: string,
  awb: string,
  status: string,
  statusChangedAt: string,
): string {
  return hashToUuidShaped(
    `${brandId}:${awb}:${status}:${statusChangedAt}:shiprocket.return_status.v1`,
  );
}

/**
 * Map a raw Shiprocket return record to the canonical shiprocket.return_status.v1 event.
 * Identical boundary discipline to mapShiprocketShipment (AWB + phone/email hashed, raw dropped,
 * order_id required) — but classified by classifyReturnStatus, NEVER classifyShipmentStatus.
 */
export function mapShiprocketReturn(
  record: ShiprocketShipmentRecord,
  brandId: string,
  saltHex: string,
  dataSource: DataSource = 'real',
  regionCode = 'IN',
): MappedShiprocketReturnEvent {
  const orderId = String(record.order_id ?? '').trim();
  if (!orderId) {
    throw new Error('[shiprocket-mapper] return record missing order_id (ledger spine key)');
  }

  const rawStatus = String(record.status ?? '').trim();
  const statusChangedAt = new Date(
    record.status_changed_at ?? new Date().toISOString(),
  ).toISOString();

  const rawAwb = record.awb != null ? String(record.awb).trim() : '';
  const awbHash = rawAwb ? hashAwbNumber(rawAwb, saltHex) : null;
  // rawAwb dropped here — never leaves this scope.

  const returnClass = classifyReturnStatus(rawStatus);
  const hashedEmail = hashCustomerEmail(record, saltHex, regionCode);
  const hashedPhone = hashCustomerPhone(record, saltHex, regionCode);

  const properties: ShiprocketReturnProperties = {
    source: 'shiprocket',
    data_source: dataSource,
    awb_number_hash: awbHash,
    order_id: orderId,
    status: rawStatus,
    return_class: returnClass,
    is_return_complete: returnClass === 'return_completed',
    payment_method: resolvePaymentMethod(record.payment_method),
    pincode: record.pincode != null ? String(record.pincode).trim() : null,
    courier: record.courier != null ? String(record.courier).trim() || null : null,
    status_changed_at: statusChangedAt,
    occurred_at: statusChangedAt,
    ...(hashedEmail !== undefined ? { hashed_customer_email: hashedEmail } : {}),
    ...(hashedPhone !== undefined ? { hashed_customer_phone: hashedPhone } : {}),
  };

  return {
    event_name: SHIPROCKET_RETURN_STATUS_V1_EVENT_NAME,
    occurred_at: statusChangedAt,
    properties,
  };
}
