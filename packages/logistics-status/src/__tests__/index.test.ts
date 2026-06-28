/**
 * @brain/logistics-status — UT: the shared status→terminal_class authority.
 *
 * Two guarantees:
 *   1. GoKwik vocabulary classifies IDENTICALLY to the pre-extraction behavior (no regression).
 *   2. Shiprocket vocabulary maps to the correct canonical terminal_class (no per-source drift).
 */

import { describe, it, expect } from 'vitest';
import {
  classifyShipmentStatus,
  isTerminalStatus,
  normalizeStatus,
  RTO_TERMINAL_STATES,
  DELIVERED_TERMINAL_STATES,
  OTHER_TERMINAL_STATES,
  classifyReturnStatus,
  isReturnComplete,
  classifyException,
  isExceptionStatus,
} from '../index.js';

describe('classifyShipmentStatus — GoKwik vocabulary (must be byte-identical to pre-extraction)', () => {
  it('classifies RTO terminal states', () => {
    expect(classifyShipmentStatus('RTO Initiated')).toBe('rto');
    expect(classifyShipmentStatus('rto_delivered')).toBe('rto');
    expect(classifyShipmentStatus('RTO')).toBe('rto');
    expect(classifyShipmentStatus('RTO Out For Delivery')).toBe('rto');
  });

  it('classifies Delivered terminal states', () => {
    expect(classifyShipmentStatus('Delivered')).toBe('delivered');
    expect(classifyShipmentStatus('completed')).toBe('delivered');
  });

  it('classifies Other terminal states', () => {
    expect(classifyShipmentStatus('Cancelled')).toBe('other');
  });

  it('classifies transition states as none (NOT terminal)', () => {
    expect(classifyShipmentStatus('in transit')).toBe('none');
    expect(classifyShipmentStatus('out for delivery')).toBe('none');
    expect(isTerminalStatus('in transit')).toBe(false);
    expect(isTerminalStatus('rto delivered')).toBe(true);
  });
});

describe('classifyShipmentStatus — Shiprocket vocabulary', () => {
  it('maps Shiprocket RTO sub-states to rto', () => {
    expect(classifyShipmentStatus('RTO-OFD')).toBe('rto');
    expect(classifyShipmentStatus('RTO Acknowledged')).toBe('rto');
    expect(classifyShipmentStatus('RTO Rejected')).toBe('rto');
    expect(classifyShipmentStatus('RTO NDR')).toBe('rto');
  });

  it('maps Shiprocket hard-terminal end-states to other', () => {
    expect(classifyShipmentStatus('Destroyed')).toBe('other');
    expect(classifyShipmentStatus('Disposed Of')).toBe('other');
    expect(classifyShipmentStatus('Canceled')).toBe('other');
  });

  it('keeps Shiprocket forward/NDR transitions as none (in-flight)', () => {
    expect(classifyShipmentStatus('Pickup Scheduled')).toBe('none');
    expect(classifyShipmentStatus('Picked Up')).toBe('none');
    expect(classifyShipmentStatus('In-Transit')).toBe('none');
    expect(classifyShipmentStatus('Out For Delivery')).toBe('none');
    expect(classifyShipmentStatus('Undelivered')).toBe('none');
    expect(classifyShipmentStatus('Delayed')).toBe('none');
  });

  it('Delivered is delivered (shared)', () => {
    expect(classifyShipmentStatus('Delivered')).toBe('delivered');
  });
});

describe('terminal-state sets are immutable (frozen authority — no per-source drift)', () => {
  // Cast away ReadonlySet so we can attempt the runtime mutation TS would otherwise block.
  const sets: Array<[string, ReadonlySet<string>]> = [
    ['RTO_TERMINAL_STATES', RTO_TERMINAL_STATES],
    ['DELIVERED_TERMINAL_STATES', DELIVERED_TERMINAL_STATES],
    ['OTHER_TERMINAL_STATES', OTHER_TERMINAL_STATES],
  ];

  for (const [name, set] of sets) {
    it(`${name} rejects add/delete/clear at runtime`, () => {
      const mutable = set as Set<string>;
      const sizeBefore = set.size;
      const existing = [...set][0] ?? '';
      expect(() => mutable.add('hacked')).toThrow(/immutable/);
      expect(() => mutable.delete(existing)).toThrow(/immutable/);
      expect(() => mutable.clear()).toThrow(/immutable/);
      expect(set.size).toBe(sizeBefore);
      expect(set.has('hacked')).toBe(false);
    });
  }
});

describe('normalizeStatus', () => {
  it('folds case, underscores, hyphens and whitespace', () => {
    expect(normalizeStatus('  RTO_Out-For   Delivery ')).toBe('rto out for delivery');
    expect(normalizeStatus(null)).toBe('');
    expect(normalizeStatus(undefined)).toBe('');
  });
});

// ── SR-4: RETURN family (the revenue-truth correctness fix) ───────────────────────────────────────
describe('classifyReturnStatus — returns are NEVER a forward DELIVERED', () => {
  it('classifies the four return stages from bare body statuses', () => {
    expect(classifyReturnStatus('created')).toBe('return_initiated');
    expect(classifyReturnStatus('Picked Up')).toBe('return_in_transit');
    expect(classifyReturnStatus('delivered')).toBe('return_delivered');
    expect(classifyReturnStatus('completed')).toBe('return_completed');
  });

  it('classifies return TOPIC strings (dotted form) too', () => {
    expect(classifyReturnStatus('return.created')).toBe('return_initiated');
    expect(classifyReturnStatus('return.picked_up')).toBe('return_in_transit');
    expect(classifyReturnStatus('return.delivered')).toBe('return_delivered');
    expect(classifyReturnStatus('return.completed')).toBe('return_completed');
    expect(classifyReturnStatus('return.refunded')).toBe('return_completed');
  });

  it('CRITICAL: return.completed / return.delivered NEVER classify to the forward DELIVERED class', () => {
    // The bug SR-4 fixes: a return whose status is "completed"/"delivered" must NOT be a forward delivery.
    // The forward classifier WOULD map them to 'delivered' — the return classifier maps them to a RETURN_* class.
    expect(classifyShipmentStatus('completed')).toBe('delivered'); // forward authority unchanged (byte-identical)
    expect(classifyShipmentStatus('delivered')).toBe('delivered');
    expect(classifyReturnStatus('completed')).toBe('return_completed'); // return lane keeps them distinct
    expect(classifyReturnStatus('delivered')).toBe('return_delivered');
    expect(classifyReturnStatus('completed')).not.toBe('delivered');
  });

  it('isReturnComplete only on the terminal return state', () => {
    expect(isReturnComplete('completed')).toBe(true);
    expect(isReturnComplete('return.refunded')).toBe(true);
    expect(isReturnComplete('picked up')).toBe(false);
    expect(isReturnComplete('unknown')).toBe(false);
  });

  it('unknown return status → none', () => {
    expect(classifyReturnStatus('something weird')).toBe('none');
    expect(classifyReturnStatus(null)).toBe('none');
  });
});

// ── SR-5: non-terminal EXCEPTION / NDR sub-class ──────────────────────────────────────────────────
describe('classifyException — NON-terminal delay/NDR, does NOT alter terminal_class', () => {
  it('maps delayed → delayed and NDR-family → ndr', () => {
    expect(classifyException('Delayed')).toBe('delayed');
    expect(classifyException('NDR')).toBe('ndr');
    expect(classifyException('exception')).toBe('ndr');
    expect(classifyException('Undelivered')).toBe('ndr');
    expect(classifyException('Customer Unavailable')).toBe('ndr');
  });

  it('returns null for non-exception statuses', () => {
    expect(classifyException('In-Transit')).toBeNull();
    expect(classifyException('Delivered')).toBeNull();
    expect(classifyException(null)).toBeNull();
    expect(isExceptionStatus('Delayed')).toBe(true);
    expect(isExceptionStatus('Delivered')).toBe(false);
  });

  it('EXCEPTION is a SEPARATE dimension — classifyShipmentStatus stays byte-identical (none, not terminal)', () => {
    // delayed/exception/ndr/undelivered remain 'none' in the FROZEN forward authority (GoKwik parity),
    // so is_terminal stays false; the exception signal is carried alongside, never via terminal_class.
    expect(classifyShipmentStatus('Delayed')).toBe('none');
    expect(classifyShipmentStatus('NDR')).toBe('none');
    expect(classifyShipmentStatus('Undelivered')).toBe('none');
    expect(isTerminalStatus('Delayed')).toBe(false);
  });
});
