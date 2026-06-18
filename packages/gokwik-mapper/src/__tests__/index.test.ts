/**
 * @brain/gokwik-mapper — unit tests.
 *
 * UT-1: classifyAwbStatus / isTerminalStatus — terminal RTO/Delivered/Other vs transition (state machine)
 * UT-2: mapGokwikAwb — awb_number hashed at boundary; raw NEVER in output; order_id passthrough
 * UT-3: uuidV5FromAwb — DISTINCT per (awb,status,status_changed_at) → restatement-safe; replay-stable
 * UT-4: mapGokwikRtoPredict — categorical risk_flag VERBATIM; NEVER a fabricated number
 * UT-5: normalizeRiskFlag — High/Medium/Low/Control closed set
 * UT-6: data_source stamped (DEV-HONESTY)
 */

import { describe, it, expect } from 'vitest';
import {
  classifyAwbStatus,
  isTerminalStatus,
  mapGokwikAwb,
  uuidV5FromAwb,
  mapGokwikRtoPredict,
  uuidV5FromRtoPredict,
  normalizeRiskFlag,
  hashAwbNumber,
  GOKWIK_AWB_STATUS_V1_EVENT_NAME,
  GOKWIK_RTO_PREDICT_V1_EVENT_NAME,
  type GokwikAwbRecord,
  type GokwikRtoPredictRecord,
} from '../index.js';

const BRAND_A = 'c07ec701-0a00-4a00-8a00-000000000001';
const BRAND_B = 'c07ec702-0b00-4b00-8b00-000000000002';
const SALT_A = 'a'.repeat(64);
const SALT_B = 'b'.repeat(64);

describe('UT-1: AWB state-machine classification (deterministic, no model)', () => {
  it('classifies RTO terminal states', () => {
    expect(classifyAwbStatus('RTO Initiated')).toBe('rto');
    expect(classifyAwbStatus('rto_delivered')).toBe('rto');
    expect(classifyAwbStatus('RTO')).toBe('rto');
  });
  it('classifies Delivered terminal states', () => {
    expect(classifyAwbStatus('Delivered')).toBe('delivered');
    expect(classifyAwbStatus('completed')).toBe('delivered');
  });
  it('classifies other terminal states + transition states', () => {
    expect(classifyAwbStatus('Cancelled')).toBe('other');
    expect(classifyAwbStatus('in transit')).toBe('none');
    expect(classifyAwbStatus('out for delivery')).toBe('none');
    expect(isTerminalStatus('in transit')).toBe(false);
    expect(isTerminalStatus('rto delivered')).toBe(true);
  });
});

describe('UT-2: mapGokwikAwb — boundary hash + order_id passthrough', () => {
  const record: GokwikAwbRecord = {
    awb_number: 'AWB-12345', order_id: 'ord_1', status: 'RTO Initiated',
    status_changed_at: '2026-05-05T16:00:00Z', payment_method: 'cod', pincode: '110001',
  };
  it('hashes awb; raw AWB never in output; order_id passthrough', () => {
    const ev = mapGokwikAwb(record, BRAND_A, SALT_A);
    const json = JSON.stringify(ev);
    expect(json).not.toContain('AWB-12345');
    expect(ev.properties.awb_number_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(ev.properties.order_id).toBe('ord_1');
    expect(ev.properties.terminal_class).toBe('rto');
    expect(ev.properties.is_terminal).toBe(true);
    expect(ev.properties.payment_method).toBe('cod');
    expect(ev.event_name).toBe(GOKWIK_AWB_STATUS_V1_EVENT_NAME);
  });
  it('per-brand distinct awb hashes', () => {
    expect(hashAwbNumber('AWB-12345', SALT_A)).not.toBe(hashAwbNumber('AWB-12345', SALT_B));
  });
});

describe('UT-3: uuidV5FromAwb — restatement-safe key', () => {
  it('distinct per transition; replay-stable for same transition', () => {
    const a = uuidV5FromAwb(BRAND_A, 'AWB-1', 'in transit', '2026-05-02T11:00:00Z');
    const b = uuidV5FromAwb(BRAND_A, 'AWB-1', 'rto delivered', '2026-05-09T12:00:00Z');
    const aAgain = uuidV5FromAwb(BRAND_A, 'AWB-1', 'in transit', '2026-05-02T11:00:00Z');
    expect(a).not.toBe(b);          // distinct transitions → distinct Bronze rows
    expect(a).toBe(aAgain);         // replay → same id → dedup
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('UT-4/UT-5: RTO-Predict categorical (never a fabricated number)', () => {
  const record: GokwikRtoPredictRecord = {
    order_id: 'ord_1', request_id: 'req_1', risk_flag: 'High Risk',
    risk_reason: 'high-RTO pincode', occurred_at: '2026-05-01T08:58:00Z',
  };
  it('records risk_flag VERBATIM + normalized closed set; no numeric score field', () => {
    const ev = mapGokwikRtoPredict(record, BRAND_A);
    expect(ev.properties.risk_flag_raw).toBe('High Risk');
    expect(ev.properties.risk_flag).toBe('high');
    expect(ev.event_name).toBe(GOKWIK_RTO_PREDICT_V1_EVENT_NAME);
    // No numeric score anywhere in the output (GoKwik is categorical).
    expect(JSON.stringify(ev)).not.toMatch(/"(score|probability|risk_score)"\s*:/);
  });
  it('normalizeRiskFlag closed set', () => {
    expect(normalizeRiskFlag('High Risk')).toBe('high');
    expect(normalizeRiskFlag('Medium')).toBe('medium');
    expect(normalizeRiskFlag('Low Risk')).toBe('low');
    expect(normalizeRiskFlag('Control')).toBe('control');
    expect(normalizeRiskFlag('weird')).toBe('unknown');
  });
  it('uuidV5FromRtoPredict deterministic', () => {
    expect(uuidV5FromRtoPredict(BRAND_A, 'ord_1', 'req_1')).toBe(uuidV5FromRtoPredict(BRAND_A, 'ord_1', 'req_1'));
    expect(uuidV5FromRtoPredict(BRAND_B, 'ord_1', 'req_1')).not.toBe(uuidV5FromRtoPredict(BRAND_A, 'ord_1', 'req_1'));
  });
});

describe('UT-6: data_source stamped (DEV-HONESTY)', () => {
  it('awb + rto-predict carry data_source', () => {
    const awb = mapGokwikAwb(
      { awb_number: 'A', order_id: 'o', status: 'delivered', status_changed_at: '2026-05-03T14:00:00Z' },
      BRAND_A, SALT_A, 'synthetic',
    );
    expect(awb.properties.data_source).toBe('synthetic');
    const rto = mapGokwikRtoPredict({ order_id: 'o', request_id: 'r', risk_flag: 'Low' }, BRAND_A, 'synthetic');
    expect(rto.properties.data_source).toBe('synthetic');
  });
});
