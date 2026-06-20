/**
 * audit-checkpoint.test.ts — the WORM checkpoint seal (R-19 external anchor).
 *
 * Pins the tamper-evidence properties of the periodic chain-head checkpoint that the
 * hourly job writes to S3 Object-Lock: deterministic seal, chain linkage, and detection of
 * any altered field. The S3 read/write is the job's I/O concern (apps/core) — tested there.
 */
import { describe, it, expect } from 'vitest';
import {
  buildAuditCheckpoint,
  verifyAuditCheckpoint,
  type AuditChainHead,
} from './index.js';

const HEAD: AuditChainHead = {
  headId: '1042',
  headEntryHash: 'a'.repeat(64),
  rowCount: '1042',
};
const AT = '2026-06-20T11:00:00.000Z';

describe('buildAuditCheckpoint — deterministic seal', () => {
  it('same inputs → same checkpointHash (verifiable offline)', () => {
    expect(buildAuditCheckpoint(HEAD, null, AT).checkpointHash).toBe(
      buildAuditCheckpoint(HEAD, null, AT).checkpointHash,
    );
  });

  it('carries the head + chains the prior checkpoint hash', () => {
    const cp = buildAuditCheckpoint(HEAD, 'prevhash123', AT);
    expect(cp.headId).toBe('1042');
    expect(cp.headEntryHash).toBe('a'.repeat(64));
    expect(cp.rowCount).toBe('1042');
    expect(cp.prevCheckpointHash).toBe('prevhash123');
    expect(cp.checkpointHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('genesis checkpoint (empty audit_log) seals headEntryHash=null', () => {
    const cp = buildAuditCheckpoint({ headId: '0', headEntryHash: null, rowCount: '0' }, null, AT);
    expect(cp.headEntryHash).toBeNull();
    expect(verifyAuditCheckpoint(cp)).toBe(true);
  });

  it('a different prev-checkpoint hash yields a different seal (chain linkage)', () => {
    expect(buildAuditCheckpoint(HEAD, 'p1', AT).checkpointHash).not.toBe(
      buildAuditCheckpoint(HEAD, 'p2', AT).checkpointHash,
    );
  });
});

describe('verifyAuditCheckpoint — tamper detection', () => {
  it('accepts an untouched checkpoint', () => {
    expect(verifyAuditCheckpoint(buildAuditCheckpoint(HEAD, 'prev', AT))).toBe(true);
  });

  it('rejects a tampered head hash (the forensic payload)', () => {
    const cp = buildAuditCheckpoint(HEAD, 'prev', AT);
    expect(verifyAuditCheckpoint({ ...cp, headEntryHash: 'b'.repeat(64) })).toBe(false);
  });

  it('rejects a tampered row count (rows deleted/inserted under the hood)', () => {
    const cp = buildAuditCheckpoint(HEAD, 'prev', AT);
    expect(verifyAuditCheckpoint({ ...cp, rowCount: '1041' })).toBe(false);
  });

  it('rejects a re-pointed prev-checkpoint link', () => {
    const cp = buildAuditCheckpoint(HEAD, 'prev', AT);
    expect(verifyAuditCheckpoint({ ...cp, prevCheckpointHash: 'other' })).toBe(false);
  });

  it('rejects a back-dated checkpointAt', () => {
    const cp = buildAuditCheckpoint(HEAD, 'prev', AT);
    expect(verifyAuditCheckpoint({ ...cp, checkpointAt: '2020-01-01T00:00:00.000Z' })).toBe(false);
  });
});
