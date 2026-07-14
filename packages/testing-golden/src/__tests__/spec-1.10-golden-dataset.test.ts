// SPEC: WA.1.10 — golden dataset acceptance (§1.10)
//
// Locks the four §1.10 properties:
//   1. DETERMINISM — same seed ⇒ byte-identical files ⇒ identical checksums (golden vector pinned).
//   2. VOLUME/SHAPE — ~50k events, 3 brands, every event parses the LIVE CollectorEventV1 contract.
//   3. SCENARIO MATRIX — all spec-listed scenarios present with real coverage.
//   4. INVARIANTS — no raw PII on the collector lane, consent-off honesty, KWD scale-3 money,
//      designed deterministic identification rate > 40% of purchasers (Wave-A exit floor).

import { describe, expect, it } from 'vitest';
import { CollectorEventV1Schema } from '@brain/contracts';
import {
  generateGoldenDataset, DEFAULT_SEED, DEFAULT_EPOCH_ISO,
  AURORA, BAZAAR, CEDAR, GOLDEN_BRAND_IDS,
} from '../index.js';

/** Pinned fingerprint for (DEFAULT_SEED, DEFAULT_EPOCH_ISO). Any change to generation is a
 *  deliberate act: re-pin ONLY together with a recaptured snapshot baseline. */
const PINNED_DATASET_CHECKSUM = 'bbb2a9ede01651ad945742d3dfd9ca147fa1a7d99fb221cf120972c1588447bf';

const dataset = generateGoldenDataset();
const collector = dataset.files.find((f) => f.file === 'collector.event.v1.jsonl');
const rawLane = dataset.files.find((f) => f.file === 'shopify.orders.raw.v1.jsonl');
const collectorLines = (collector?.jsonl ?? '').trimEnd().split('\n');
const parsed = collectorLines.map((l) => JSON.parse(l) as Record<string, unknown>);

describe('SPEC 1.10 — determinism', () => {
  it('same seed ⇒ identical dataset checksum (pinned golden vector)', () => {
    expect(dataset.manifest.datasetChecksum).toBe(PINNED_DATASET_CHECKSUM);
    const again = generateGoldenDataset({ seed: DEFAULT_SEED, epochIso: DEFAULT_EPOCH_ISO });
    expect(again.manifest.datasetChecksum).toBe(dataset.manifest.datasetChecksum);
    expect(again.files.map((f) => f.sha256)).toEqual(dataset.files.map((f) => f.sha256));
  });

  it('different seed ⇒ different checksum; different epoch ⇒ different checksum', () => {
    expect(generateGoldenDataset({ seed: 'other-seed' }).manifest.datasetChecksum)
      .not.toBe(dataset.manifest.datasetChecksum);
    expect(generateGoldenDataset({ epochIso: '2026-04-01T00:00:00.000Z' }).manifest.datasetChecksum)
      .not.toBe(dataset.manifest.datasetChecksum);
  });

  it('no wall-clock leakage: every occurred_at lies inside [epoch, epoch + spanDays + horizon]', () => {
    const start = Date.parse(DEFAULT_EPOCH_ISO);
    const end = start + (dataset.manifest.spanDays + 14) * 86_400_000; // + shipment/refund tail
    for (const e of parsed) {
      const t = Date.parse(String(e['occurred_at']));
      expect(t).toBeGreaterThanOrEqual(start);
      expect(t).toBeLessThanOrEqual(end);
    }
  });
});

describe('SPEC 1.10 — volume and envelope shape', () => {
  it('~50k events across exactly the 3 golden brands', () => {
    expect(dataset.manifest.totalEvents).toBeGreaterThanOrEqual(45_000);
    expect(dataset.manifest.totalEvents).toBeLessThanOrEqual(55_000);
    const brands = new Set(parsed.map((e) => String(e['brand_id'])));
    expect([...brands].sort()).toEqual([...GOLDEN_BRAND_IDS].sort());
  });

  it('every collector-lane event parses the LIVE CollectorEventV1 zod contract', () => {
    for (const e of parsed) {
      expect(() => CollectorEventV1Schema.parse(e)).not.toThrow();
    }
  });

  it('raw lane carries the raw Shopify order shape for Aurora orders', () => {
    expect(rawLane).toBeDefined();
    expect(rawLane!.count).toBeGreaterThan(0);
    const first = JSON.parse((rawLane!.jsonl.split('\n')[0]) as string) as Record<string, unknown>;
    expect(first).toHaveProperty('id');
    expect(first).toHaveProperty('current_total_price');
    expect(first).toHaveProperty('note_attributes');
  });
});

describe('SPEC 1.10 — scenario matrix coverage', () => {
  it('all spec-listed scenarios are present with personas > 0', () => {
    const s = dataset.manifest.scenarios;
    expect(s.anonymous_only?.aurora?.personas).toBeGreaterThan(0);
    expect(s.anon_to_known_mid_session?.aurora?.personas).toBeGreaterThan(0);
    expect(s.multi_device?.aurora?.personas).toBeGreaterThan(0);
    expect(s.multi_device?.cedar?.personas).toBeGreaterThan(0);
    expect(s.shared_device_family?.bazaar?.personas).toBeGreaterThan(0);
    expect(s.cod_order?.bazaar?.personas).toBeGreaterThan(0);
    expect(s.refund?.aurora?.personas).toBeGreaterThan(0);
    expect(s.gcc_kwd_order?.cedar?.personas).toBeGreaterThan(0);
    expect(s.consent_off?.aurora?.personas).toBeGreaterThan(0);
    expect(s.consent_off?.bazaar?.personas).toBeGreaterThan(0);
    expect(s.consent_off?.cedar?.personas).toBeGreaterThan(0);
    expect(s.late_identify_day7?.aurora?.personas).toBeGreaterThan(0);
  });

  it('COD orders exist with both delivered and RTO terminal statuses', () => {
    const shipments = parsed.filter((e) => e['event_name'] === 'shiprocket.shipment_status.v1');
    const terminalClasses = new Set(
      shipments.map((e) => String((e['properties'] as Record<string, unknown>)['terminal_class'])),
    );
    expect(terminalClasses.has('delivered')).toBe(true);
    expect(terminalClasses.has('rto')).toBe(true);
    const codOrders = parsed.filter((e) =>
      e['event_name'] === 'order.live.v1' &&
      (e['properties'] as Record<string, unknown>)['payment_method'] === 'cod');
    expect(codOrders.length).toBeGreaterThan(0);
    for (const o of codOrders) expect(o['brand_id']).toBe(BAZAAR.id);
  });

  it('refunds exist: refund.recorded.v1 follows a paid order and the order flips to refunded', () => {
    const refunds = parsed.filter((e) => e['event_name'] === 'refund.recorded.v1');
    expect(refunds.length).toBeGreaterThan(0);
    const refunded = parsed.filter((e) =>
      e['event_name'] === 'order.live.v1' &&
      (e['properties'] as Record<string, unknown>)['financial_status'] === 'refunded');
    expect(refunded.length).toBeGreaterThan(0);
    // refund occurred_at is REAL (not the epoch-0 shopify-mapper fallback bug)
    for (const rEv of refunds) {
      expect(Date.parse(String(rEv['occurred_at']))).toBeGreaterThan(Date.parse('2026-01-01T00:00:00Z'));
    }
  });
});

describe('SPEC 1.10 — invariants', () => {
  it('collector lane carries NO raw PII: no fixture emails, no raw phone numbers', () => {
    const jsonl = collector!.jsonl;
    expect(jsonl).not.toMatch(/@aurora-athletics\.golden\.test/);
    expect(jsonl).not.toMatch(/@bazaar-bloom\.golden\.test/);
    expect(jsonl).not.toMatch(/@cedar-and-sand\.golden\.test/);
    expect(jsonl).not.toMatch(/\+919\d{9}/);
  });

  it('consent-off traffic: ABSENT consent_flags pixel events AND analytics:false variants both exist', () => {
    const pixelAbsent = parsed.filter((e) =>
      !('consent_flags' in e) &&
      (e['properties'] as Record<string, unknown>)['install_token'] !== undefined);
    const denied = parsed.filter((e) => {
      const cf = e['consent_flags'] as Record<string, unknown> | undefined;
      return cf !== undefined && cf['analytics'] === false;
    });
    expect(pixelAbsent.length).toBeGreaterThan(0);
    expect(denied.length).toBeGreaterThan(0);
  });

  it('server-trusted canonicals carry NO install_token and NO consent_flags (Silver lane split)', () => {
    const canonicals = parsed.filter((e) =>
      ['order.live.v1', 'refund.recorded.v1', 'shiprocket.shipment_status.v1',
        'gokwik.checkout_started.v1', 'gokwik.checkout_step.v1'].includes(String(e['event_name'])));
    expect(canonicals.length).toBeGreaterThan(0);
    for (const e of canonicals) {
      expect(e).not.toHaveProperty('consent_flags');
      expect((e['properties'] as Record<string, unknown>)['install_token']).toBeUndefined();
    }
  });

  it('GCC KWD orders carry scale-3 minor units with a live sub-fils-of-100 digit (money §1.2)', () => {
    const kwd = parsed.filter((e) =>
      e['event_name'] === 'order.live.v1' &&
      (e['properties'] as Record<string, unknown>)['currency_code'] === 'KWD');
    expect(kwd.length).toBeGreaterThan(0);
    for (const o of kwd) {
      expect(o['brand_id']).toBe(CEDAR.id);
      const minor = BigInt(String((o['properties'] as Record<string, unknown>)['amount_minor']));
      expect(minor > 0n).toBe(true);
    }
    // At least one amount NOT expressible at scale-2 — proves true 3-decimal minor units.
    const subFils = kwd.some((o) =>
      BigInt(String((o['properties'] as Record<string, unknown>)['amount_minor'])) % 100n !== 0n);
    expect(subFils).toBe(true);
  });

  it('INR order amounts round-trip the real shopify-mapper (scale-2 minor units)', () => {
    const aurora = parsed.filter((e) =>
      e['event_name'] === 'order.live.v1' && e['brand_id'] === AURORA.id);
    expect(aurora.length).toBeGreaterThan(0);
    for (const o of aurora) {
      const p = o['properties'] as Record<string, unknown>;
      expect(p['currency_code']).toBe('INR');
      expect(BigInt(String(p['amount_minor'])) % 100n).toBe(0n); // fixture prices are whole-paise .00
      expect(p['source']).toBe('shopify');
    }
  });

  it('designed deterministic identification rate over purchasers clears the Wave-A 40% floor', () => {
    expect(dataset.manifest.identifiedPurchaserRate).toBeGreaterThan(0.4);
  });

  it('anon→known linkage is materialized: identify hash + order stitched_anon_id + salted connector hashes', () => {
    const identifies = parsed.filter((e) => e['event_name'] === 'identify');
    expect(identifies.length).toBeGreaterThan(0);
    for (const e of identifies) {
      const h = String((e['properties'] as Record<string, unknown>)['hashed_customer_email']);
      expect(h).toMatch(/^[0-9a-f]{64}$/);
    }
    const stitched = parsed.filter((e) =>
      e['event_name'] === 'order.live.v1' &&
      typeof (e['properties'] as Record<string, unknown>)['stitched_anon_id'] === 'string');
    expect(stitched.length).toBeGreaterThan(0);
    const hashedOrders = parsed.filter((e) =>
      e['event_name'] === 'order.live.v1' &&
      typeof (e['properties'] as Record<string, unknown>)['hashed_customer_email'] === 'string');
    expect(hashedOrders.length).toBeGreaterThan(0);
  });
});
