/**
 * Journey Explorer — the Wave-B "journey deep-dive" surface (server shell).
 *
 * Two honest, read-only lenses onto the reconstructed journey:
 *   1. Trace an order — every touch that preceded a given order_id, in touch_seq order, plus the
 *      identity evidence that proves those touches belong to the same person (the "how do we know"
 *      panel). This is Journey-before-attribution made visible.
 *   2. Customer timeline — a single customer's (brain_id) newest-first event feed.
 *
 * All reads go through the BFF journey endpoints via the use-journey hooks (the sole read path) —
 * never the serving tier / the ledger directly. Every state is honest: nothing is searched until the user
 * submits, a no_data response renders an explained empty, and errors surface a support reference.
 */
import { JourneyExplorerContent } from './journey-explorer-content';

export const metadata = { title: 'Journey Explorer — Brain' };

export default function JourneyExplorerPage() {
  return <JourneyExplorerContent />;
}
