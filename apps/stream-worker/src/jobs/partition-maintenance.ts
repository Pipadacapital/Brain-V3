/**
 * partition-maintenance — scheduled partition lifecycle for the RANGE-partitioned tables (C4b).
 *
 * Argo CronJob entry point (run e.g. daily). Calls the catalog-driven SQL routine
 * public.maintain_time_partitions(ahead_months, retention_months) (migration 0080), which:
 *   • CREATE-AHEAD: ensures current + next N months have a partition on every partitioned table,
 *     so writes never fall into the DEFAULT catch-all.
 *   • DROP-OLD: drops partitions older than the retention horizon (NULL = keep forever; never DEFAULT).
 *
 * The function is SECURITY DEFINER (owned by superuser brain) with EXECUTE granted to brain_app, so
 * this job connects as brain_app like every other worker path — no elevated DDL grant on the role.
 *
 * Config via env (sane defaults):
 *   PARTITION_AHEAD_MONTHS     (default 3)  — how many months ahead to pre-create.
 *   PARTITION_RETENTION_MONTHS (default '' / unset) — drop partitions older than this; unset = keep all.
 *
 * Usage: node dist/jobs/partition-maintenance.js  (or via Argo CronJob targeting this file).
 */

import { Pool } from 'pg';
import { loadStreamWorkerConfig } from '@brain/config';
import { log } from '../log.js';

const cfg = loadStreamWorkerConfig();
const DB_URL = cfg.BRAIN_APP_DATABASE_URL;

interface MaintenanceRow {
  action: string;
  partition: string;
}

export async function runPartitionMaintenance(): Promise<{ created: number; dropped: number }> {
  const aheadMonths = cfg.PARTITION_AHEAD_MONTHS;
  const retentionRaw = cfg.PARTITION_RETENTION_MONTHS;
  const retentionMonths =
    retentionRaw && retentionRaw.trim() !== '' ? Number.parseInt(retentionRaw, 10) : null;

  const pool = new Pool({ connectionString: DB_URL, max: 2 });
  try {
    log.info(
      `partition maintenance starting ahead=${aheadMonths} retention=${retentionMonths ?? 'none'}`,
    );
    const res = await pool.query<MaintenanceRow>(
      'SELECT action, partition FROM public.maintain_time_partitions($1, $2)',
      [aheadMonths, retentionMonths],
    );

    let created = 0;
    let dropped = 0;
    for (const row of res.rows) {
      if (row.action === 'created') created++;
      else if (row.action === 'dropped') dropped++;
      log.info(`[partition-maintenance] ${row.action} ${row.partition}`);
    }
    log.info(`partition maintenance complete: created=${created} dropped=${dropped}`);
    return { created, dropped };
  } finally {
    await pool.end();
  }
}

// Run when invoked directly
if (
  process.argv[1]?.endsWith('partition-maintenance.ts') ||
  process.argv[1]?.endsWith('partition-maintenance.js')
) {
  runPartitionMaintenance().catch((err) => {
    log.error('fatal', { err });
    process.exit(1);
  });
}
