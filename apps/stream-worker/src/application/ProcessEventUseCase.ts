/**
 * ProcessEventUseCase — the core pipeline for Slice 3 (Track A).
 *
 * Pipeline (architecture-plan §2 + §6 Slice 3 acceptance contract):
 *   1. Zod parse (M1-local validate; NOT Apicurio fetch per §3 simplification)
 *   2. Redis SETNX dedup — dedup:{brand_id}:{event_id} EX 604800
 *      → hit (NX fails): return { outcome: 'dedup_hit' }
 *      → miss: proceed
 *   3. Postgres INSERT under brain_app + set_config GUC (D-8)
 *      → unique violation (PK backstop): return { outcome: 'pk_conflict' }
 *      → success: return { outcome: 'written' }
 *
 * Caller (KafkaConsumer) commits offset ONLY after this method returns without
 * throwing (D-7). If this throws, caller must NOT commit — the message will be
 * re-delivered and retried (or routed to DLQ after MAX_RETRY=5).
 *
 * M2 marker: // M2: replace Zod-local validate with Apicurio validateSchemaCompatibility
 */
import { CollectorEventV1Schema } from '@brain/contracts';
import { buildPartitionKey } from '@brain/events';
import type { AuditWriter } from '@brain/audit';
import { RedisDedupAdapter } from '../infrastructure/redis/RedisDedupAdapter.js';
import { BronzeRepository } from '../infrastructure/pg/BronzeRepository.js';
import { BronzeRow } from '../domain/bronze/BronzeRow.js';
import { log } from "../log.js";

export type ProcessOutcome =
  | 'written'       // first sight, successfully inserted to bronze_events
  | 'dedup_hit'     // Redis NX failed — already seen
  | 'pk_conflict'   // PK unique violation — durable second-line dedup
  | 'quarantined'   // R3: PARSED but failed a security/compliance gate → .quarantine sink
  | 'skipped'       // server-trusted lane event seen by the pixel gate — handled by its own bridge
  | 'invalid';      // Zod parse failed — goes to DLQ without retry

/**
 * SERVER-TRUSTED lane event names — connector/worker-emitted events whose brand_id is server-derived
 * (from the authenticated connector_instance) and which carry NO install_token. They land in Bronze via
 * their OWN dedicated server-trusted consumers (the BRONZE_BRIDGES + the Kafka-Connect raw lane), NOT via
 * the pixel install_token gate. The pixel-lane consumer (enforceTenantDerivation=true) must therefore
 * SKIP them — applying install_token derivation would spuriously quarantine them as `tenant_unresolved`
 * (they legitimately have no token). Browser pixel events (page.viewed, product.viewed, cart.*, checkout.*)
 * are NOT in this set and stay fully subject to the R2 tenant + R3 consent gate.
 */
export const SERVER_TRUSTED_EVENT_NAMES: ReadonlySet<string> = new Set([
  'order.live.v1',
  'order.backfill.v1',
  'spend.live.v1',
  'settlement.live.v1',
  'shopflo.checkout_abandoned.v1',
  'gokwik.rto_predict.v1',
  // RETIRED (0117): gokwik.awb_status.v1 — GoKwik's synthetic AWB logistics model is gone
  // (webhook-first payments/checkout; logistics truth is Shiprocket).
  'shiprocket.shipment_status.v1',
  // CRIT-4 / WOO-3 resource events: the Shopify + WooCommerce CONNECTOR-derived RESOURCE canonicals,
  // emitted by the backfill/repull/webhook path with a server-derived brand_id (MT-1, from the resolved
  // connector row — NEVER the API response) and NO install_token / consent signal. On the LIVE collector
  // lane they previously fell to the pixel R2 gate and were quarantined as `tenant_unresolved`; they must
  // SKIP the gate (their own server-trusted bronze bridge lands them). Mirrors the Spark gate.
  'product.upsert.v1',
  'customer.upsert.v1',
  'refund.recorded.v1',
  'coupon.upsert.v1',
  'fulfillment.recorded.v1',
  // AD-1: the SHARED Meta+Google entity-metadata feed (campaign/adset/ad name/status/objective), emitted
  // by meta-entity-sync / google-entity-sync on the live collector lane — connector-derived, server-trusted
  // brand_id, NO install_token / consent. Must skip the pixel gate or it quarantines tenant_unresolved.
  'ad.entity.updated',
  // SHOPFLO lifecycle: the NEW Shopflo checkout-funnel canonicals (webhook-first; brand_id server-derived
  // from the resolved connector row via the webhook pipeline — MT-1; NO install_token / consent).
  'shopflo.checkout_started.v1',
  'shopflo.checkout_step.v1',
  'shopflo.checkout_completed.v1',
]);

export interface ProcessResult {
  outcome: ProcessOutcome;
  brandId?: string;
  eventId?: string;
  /** Bounded dot.lowercase event name — a low-cardinality metric label (R4). */
  eventName?: string;
  reason?: string;
}

export class ProcessEventUseCase {
  constructor(
    private readonly dedup: RedisDedupAdapter,
    private readonly bronze: BronzeRepository,
    /**
     * Optional audit writer — when present, a brand_mismatch quarantine writes a
     * `pixel.brand_mismatch` audit_log row (REC-1). Absent in the backfill lane (orders
     * carry no install_token; the R2 gate does not apply there — see enforceTenantDerivation).
     */
    private readonly audit?: AuditWriter,
    /**
     * R2/R3 gate switch. TRUE (default) for the LIVE collector lane: the authoritative
     * brand_id is DERIVED server-side from properties.install_token (never trusted from
     * input), and absent consent_flags / unresolved-or-mismatched token → quarantined.
     *
     * FALSE for the BACKFILL-ORDER + LIVE-LEDGER lanes: those events carry NO install_token
     * (event_name='order.backfill.v1' / 'order.live.v1'); their brand_id is already
     * server-trusted (derived from the authenticated connector, not from a browser). The
     * R2 browser-spoofing threat model does not apply, so the gate is off for them — they
     * keep their existing trusted-brand Bronze write path unchanged. (Connector webhooks
     * left alone — architecture-plan §5.)
     */
    private readonly enforceTenantDerivation = true,
    /**
     * DB-AUDIT C4: the PG Bronze write switch is now FALSE by default — the dual-sink RETIREMENT is
     * complete. Spark→Iceberg (db/iceberg/spark/bronze_materialize.py) is the sole Bronze system-of-
     * record; data_plane.bronze_events is dropped (migration 0070). All prerequisites are met:
     *   1. ✓ operational reads + the DQ subsystem are on Iceberg;
     *   2. ✓ the Spark writer enforces the SAME R2 install_token tenant-derivation + R3 consent gate
     *      (gate_and_map), so Iceberg holds the SAME admission set PG Bronze did;
     *   3. ✓ parity proven by the Iceberg-flip epic.
     * Set BRONZE_PG_WRITE_ENABLED=true to re-enable (legacy/escape only — the PG table no longer exists).
     * NOTE: R2 brand-derivation (this.bronze.resolveBrandByInstallToken — a pixel_installation read) and
     * the R2/R3 gates STILL run before the early-return; only the PG bronze_events persistence is skipped.
     */
    private readonly pgWriteEnabled = false,
  ) {}

  /**
   * Process one Kafka message through the full pipeline.
   *
   * @param rawValue - raw Buffer from the Kafka message value
   * @param now - current timestamp (ISO-8601) for ingested_at when not present in envelope
   * @returns ProcessResult describing what happened (caller uses this to decide offset commit)
   */
  async execute(rawValue: Buffer | null, now: string): Promise<ProcessResult> {
    // ── Step 1: Deserialise + Zod validate ───────────────────────────────────
    // M1: local Zod parse (§3 simplification; Apicurio fetch is M2 refinement)
    // M2: replace with Apicurio validateSchemaCompatibility
    if (rawValue == null) {
      return { outcome: 'invalid', reason: 'null message value' };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawValue.toString('utf8'));
    } catch {
      return { outcome: 'invalid', reason: 'JSON parse error' };
    }

    const zodResult = CollectorEventV1Schema.safeParse(parsed);
    if (!zodResult.success) {
      return {
        outcome: 'invalid',
        reason: `Zod validation failed: ${JSON.stringify(zodResult.error.issues)}`,
      };
    }

    const event = zodResult.data;
    const {
      brand_id: claimedBrandId,
      event_id,
      occurred_at,
      ingested_at,
      correlation_id,
      event_name,
      properties,
      consent_flags,
    } = event;

    // ── Step 1b: R2 tenant-key derivation + R3 consent gate (LIVE lane only) ───
    // The tenant key is NEVER trusted from input. For the live collector lane we DERIVE
    // the authoritative brand_id from properties.install_token via the SECURITY DEFINER
    // fn (migration 0028). The claimed top-level brand_id is for PARTITIONING ONLY.
    //   - token absent/malformed/unresolved → quarantine (reason 'tenant_unresolved').
    //   - token resolves but claimed brand_id !== derived → quarantine + audit
    //     'pixel.brand_mismatch' (REC-1). NEVER written under a claimed brand.
    //   - consent_flags ABSENT → quarantine (reason 'consent_absent') — not dropped,
    //     not Bronze-as-trusted (R3 / COMPLIANCE.md:105).
    // The backfill-order / live-ledger lanes set enforceTenantDerivation=false (their
    // brand_id is already server-trusted; they carry no install_token).
    let brand_id = claimedBrandId;
    if (this.enforceTenantDerivation) {
      // SERVER-TRUSTED bypass: connector/worker-emitted lane events (order.live.v1, spend.live.v1, the
      // logistics/checkout bridge events, …) carry a server-derived brand_id and NO install_token, and
      // land in Bronze via their OWN server-trusted bridges. The pixel install_token gate must NOT touch
      // them — doing so quarantines them as `tenant_unresolved`. Skip (commit, no quarantine, no Bronze
      // write here); their dedicated consumer owns the landing. Pixel/browser events fall through to the gate.
      if (SERVER_TRUSTED_EVENT_NAMES.has(event_name)) {
        return { outcome: 'skipped', brandId: claimedBrandId, eventId: event_id, eventName: event_name, reason: 'server_trusted_lane' };
      }
      const installToken = (properties as Record<string, unknown> | undefined)?.['install_token'];
      const derivedBrandId = await this.bronze.resolveBrandByInstallToken(installToken);

      if (derivedBrandId == null) {
        // Token absent / malformed / unresolved → never written under a claimed brand.
        return {
          outcome: 'quarantined',
          eventId: event_id,
          reason: 'tenant_unresolved',
        };
      }

      if (claimedBrandId !== derivedBrandId) {
        // Cross-brand claim — the browser stamped a brand_id it does not own.
        await this.writeBrandMismatchAudit(derivedBrandId, event_id, claimedBrandId, correlation_id);
        return {
          outcome: 'quarantined',
          brandId: derivedBrandId,
          eventId: event_id,
          reason: 'brand_mismatch',
        };
      }

      // R3 consent gate — capture-only field must be PRESENT (enforcement is downstream).
      if (consent_flags == null) {
        return {
          outcome: 'quarantined',
          brandId: derivedBrandId,
          eventId: event_id,
          reason: 'consent_absent',
        };
      }

      // Authoritative tenant key — used for dedup keyspace + the Bronze GUC below.
      brand_id = derivedBrandId;
    }

    // ── Step 1c: PG Bronze write retired (Slice 6) ─────────────────────────────
    // When the PG write is disabled, the R2/R3 gating above has ALREADY run (quarantine/invalid
    // outcomes returned), so the security gates still hold for routing; we just don't persist to PG
    // (Spark→Iceberg is the SoR) and we commit the offset. Skips dedup + write.
    if (!this.pgWriteEnabled) {
      return { outcome: 'written', brandId: brand_id, eventId: event_id, eventName: event_name };
    }

    // ── Step 2: Redis dedup — fast-path CHECK only (R-08) ─────────────────────
    // The slot is CLAIMED only AFTER the durable Bronze write (Step 5), never before: claiming first
    // means a transient write failure leaves a "seen" slot, and the reprocessed message would be
    // skipped + committed → the event is silently lost. The DURABLE dedup is the bronze_events PK.
    if (await this.dedup.check(brand_id, event_id)) {
      return { outcome: 'dedup_hit', brandId: brand_id, eventId: event_id, eventName: event_name };
    }

    // ── Step 3: Build BronzeRow ───────────────────────────────────────────────
    const row: BronzeRow = {
      brand_id,
      event_id,
      occurred_at,                              // ISO-8601 string → timestamptz at write (D-6)
      ingested_at: ingested_at ?? now,          // from envelope or fallback to now
      schema_name: 'brain.collector.event.v1', // M1 literal (F-10)
      schema_version: 1,                        // M1 literal; Apicurio-resolved in M2
      event_type: event_name,                   // semantic event type from envelope
      correlation_id,
      partition_key: buildPartitionKey(brand_id, event_id),
      payload: {
        event_name,
        properties: properties ?? {},
        // consent_flags captured into the Bronze payload (R3) — capture-only, no PII.
        ...(consent_flags != null ? { consent_flags } : {}),
        // hashed_user_id and hashed_session_id included if present (no raw PII, I-S02)
        ...(event.hashed_user_id != null ? { hashed_user_id: event.hashed_user_id } : {}),
        ...(event.hashed_session_id != null ? { hashed_session_id: event.hashed_session_id } : {}),
      },
      processing_flags: { dedup_layer: 'redis_nx', stream_worker_ts: now },
      collector_version: null,
    };

    // ── Step 4: Write to bronze_events under brain_app + GUC (D-8) ───────────
    // BronzeRepository handles BEGIN, set_config GUC, INSERT, COMMIT.
    // ON CONFLICT DO NOTHING → writeResult.inserted = false (PK backstop hit).
    const writeResult = await this.bronze.write(row);

    if (!writeResult.inserted) {
      // PK conflict — a durable duplicate. Prime the fast-path slot so future sightings short-circuit.
      await this.claimDedupBestEffort(brand_id, event_id);
      return { outcome: 'pk_conflict', brandId: brand_id, eventId: event_id, eventName: event_name };
    }

    // R-08: the write is DURABLE — only NOW claim the Redis fast-path slot. Best-effort: a Redis failure
    // must not fail an already-committed event (reprocessing re-writes → PK conflict → still deduped).
    await this.claimDedupBestEffort(brand_id, event_id);
    return { outcome: 'written', brandId: brand_id, eventId: event_id };
  }

  /**
   * Claim the Redis fast-path dedup slot AFTER a durable write (R-08). Best-effort: the durable dedup is
   * the bronze_events PK, so a Redis failure here is non-fatal — swallow it (a future duplicate just pays
   * one extra DB round-trip that the PK rejects). NEVER let it fail an already-committed event.
   */
  private async claimDedupBestEffort(brandId: string, eventId: string): Promise<void> {
    try {
      await this.dedup.claim(brandId, eventId);
    } catch (err) {
      // intentional non-fatal: the PK is the durable dedup; the fast-path slot is just an
      // optimization. Surface at debug so a persistently-degraded Redis is visible without
      // ever failing an already-committed event.
      log.debug('redis dedup fast-path claim failed (non-fatal)', { brand_id: brandId, err });
    }
  }

  /**
   * Write a `pixel.brand_mismatch` audit_log row (REC-1) when a browser stamps a
   * brand_id it does not own. Recorded under the DERIVED (true) brand — the owner of the
   * install_token — so the forensic trail is attributed to the real tenant, not the
   * claimed one. NO raw PII (only the event_id, the claimed brand_id, correlation_id).
   *
   * Audit failure must NOT block quarantine routing — a missing forensic row is strictly
   * less harmful than letting a cross-brand event through. Logged + swallowed.
   */
  private async writeBrandMismatchAudit(
    derivedBrandId: string,
    eventId: string,
    claimedBrandId: string,
    correlationId: string,
  ): Promise<void> {
    if (this.audit == null) return;
    try {
      await this.audit.append({
        brand_id: derivedBrandId,
        actor_id: null,
        actor_role: 'system',
        action: 'pixel.brand_mismatch',
        entity_type: 'collector_event',
        entity_id: eventId,
        payload: {
          claimed_brand_id: claimedBrandId,
          derived_brand_id: derivedBrandId,
          correlation_id: correlationId,
          outcome: 'quarantined',
        },
        // Idempotent on the event_id — a replayed mismatch writes exactly one audit row.
        idempotency_key: `pixel.brand_mismatch:${eventId}`,
      });
    } catch (err) {
      log.error(`audit write failed for pixel.brand_mismatch event=${eventId}`, { err: err });
    }
  }
}
