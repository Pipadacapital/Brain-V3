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
