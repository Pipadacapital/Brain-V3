/**
 * connector-auth-health.ts — P2.6: make connector auth-rejection LOUD (per-connector observability).
 *
 * The audit's one real correctness gap: when a connector's credential is rejected (Meta/Google token
 * expired, Shopify/Razorpay 401), the repull writes connector_sync_status.state='error' with a
 * RECONNECT_REQUIRED reason and RETURNS — it does not throw. So the ingest scheduler sees a SUCCESS
 * (no dispatch_error_total), and that connector's data (ad spend, settlement, orders) silently goes
 * stale until an operator happens to notice. There was no metric and no alert on this path.
 *
 * This emits one counter per rejection, labelled by provider, so the silent failure becomes a
 * first-class signal: connector_auth_rejected_total{provider}. The BrainConnectorAuthRejected alert
 * fires when it is non-zero — a connector needs reconnecting and its data is going stale RIGHT NOW.
 *
 * NOTE: this is the OBSERVABILITY half. Automatic token refresh (Meta long-lived-token exchange /
 * re-auth) is a separate feature that needs the provider app credentials + the connect flow; this
 * guard ensures that until that lands, the failure is never silent.
 */
import { incrementCounter } from '@brain/observability';

/** Canonical provider labels (match the connector_instance.provider values). */
export type ConnectorProvider = 'meta' | 'google_ads' | 'shopify' | 'razorpay' | 'gokwik' | 'shopflo';

/**
 * Record that a connector's credential was rejected (token expired / 401) and it now needs a
 * reconnect. Call this at every auth-error branch, alongside the sync_status='error' write.
 */
export function recordConnectorAuthRejected(provider: ConnectorProvider): void {
  incrementCounter('connector_auth_rejected_total', { provider });
}
