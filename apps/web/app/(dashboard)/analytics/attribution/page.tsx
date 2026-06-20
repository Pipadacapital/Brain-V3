/**
 * Attribution page — server component shell (Phase 5, feat-attribution-ledger Track C).
 *
 * The stakeholder-visible payoff of Phase 5: attributed revenue BY CHANNEL with a 4-model
 * selector (first/last/linear/position-based), the reconciliation residual rendered
 * ALONGSIDE (the closed-sum parity oracle made visible), and per-channel ROAS
 * (attributed revenue ÷ ad spend — blending ad_spend_ledger). It reads ONLY via the
 * BFF → metric-engine sole read path (I-ST01 — the UI NEVER queries the credit ledger or
 * StarRocks directly). Every figure is engine-computed and deterministic (Tier-0).
 */
import { AttributionContent } from './attribution-content';

export const metadata = { title: 'Attribution — Brain' };

export default function AttributionPage() {
  return <AttributionContent />;
}
