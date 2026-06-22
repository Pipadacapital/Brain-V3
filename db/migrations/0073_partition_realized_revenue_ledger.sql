-- 0073_partition_realized_revenue_ledger.sql
--
-- DB-AUDIT C4b — RANGE-partition the money ledger billing.realized_revenue_ledger. This is the
-- unbounded append-only table of record for realized revenue; it grows per (order × recognition
-- event) forever. Same PROVEN twin-swap template as 0072 (dq_check_result): build a partitioned
-- twin, copy data, recreate indexes + RLS + grants + the currency trigger, then atomically swap.
-- Retention/archival becomes a partition DROP (O(1)); reporting queries prune by time.
--
-- PARTITION KEY — occurred_date (an app-set NOT NULL `date` column, NEW here). PostgreSQL forbids a
-- GENERATED column as a partition key, forbids a BEFORE trigger from setting the partition key (the
-- row is routed before the trigger runs), and forbids an EXPRESSION partition key from carrying a
-- PK/UNIQUE. The day-grain dedup the ledger needs (one row per brand/order/event_type/UTC-day) is an
-- EXPRESSION of occurred_at — which a partitioned UNIQUE index may not use, because such an index must
-- include the bare partition-key column. Resolving all three: occurred_date is a real stored column
-- the writers set, it IS the partition key, AND it IS the day-grain dedup column — one column, every
-- constraint satisfied. A CHECK pins it to timezone('UTC', occurred_at)::date so any writer drift FAILS
-- LOUDLY (never a silent money double-count) — this is the safety net that de-risks the whole change.
--
-- KEY WIDENING — the PK becomes (brand_id, ledger_event_id, occurred_date) and the dedup UNIQUE becomes
-- (brand_id, order_id, event_type, occurred_date) WHERE event_type <> 'refund' (semantics IDENTICAL —
-- occurred_date == the old timezone('UTC', occurred_at)::date expression). Every writer/seed ON CONFLICT
-- was updated in lockstep: the dedup-tuple clauses now name occurred_date, and the refund path's
-- PK-based ON CONFLICT (brand_id, ledger_event_id) gains occurred_date. occurred_date is deterministic
-- from each event's economic time, so dedup/idempotency is preserved exactly across re-pulls.
--
-- Index names carry a `_p` suffix (realized_revenue_ledger_dedup_p / idx_rrl_asof_p): the legacy table
-- keeps the canonical names through the post-deploy verify window; ON CONFLICT inference matches on the
-- index's columns+predicate, not its name, so this is transparent to writers.
--
-- PROD partition management: a monthly create-ahead + drop-old routine (pg_partman or cron) maintains
-- partitions; here we seed the data range (2026-05..2026-07) + a DEFAULT so dev + a fresh prod both work.
-- DEPLOY: self-contained (copy+swap in one txn); node-pg-migrate wraps it, or apply with `psql -1`.

-- ── 1. Partitioned twin ──────────────────────────────────────────────────────────────────────────
CREATE TABLE billing.realized_revenue_ledger_part (
  brand_id                   uuid                     NOT NULL,
  ledger_event_id            text                     NOT NULL,
  order_id                   text                     NOT NULL,
  brain_id                   uuid,
  event_type                 text                     NOT NULL,
  amount_minor               bigint                   NOT NULL,
  currency_code              character(3)             NOT NULL,
  fx_rate_id                 uuid,
  rounding_adjustment_minor  bigint                   NOT NULL DEFAULT 0,
  occurred_at                timestamptz              NOT NULL,
  occurred_date              date                     NOT NULL,
  economic_effective_at      timestamptz              NOT NULL,
  billing_posted_period      character(7)             NOT NULL,
  recognition_label          text                     NOT NULL,
  supersedes_ledger_event_id text,
  settlement_source          text,
  maturity_state             text,
  ledger_snapshot_id         text,
  raw_event_id               text,
  created_at                 timestamptz              NOT NULL DEFAULT now(),
  reconciliation_type        text,
  tax_code                   text,
  fee_minor                  bigint,
  PRIMARY KEY (brand_id, ledger_event_id, occurred_date),
  CONSTRAINT realized_revenue_ledger_billing_posted_period_check
    CHECK (billing_posted_period ~ '^\d{4}-\d{2}$'),
  CONSTRAINT realized_revenue_ledger_occurred_date_check
    CHECK (occurred_date = (timezone('UTC'::text, occurred_at))::date),
  CONSTRAINT realized_revenue_ledger_event_type_check
    CHECK (event_type = ANY (ARRAY[
      'provisional_recognition','finalization','rto_reversal','refund','chargeback','cancellation',
      'settlement_fee_reversal','marketplace_adjustment','payment_adjustment','concession',
      'settlement_finalization','payment_fee','settlement_tax','rolling_reserve_deduction',
      'rolling_reserve_release','settlement_reversal','settlement_adjustment','cod_rto_clawback',
      'cod_delivery_confirmed'])),
  CONSTRAINT realized_revenue_ledger_recognition_label_check
    CHECK (recognition_label = ANY (ARRAY['provisional','settling','finalized'])),
  CONSTRAINT realized_revenue_ledger_reconciliation_type_check
    CHECK (reconciliation_type IS NULL OR (reconciliation_type = ANY (ARRAY['per_order','brand_level'])))
) PARTITION BY RANGE (occurred_date);

-- Time partitions (seed: the existing data range + near-future) + a DEFAULT so no row is ever rejected.
CREATE TABLE billing.realized_revenue_ledger_p2026_05 PARTITION OF billing.realized_revenue_ledger_part
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE billing.realized_revenue_ledger_p2026_06 PARTITION OF billing.realized_revenue_ledger_part
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE billing.realized_revenue_ledger_p2026_07 PARTITION OF billing.realized_revenue_ledger_part
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE billing.realized_revenue_ledger_pdefault PARTITION OF billing.realized_revenue_ledger_part DEFAULT;

-- ── 2. Copy existing data (occurred_date derived from occurred_at — the same formula the CHECK pins) ──
INSERT INTO billing.realized_revenue_ledger_part (
  brand_id, ledger_event_id, order_id, brain_id, event_type, amount_minor, currency_code, fx_rate_id,
  rounding_adjustment_minor, occurred_at, occurred_date, economic_effective_at, billing_posted_period,
  recognition_label, supersedes_ledger_event_id, settlement_source, maturity_state, ledger_snapshot_id,
  raw_event_id, created_at, reconciliation_type, tax_code, fee_minor)
SELECT
  brand_id, ledger_event_id, order_id, brain_id, event_type, amount_minor, currency_code, fx_rate_id,
  rounding_adjustment_minor, occurred_at, (timezone('UTC'::text, occurred_at))::date, economic_effective_at,
  billing_posted_period, recognition_label, supersedes_ledger_event_id, settlement_source, maturity_state,
  ledger_snapshot_id, raw_event_id, created_at, reconciliation_type, tax_code, fee_minor
FROM billing.realized_revenue_ledger;

-- ── 3. Recreate ancillary indexes + RLS + grants + currency trigger on the twin ────────────────────
-- Dedup arbiter (partial UNIQUE — excludes refund; refunds dedup on the PK). occurred_date replaces the
-- old timezone('UTC', occurred_at)::date expression; identical semantics. `_p` name avoids colliding
-- with the legacy table's canonical index name during the verify window.
CREATE UNIQUE INDEX realized_revenue_ledger_dedup_p
  ON billing.realized_revenue_ledger_part (brand_id, order_id, event_type, occurred_date)
  WHERE event_type <> 'refund';

-- As-of realized-revenue scan index (mirrors idx_rrl_asof: excludes provisional rows).
CREATE INDEX idx_rrl_asof_p
  ON billing.realized_revenue_ledger_part (brand_id, economic_effective_at)
  WHERE event_type <> 'provisional_recognition';

ALTER TABLE billing.realized_revenue_ledger_part ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.realized_revenue_ledger_part FORCE ROW LEVEL SECURITY;
CREATE POLICY realized_revenue_ledger_isolation ON billing.realized_revenue_ledger_part
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);

REVOKE ALL ON billing.realized_revenue_ledger_part FROM brain_app;
GRANT SELECT, INSERT ON billing.realized_revenue_ledger_part TO brain_app;  -- append-only by grant (no UPDATE/DELETE)

-- Currency-matches-brand guard (BEFORE INSERT). The function only validates NEW.currency_code against
-- the brand; it does NOT touch the partition key, so it is safe on a partitioned parent (PG 16 cascades
-- parent-level row triggers to every partition).
CREATE TRIGGER trg_ledger_currency
  BEFORE INSERT ON billing.realized_revenue_ledger_part
  FOR EACH ROW EXECUTE FUNCTION public.ledger_currency_matches_brand();

-- ── 4. Atomic swap ─────────────────────────────────────────────────────────────────────────────────
ALTER TABLE billing.realized_revenue_ledger      RENAME TO realized_revenue_ledger_legacy;
ALTER TABLE billing.realized_revenue_ledger_part RENAME TO realized_revenue_ledger;

-- ── 5. Guards ────────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE legacy_n bigint; new_n bigint; is_part boolean; bad_dates bigint;
BEGIN
  SELECT relkind = 'p' INTO is_part FROM pg_class WHERE oid = 'billing.realized_revenue_ledger'::regclass;
  IF NOT is_part THEN RAISE EXCEPTION '0073: realized_revenue_ledger must be PARTITIONED after swap'; END IF;

  SELECT count(*) INTO legacy_n FROM billing.realized_revenue_ledger_legacy;
  SELECT count(*) INTO new_n    FROM billing.realized_revenue_ledger;
  IF new_n <> legacy_n THEN
    RAISE EXCEPTION '0073: row count mismatch after copy (legacy=%, new=%)', legacy_n, new_n;
  END IF;

  -- Belt-and-suspenders: every copied row's occurred_date must equal the CHECK formula (the CHECK would
  -- already have rejected any violation; this makes a wrong copy a loud failure rather than a silent one).
  SELECT count(*) INTO bad_dates FROM billing.realized_revenue_ledger
    WHERE occurred_date <> (timezone('UTC'::text, occurred_at))::date;
  IF bad_dates <> 0 THEN
    RAISE EXCEPTION '0073: % rows have occurred_date <> timezone(UTC, occurred_at)::date', bad_dates;
  END IF;
END $$;

-- billing.realized_revenue_ledger_legacy is retained for a post-deploy verification window; DROP it in a
-- follow-up migration once the partitioned table is confirmed serving reads + writes in prod.
