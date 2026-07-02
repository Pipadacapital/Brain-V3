/**
 * offset-commit-batcher.unit.test.ts — AUD-PERF-009.
 *
 * Proves the batched-commit contract that replaces per-message commitOffsets:
 *   - commits fire every N records (or T ms / explicit flush), ONE request per window;
 *   - only offsets already recorded (i.e. confirmed writes) are ever committed — D-7 at
 *     batch granularity, monotonic per partition;
 *   - a failed commit drops the window (replay-safe direction) instead of looping.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OffsetCommitBatcher, type CommitEntry } from '../interfaces/consumers/OffsetCommitBatcher.js';

describe('OffsetCommitBatcher (AUD-PERF-009)', () => {
  const committed: CommitEntry[][] = [];
  let commit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    committed.length = 0;
    commit = vi.fn(async (entries: CommitEntry[]) => {
      committed.push(entries);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does NOT commit before the message threshold (no per-message broker round trip)', async () => {
    const b = new OffsetCommitBatcher('t', commit, 5, 60_000);
    for (let i = 0; i < 4; i++) await b.record(0, String(i));
    expect(commit).not.toHaveBeenCalled();
  });

  it('commits ONCE per window with the highest next-offset per partition', async () => {
    const b = new OffsetCommitBatcher('t', commit, 5, 60_000);
    await b.record(0, '10');
    await b.record(0, '11');
    await b.record(1, '3');
    await b.record(0, '12');
    await b.record(1, '4'); // 5th record → flush
    expect(commit).toHaveBeenCalledTimes(1);
    expect(committed[0]).toEqual(
      expect.arrayContaining([
        { topic: 't', partition: 0, offset: '13' }, // 12 + 1
        { topic: 't', partition: 1, offset: '5' }, // 4 + 1
      ]),
    );
    expect(committed[0]).toHaveLength(2);
  });

  it('flush() commits whatever is pending (used by the rare DLQ/quarantine paths + stop)', async () => {
    const b = new OffsetCommitBatcher('t', commit, 100, 60_000);
    await b.record(2, '7');
    await b.flush();
    expect(committed[0]).toEqual([{ topic: 't', partition: 2, offset: '8' }]);
  });

  it('flush() with nothing pending is a no-op (no empty commit request)', async () => {
    const b = new OffsetCommitBatcher('t', commit, 100, 60_000);
    await b.flush();
    expect(commit).not.toHaveBeenCalled();
  });

  it('the idle timer flushes a stalled window within the interval', async () => {
    const b = new OffsetCommitBatcher('t', commit, 100, 1_000);
    b.start();
    await b.record(0, '1');
    expect(commit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_001);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(committed[0]).toEqual([{ topic: 't', partition: 0, offset: '2' }]);
    await b.stop();
  });

  it('stop() flushes the final window and stops the timer', async () => {
    const b = new OffsetCommitBatcher('t', commit, 100, 60_000);
    b.start();
    await b.record(0, '42');
    await b.stop();
    expect(committed[0]).toEqual([{ topic: 't', partition: 0, offset: '43' }]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(commit).toHaveBeenCalledTimes(1); // timer is gone
  });

  it('a failed commit DROPS the window (uncommitted replay is dedup-absorbed) and later windows proceed', async () => {
    commit.mockRejectedValueOnce(new Error('rebalance in progress'));
    const b = new OffsetCommitBatcher('t', commit, 100, 60_000);
    await b.record(0, '5');
    await b.flush(); // fails, window dropped — never throws into the consumer
    await b.record(0, '6');
    await b.flush();
    expect(commit).toHaveBeenCalledTimes(2);
    expect(committed).toEqual([[{ topic: 't', partition: 0, offset: '7' }]]);
  });

  it('records after a flush open a NEW window (never re-commit an old position)', async () => {
    const b = new OffsetCommitBatcher('t', commit, 2, 60_000);
    await b.record(0, '1');
    await b.record(0, '2'); // flush → offset 3
    await b.record(0, '3');
    await b.record(0, '4'); // flush → offset 5
    expect(committed).toEqual([
      [{ topic: 't', partition: 0, offset: '3' }],
      [{ topic: 't', partition: 0, offset: '5' }],
    ]);
  });
});
