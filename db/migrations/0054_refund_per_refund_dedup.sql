-- 0054_refund_per_refund_dedup.sql
--
-- feat-shopify-refund-ledger-reversal: let realized_revenue_ledger hold ONE row PER REFUND.
--
-- The order-depth capture now lands an order's refunds in Bronze (payload.properties.refunds[]),
-- but they were never reversed in the Gold ledger — realized revenue stayed positive after a
-- refund (a revenue-truth gap). To write a 'refund' row per refund we hit the existing dedup:
--
--   realized_revenue_ledger_dedup = UNIQUE (brand_id, order_id, event_type, occurred_at::date)
--
-- which would COLLIDE for two refunds on the same order on the same day (the 2nd silently dropped),
-- and an aggregate-per-day approach would UNDER-count across order.live.v1 restatements (ON CONFLICT
-- keeps the first, smaller total). So: make the date-grain dedup PARTIAL — it no longer applies to
-- 'refund' rows. Per-refund idempotency instead rides the PRIMARY KEY (brand_id, ledger_event_id),
-- where ledger_event_id = sha256(brand‖order‖'refund'‖refund_id‖v1): a re-delivered refund (same
-- refund_id, carried on every order restatement) collapses to one row; two DISTINCT refunds coexist.
--
-- ADDITIVE + REVERSIBLE: the partial index covers every existing (non-refund) row exactly as before
-- (no refund rows exist yet), so the recreate is a no-op for current data. Rollback = recreate the
-- index without the WHERE clause.

-- DROP + recreate as PARTIAL (a unique index's predicate cannot be altered in place).
DROP INDEX IF EXISTS realized_revenue_ledger_dedup;
CREATE UNIQUE INDEX IF NOT EXISTS realized_revenue_ledger_dedup
  ON realized_revenue_ledger (brand_id, order_id, event_type, (timezone('UTC', occurred_at)::date))
  WHERE event_type <> 'refund';

-- ── Migration-time assertion: the index is partial (excludes refund) ─────────────
DO $$
DECLARE pred TEXT;
BEGIN
  SELECT pg_get_expr(i.indpred, i.indrelid)
    INTO pred
    FROM pg_class c
    JOIN pg_index i ON i.indexrelid = c.oid
   WHERE c.relname = 'realized_revenue_ledger_dedup';
  IF pred IS NULL OR pred NOT LIKE '%refund%' THEN
    RAISE EXCEPTION 'GUARD: realized_revenue_ledger_dedup must be PARTIAL excluding refund. Got predicate: %', pred;
  END IF;
END $$;
