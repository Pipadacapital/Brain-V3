-- 0097_realized_revenue_ledger_payment_method.sql
--
-- Persist payment_method on the realized-revenue ledger — closes the GAP-2 finalization in-flight-COD
-- residual.
--
-- BACKGROUND: every order writes a provisional_recognition row; COD revenue is recognized SEPARATELY
-- on delivery (cod_delivery_confirmed) and must NEVER be finalized (else realized double-counts). The
-- finalization job (apps/stream-worker/src/jobs/revenue-finalization.ts) discriminates COD from prepaid
-- by the PRESENCE of a cod_* event — which is reliable for RESOLVED COD orders but NOT for an in-flight
-- COD order that has emitted no cod_* event yet (lost in transit / RTO not yet recorded) past the
-- horizon: it is then indistinguishable from prepaid and would wrongly finalize (overstate revenue).
--
-- FIX: the order's payment method is KNOWN at provisional-write time (OrderEventConsumer.toPaymentMethod
-- / LedgerWriter.BackfillOrderForLedger.paymentMethod) but was dropped. This column persists it so the
-- finalization job filters payment_method='prepaid' (COD never finalizes here) and uses the correct
-- per-method horizon (prepaid 7d vs the conservative cod fallback for legacy NULL rows).
--
-- ADDITIVE + nullable: existing writers that don't set it leave NULL (finalization falls back to the
-- cod-event-exclusion + cod-horizon path for NULL — the pre-0097 behavior, still safe). Reversible:
-- DROP COLUMN payment_method (after reverting the writers).
--
-- BACKFILL (best-effort, historical): a provisional row's order is COD iff it has any cod_* event;
-- otherwise treat it as prepaid. Forward rows get the authoritative value from the writer. The column
-- is partition-propagated automatically (RANGE-partitioned parent).

ALTER TABLE billing.realized_revenue_ledger
  ADD COLUMN IF NOT EXISTS payment_method text;

ALTER TABLE billing.realized_revenue_ledger
  DROP CONSTRAINT IF EXISTS realized_revenue_ledger_payment_method_check;
ALTER TABLE billing.realized_revenue_ledger
  ADD CONSTRAINT realized_revenue_ledger_payment_method_check
  CHECK (payment_method IS NULL OR payment_method IN ('cod', 'prepaid'));

-- Historical backfill of provisional_recognition rows (the only rows finalization reads).
UPDATE billing.realized_revenue_ledger p
   SET payment_method = CASE
     WHEN EXISTS (
       SELECT 1 FROM billing.realized_revenue_ledger c
        WHERE c.brand_id = p.brand_id AND c.order_id = p.order_id
          AND c.event_type IN ('cod_delivery_confirmed', 'cod_rto_clawback')
     ) THEN 'cod'
     ELSE 'prepaid'
   END
 WHERE p.event_type = 'provisional_recognition'
   AND p.payment_method IS NULL;
