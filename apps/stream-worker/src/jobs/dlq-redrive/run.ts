/**
 * dlq-redrive — P2.2 operator CLI to replay dead-lettered messages back to their original topic.
 *
 * The stakeholder-visible surface for this slice is THIS operator report (DLQ state is global ops,
 * not per-tenant data — it deliberately does not appear on any brand-scoped page) plus the
 * dlq_redrive_* Prometheus counters that feed the existing DLQ observability (BrainDlqGrowing).
 *
 * Usage (from repo root):
 *   pnpm --filter @brain/stream-worker dlq:redrive -- --topic dev.collector.event.v1.dlq [flags]
 *
 * Flags:
 *   --topic <name>         DLQ topic to drain (required, must end in .dlq)
 *   --max-redrive <n>      loop-guard ceiling (default 3) — messages at/above this are left parked
 *   --limit <n>            stop after scanning n messages (default: drain the whole backlog)
 *   --reason <substr>      only redrive messages whose x-dlq-reason contains this substring
 *   --dry-run              report what WOULD be redriven; publish nothing
 *   --idle-ms <n>          stop once no new message arrives for n ms (default 5000)
 *   --group <id>           consumer group (default brain.stream-worker.dlq-redrive)
 *
 * Replay safety: messages are republished to their original topic and reprocessed with a fresh
 * retry budget; the Bronze write seam dedups, so re-processing a message that actually succeeded is
 * idempotent. Genuinely-poison messages are bounded by --max-redrive and stay parked in the DLQ.
 */
import { Kafka } from 'kafkajs';
import { DlqRedriver, DEFAULT_MAX_REDRIVE, type RedriveReport } from '../../infrastructure/kafka/DlqRedriver.js';

interface CliArgs {
  topic: string;
  maxRedrive: number;
  limit?: number;
  reason?: string;
  dryRun: boolean;
  idleMs: number;
  group: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const topic = get('--topic');
  if (!topic) throw new Error('--topic <name> is required (must end in .dlq)');
  if (!topic.endsWith('.dlq')) {
    throw new Error(`refusing to drain "${topic}": a redrive source topic must end in .dlq`);
  }
  return {
    topic,
    maxRedrive: Number.parseInt(get('--max-redrive') ?? String(DEFAULT_MAX_REDRIVE), 10),
    limit: get('--limit') ? Number.parseInt(get('--limit') as string, 10) : undefined,
    reason: get('--reason'),
    dryRun: argv.includes('--dry-run'),
    idleMs: Number.parseInt(get('--idle-ms') ?? '5000', 10),
    group: get('--group') ?? 'brain.stream-worker.dlq-redrive',
  };
}

export function formatReport(args: CliArgs, report: RedriveReport): string {
  const lines = [
    '',
    `── DLQ redrive ${args.dryRun ? '(DRY RUN — nothing published)' : ''} ──`,
    `  source topic   : ${args.topic}`,
    `  max-redrive    : ${args.maxRedrive}${args.reason ? `   reason~"${args.reason}"` : ''}`,
    `  scanned        : ${report.scanned}`,
    `  redriven       : ${report.redriven}${args.dryRun ? ' (would)' : ''}`,
    `  exhausted      : ${report.exhausted} (≥ max-redrive — left parked as poison)`,
    `  filtered out   : ${report.filtered}`,
    `  errors         : ${report.errors}`,
  ];
  const targets = Object.entries(report.byTargetTopic);
  if (targets.length > 0) {
    lines.push('  by target topic:');
    for (const [t, n] of targets) lines.push(`    ${t} ← ${n}`);
  }
  lines.push('');
  return lines.join('\n');
}

export async function main(argv: string[]): Promise<RedriveReport> {
  const args = parseArgs(argv);
  const brokers = (process.env['KAFKA_BROKERS'] ?? 'localhost:9092').split(',');
  const kafka = new Kafka({ clientId: 'dlq-redrive', brokers, retry: { retries: 5 } });
  const producer = kafka.producer();
  const redriver = new DlqRedriver(kafka, producer, args.group);
  try {
    const report = await redriver.redrive(args.topic, {
      maxRedrive: args.maxRedrive,
      limit: args.limit,
      reasonFilter: args.reason,
      dryRun: args.dryRun,
      idleMs: args.idleMs,
      groupId: args.group,
    });
    // eslint-disable-next-line no-console
    console.log(formatReport(args, report));
    return report;
  } finally {
    await producer.disconnect().catch(() => {});
  }
}

// Run when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((r) => process.exit(r.errors > 0 ? 1 : 0))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[dlq-redrive] failed:', err);
      process.exit(1);
    });
}
