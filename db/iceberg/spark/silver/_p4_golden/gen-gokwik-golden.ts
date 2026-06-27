/**
 * gen-gokwik-golden.ts — ADR-0006 P4 golden-vector generator for the GoKwik normalizer.
 *
 * Runs the REAL TypeScript @brain/gokwik-mapper (mapGokwikAwb / mapGokwikRtoPredict + the two
 * uuidV5From* seeds, exactly as the connector calls them) on representative raw GoKwik records with a
 * FIXED salt + brand, and dumps {raw, record_type, brand_id, salt_hex, data_source, expected:{...}} JSON.
 * test_gokwik-golden.py then asserts the PySpark-side reference ports reproduce `expected` byte-for-byte.
 *
 * event_id seeds mirror the connector call-sites EXACTLY:
 *   AWB (gokwik-awb-repull/run.ts): rawAwb = record.awb_number ? String(record.awb_number) : '';
 *                                   rawStatus = record.status ? String(record.status) : '';
 *                                   statusChangedAt = mapped.properties.status_changed_at;  // ISO-normalized
 *                                   event_id = uuidV5FromAwb(brand, rawAwb, rawStatus, statusChangedAt)
 *   RTO (CaptureRtoPredictCommand): event_id = uuidV5FromRtoPredict(brand, orderId, requestId)
 *
 * Run:  pnpm -C packages/gokwik-mapper build && npx tsx db/iceberg/spark/silver/_p4_golden/gen-gokwik-golden.ts \
 *         > db/iceberg/spark/silver/_p4_golden/gokwik-golden.json
 */
import {
  mapGokwikAwb,
  uuidV5FromAwb,
  mapGokwikRtoPredict,
  uuidV5FromRtoPredict,
  type GokwikAwbRecord,
  type GokwikRtoPredictRecord,
  type DataSource,
} from '@brain/gokwik-mapper';

const SALT = 'a'.repeat(64); // a fixed 64-hex salt for reproducible vectors
const BRAND = '444a25f2-57d4-4e04-9f70-98a6480e1fc4';

// ── AWB-lifecycle records (terminal RTO, terminal Delivered, in-flight transition) ──
const awbRecords: { record: GokwikAwbRecord; data_source: DataSource }[] = [
  {
    data_source: 'real',
    record: {
      awb_number: 'AWB-12345', order_id: 'ord_1', status: 'RTO Initiated',
      status_changed_at: '2026-05-05T16:00:00Z', payment_method: 'cod', pincode: '110001',
    },
  },
  {
    data_source: 'synthetic',
    record: {
      awb_number: 'AWB-99', order_id: 'ord_2', status: 'Delivered',
      status_changed_at: '2026-05-06T09:30:45Z', payment_method: 'prepaid', pincode: '560034',
    },
  },
  {
    // in-flight transition (terminal_class='none') + missing awb (awb_number_hash → null)
    data_source: 'real',
    record: {
      awb_number: null, order_id: 'ord_3', status: 'In Transit',
      status_changed_at: '2026-05-07T11:00:00Z', payment_method: null, pincode: null,
    },
  },
];

// ── RTO-Predict records (categorical risk_flag — NEVER a fabricated number) ──
const rtoRecords: { record: GokwikRtoPredictRecord; data_source: DataSource }[] = [
  {
    data_source: 'real',
    record: {
      order_id: 'ord_1', request_id: 'req_1', risk_flag: 'High Risk',
      risk_reason: 'high-RTO pincode', occurred_at: '2026-05-01T08:58:00Z',
    },
  },
  {
    data_source: 'synthetic',
    record: {
      order_id: 'ord_2', request_id: 'req_2', risk_flag: 'Low',
      risk_reason: null, occurred_at: '2026-05-02T10:15:30Z',
    },
  },
];

const awbVectors = awbRecords.map(({ record, data_source }) => {
  const mapped = mapGokwikAwb(record, BRAND, SALT, data_source);
  const rawAwb = record.awb_number ? String(record.awb_number) : '';
  const rawStatus = record.status ? String(record.status) : '';
  const statusChangedAt = mapped.properties.status_changed_at;
  const event_id = uuidV5FromAwb(BRAND, rawAwb, rawStatus, statusChangedAt);
  const p = mapped.properties;
  return {
    record_type: 'awb' as const,
    record,
    brand_id: BRAND,
    salt_hex: SALT,
    data_source,
    expected: {
      event_id,
      event_type: mapped.event_name,
      occurred_at: mapped.occurred_at,
      source: p.source,
      data_source: p.data_source,
      awb_number_hash: p.awb_number_hash,
      order_id: p.order_id,
      status: p.status,
      terminal_class: p.terminal_class,
      is_terminal: p.is_terminal,
      payment_method: p.payment_method,
      pincode: p.pincode,
      status_changed_at: p.status_changed_at,
    },
  };
});

const rtoVectors = rtoRecords.map(({ record, data_source }) => {
  const mapped = mapGokwikRtoPredict(record, BRAND, data_source);
  const event_id = uuidV5FromRtoPredict(
    BRAND,
    String(record.order_id ?? ''),
    String(record.request_id ?? ''),
  );
  const p = mapped.properties;
  return {
    record_type: 'rto_predict' as const,
    record,
    brand_id: BRAND,
    salt_hex: SALT,
    data_source,
    expected: {
      event_id,
      event_type: mapped.event_name,
      occurred_at: mapped.occurred_at,
      source: p.source,
      data_source: p.data_source,
      order_id: p.order_id,
      request_id: p.request_id,
      risk_flag: p.risk_flag,
      risk_flag_raw: p.risk_flag_raw,
      risk_reason: p.risk_reason,
    },
  };
});

console.log(JSON.stringify([...awbVectors, ...rtoVectors], null, 2));
