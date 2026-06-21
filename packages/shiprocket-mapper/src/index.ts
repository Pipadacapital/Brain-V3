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
import {
  classifyShipmentStatus,
  type TerminalClass,
} from '@brain/logistics-status';

// ── Event name constant ───────────────────────────────────────────────────────

export const SHIPROCKET_SHIPMENT_STATUS_V1_EVENT_NAME = 'shiprocket.shipment_status.v1' as const;

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
  payment_method: 'cod' | 'prepaid' | null;
  pincode: string | null;
  courier: string | null;            // carrier name (new vs GoKwik — courier performance)
  status_changed_at: string;         // ISO-8601
  occurred_at: string;               // ISO-8601 (= status_changed_at)
}

export interface MappedShiprocketShipmentEvent {
  event_name: typeof SHIPROCKET_SHIPMENT_STATUS_V1_EVENT_NAME;
  occurred_at: string;
  properties: ShiprocketShipmentProperties;
}

// ── UUID util (IDENTICAL algorithm to gokwik/shopify/razorpay mappers — I-ST04) ──

function hashToUuidShaped(input: string): string {
  const hash = createHash('sha256').update(input, 'utf8').digest();
  const bytes = Buffer.alloc(16);
  hash.copy(bytes, 0, 0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32),
  ].join('-');
}

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

// ── Shipment mapper ─────────────────────────────────────────────────────────────

/**
 * Map a raw Shiprocket shipment record to a canonical Silver event.
 *
 * @param record      Raw shipment record (awb, order_id, status, status_changed_at, courier, …)
 * @param brandId     Brand UUID (from connector enumeration — MT-1, never from payload)
 * @param saltHex     Per-brand 64-char hex salt for AWB hashing
 * @param dataSource  'real' shape; in dev the SOURCE is synthetic → 'synthetic' (DEV-HONESTY)
 */
export function mapShiprocketShipment(
  record: ShiprocketShipmentRecord,
  brandId: string,
  saltHex: string,
  dataSource: DataSource = 'real',
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

  const properties: ShiprocketShipmentProperties = {
    source: 'shiprocket',
    data_source: dataSource,
    awb_number_hash: awbHash,
    order_id: orderId,
    status: rawStatus,
    terminal_class: terminalClass,
    is_terminal: terminalClass !== 'none',
    payment_method: resolvePaymentMethod(record.payment_method),
    pincode: record.pincode != null ? String(record.pincode).trim() : null,
    courier: record.courier != null ? String(record.courier).trim() || null : null,
    status_changed_at: statusChangedAt,
    occurred_at: statusChangedAt,
  };

  return {
    event_name: SHIPROCKET_SHIPMENT_STATUS_V1_EVENT_NAME,
    occurred_at: statusChangedAt,
    properties,
  };
}
