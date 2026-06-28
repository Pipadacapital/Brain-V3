/**
 * bronzeBridges.ts — the DECLARATIVE registry of Bronze-bridge consumers (re-platform Phase B).
 *
 * Each entry lands ONE server-trusted event_name into Bronze on its own consumer group via the
 * generic EventBronzeBridgeConsumer (one shared ProcessEventUseCase). These bridges used to be
 * hand-declared, hand-started, and hand-stopped one-by-one in main.ts — the "wired-to-nothing"
 * anti-pattern that has already bitten 3× (a new bridge added but never `.start()`-ed = permanent
 * no_data for that source). Driving them from this single list makes start/stop coverage STRUCTURAL:
 * `buildBronzeBridges()` returns one consumer per entry, and main.ts starts/stops the whole array in
 * a loop, so it is impossible to add a bridge without it being wired. Adding a Bronze landing for a
 * new connector = ONE entry here (config), not three edits in three places.
 */
import type { Kafka } from 'kafkajs';
import { EventBronzeBridgeConsumer } from './EventBronzeBridgeConsumer.js';
import type { ProcessEventUseCase } from '../../application/ProcessEventUseCase.js';
import type { IRetryCounter } from '../../infrastructure/redis/RetryCounterAdapter.js';

export interface BronzeBridgeDef {
  /** Env var that overrides the consumer group id (per-bridge isolation). */
  readonly groupIdEnv: string;
  /** Default consumer group id when the env var is unset. */
  readonly defaultGroupId: string;
  /** The Bronze event_name this bridge lands (the discriminant on the shared topic). */
  readonly eventName: string;
  /** The per-source Bronze-write counter metric. */
  readonly metricName: string;
}

/**
 * The complete set of server-trusted Bronze bridges. Order is irrelevant (independent consumer
 * groups). To add a connector's Bronze landing, append one entry — start/stop is automatic.
 */
export const BRONZE_BRIDGES: readonly BronzeBridgeDef[] = [
  {
    groupIdEnv: 'SHOPFLO_BRONZE_CONSUMER_GROUP_ID',
    defaultGroupId: 'shopflo-bronze-bridge',
    eventName: 'shopflo.checkout_abandoned.v1',
    metricName: 'shopflo_bronze_write_total',
  },
  {
    groupIdEnv: 'GOKWIK_RTO_PREDICT_BRONZE_CONSUMER_GROUP_ID',
    defaultGroupId: 'gokwik-rto-predict-bronze-bridge',
    eventName: 'gokwik.rto_predict.v1',
    metricName: 'gokwik_rto_predict_bronze_write_total',
  },
  // RETIRED (0117 — GoKwik AWB model): gokwik.awb_status.v1 was a synthetic logistics model.
  // GoKwik is webhook-first payments/checkout; logistics truth is Shiprocket. No AWB bridge.
  {
    groupIdEnv: 'SHIPROCKET_SHIPMENT_BRONZE_CONSUMER_GROUP_ID',
    defaultGroupId: 'shiprocket-shipment-bronze-bridge',
    eventName: 'shiprocket.shipment_status.v1',
    metricName: 'shiprocket_shipment_bronze_write_total',
  },
  {
    groupIdEnv: 'LIVE_ORDER_BRONZE_CONSUMER_GROUP_ID',
    defaultGroupId: 'live-order-bronze-bridge',
    eventName: 'order.live.v1',
    metricName: 'live_order_bronze_write_total',
  },
  // CRIT-4 / WOO-3 resource events (Shopify + WooCommerce): server-derived brand_id, NO install_token —
  // the live pixel gate quarantined them, so each lands in Bronze via its own server-trusted bridge.
  {
    groupIdEnv: 'PRODUCT_UPSERT_BRONZE_CONSUMER_GROUP_ID',
    defaultGroupId: 'product-upsert-bronze-bridge',
    eventName: 'product.upsert.v1',
    metricName: 'product_upsert_bronze_write_total',
  },
  {
    groupIdEnv: 'CUSTOMER_UPSERT_BRONZE_CONSUMER_GROUP_ID',
    defaultGroupId: 'customer-upsert-bronze-bridge',
    eventName: 'customer.upsert.v1',
    metricName: 'customer_upsert_bronze_write_total',
  },
  {
    groupIdEnv: 'REFUND_RECORDED_BRONZE_CONSUMER_GROUP_ID',
    defaultGroupId: 'refund-recorded-bronze-bridge',
    eventName: 'refund.recorded.v1',
    metricName: 'refund_recorded_bronze_write_total',
  },
  {
    groupIdEnv: 'COUPON_UPSERT_BRONZE_CONSUMER_GROUP_ID',
    defaultGroupId: 'coupon-upsert-bronze-bridge',
    eventName: 'coupon.upsert.v1',
    metricName: 'coupon_upsert_bronze_write_total',
  },
  {
    groupIdEnv: 'FULFILLMENT_RECORDED_BRONZE_CONSUMER_GROUP_ID',
    defaultGroupId: 'fulfillment-recorded-bronze-bridge',
    eventName: 'fulfillment.recorded.v1',
    metricName: 'fulfillment_recorded_bronze_write_total',
  },
  // AD-1: the SHARED Meta+Google entity-metadata feed (ad.entity.updated) — connector-derived,
  // server-trusted brand_id, no install_token. Lands in Bronze for silver_campaign's authoritative dim.
  {
    groupIdEnv: 'AD_ENTITY_UPDATED_BRONZE_CONSUMER_GROUP_ID',
    defaultGroupId: 'ad-entity-updated-bronze-bridge',
    eventName: 'ad.entity.updated',
    metricName: 'ad_entity_updated_bronze_write_total',
  },
  // SHOPFLO lifecycle: the NEW Shopflo checkout-funnel canonicals (webhook-first, server-derived
  // brand_id, no install_token). Each lands in Bronze for silver_checkout_signal.
  {
    groupIdEnv: 'SHOPFLO_CHECKOUT_STARTED_BRONZE_CONSUMER_GROUP_ID',
    defaultGroupId: 'shopflo-checkout-started-bronze-bridge',
    eventName: 'shopflo.checkout_started.v1',
    metricName: 'shopflo_checkout_started_bronze_write_total',
  },
  {
    groupIdEnv: 'SHOPFLO_CHECKOUT_STEP_BRONZE_CONSUMER_GROUP_ID',
    defaultGroupId: 'shopflo-checkout-step-bronze-bridge',
    eventName: 'shopflo.checkout_step.v1',
    metricName: 'shopflo_checkout_step_bronze_write_total',
  },
  {
    groupIdEnv: 'SHOPFLO_CHECKOUT_COMPLETED_BRONZE_CONSUMER_GROUP_ID',
    defaultGroupId: 'shopflo-checkout-completed-bronze-bridge',
    eventName: 'shopflo.checkout_completed.v1',
    metricName: 'shopflo_checkout_completed_bronze_write_total',
  },
];

/**
 * Build one EventBronzeBridgeConsumer per registry entry. main.ts starts + stops the returned array
 * in a loop, so coverage is structural (no per-bridge hand-wiring to forget).
 */
export function buildBronzeBridges(deps: {
  kafka: Kafka;
  processEvent: ProcessEventUseCase;
  topic: string;
  retryCounter: IRetryCounter;
}): EventBronzeBridgeConsumer[] {
  return BRONZE_BRIDGES.map(
    (def) =>
      new EventBronzeBridgeConsumer(
        deps.kafka,
        deps.processEvent,
        deps.topic,
        // intentional raw: groupIdEnv is a DYNAMIC env-var name from the registry, not a fixed field.
        process.env[def.groupIdEnv] ?? def.defaultGroupId,
        deps.retryCounter,
        def.eventName,
        def.metricName,
      ),
  );
}
