# Feature Journal — feat-realized-revenue-ledger

## 2026-06-16T19:05:00Z — Stage 2 Architecture (ADVANCE)
Money substrate: append-only realized_revenue_ledger (event_type discriminator). Four load-bearing walls bound:
1. Append-only BY GRANT (brain_app SELECT+INSERT only, migration-asserted) — not convention.
2. No-double-count NAMED fn realized_gmv_as_of (excludes provisional_recognition) — sole as-of path.
3. Dual-date immutability (occurred_at + economic_effective_at + billing_posted_period CHAR(7); late reversal → new current-period row, closed period untouched).
4. No-float BIGINT (all *_minor BIGINT; lint covers .ts only → migration DO-block asserts SQL side).
Bindings: D-1 horizon cols (25d COD/7d prepaid on brand), D-2 immutability-by-grant (CRITICAL), D-3 named as-of fn, D-4 dedup UNIQUE(brand_id,order_id,event_type,occurred_at::date) (CRITICAL), D-6 currency trigger, D-7 banker's rounding + rounding_adjustment_minor. D-5 reconciliation tolerance = Data-Engineer Sprint-0 (non-blocking).
Migration 0018; recognition engine in core/measurement; finalization job = existing Argo type in stream-worker.
Single-track @data-engineer. Slices S1 migration → S2 engine → S3 job+reversals → S4 tests → DEPLOY (affected-only, NO canary). Branch feat/realized-revenue-ledger off master. No new ADR.
Next: @data-engineer Stage 3.

## 2026-06-16T23:30:00Z — Data Engineer — feat-realized-revenue-ledger
**Stage:** 3 · **Layer:** lakehouse/batch · **Tier:** deterministic (tier-0, $0/mo, 0 tokens)
**Parity:** N/A (metric engine not built yet — realized_gmv_as_of() is the seam) · **Replayable:** yes (Bronze → ledger rebuild)

### Slices delivered
- **S1 d4e046f:** Migration 0018 — brand cols (cod_recognition_horizon_days INT DEFAULT 25, prepaid_recognition_horizon_days INT DEFAULT 7, currency_code CHAR(3) DEFAULT 'INR'), realized_revenue_ledger table (amount_minor + rounding_adjustment_minor BIGINT, dual-date occurred_at/economic_effective_at/billing_posted_period CHAR(7)), RLS FORCE two-arg fail-closed, brain_app SELECT+INSERT only, dedup UNIQUE(brand_id,order_id,event_type,(timezone('UTC',occurred_at)::date)), BEFORE INSERT currency trigger, realized_gmv_as_of() STABLE SECURITY INVOKER (excludes provisional_recognition), 3 migration-time assertions (NN-1 two-arg, append-only grant, _minor-is-bigint). roundToMinorBankers added to @brain/money. Migration applied to dev PG; all assertions green.
- **S2 2fbdb55:** Recognition engine in apps/core/src/modules/measurement/internal/ — domain (LedgerEntry VO, RecognitionEvent, LedgerEventId SHA-256, RecognitionPolicy pure fn, RoundingPolicy banker's), application (RecognizeOrderCommand, PostReversalCommand, PostFinalizationCommand, GetRealizedGmvAsOfQuery — sole as-of path calling named fn), infrastructure (PgLedgerRepository: GUC-first txn, ON CONFLICT DO NOTHING, replay-suppression counter), interfaces (OrderEventConsumer Bronze adapter). Core typecheck EXIT 0.
- **S3 62e3e6b:** revenue-finalization.ts Argo job (sibling phone-guard-reeval.ts) — per-brand provisional scan (occurred_at + cod_horizon_days < NOW()), RTO pre-check, finalization-exists guard, deterministic ledger_event_id, ON CONFLICT DO NOTHING, billing_posted_period from NOW() (dual-date current period), supersedes_ledger_event_id links to provisional. stream-worker typecheck EXIT 0.
- **S4 fa8afdd:** 30/30 tests PASS under brain_app — closed-sum (provisional excluded, naive SUM=2× wrong), clawback (original row untouched), dual-date (July reversal→new row, UPDATE/DELETE→permission denied), no-float (BIGINT proven, lint fires on bad fixture), currency trigger (AED→rejected), isolation (cross-brand=0, no-GUC fail-closed, current_user=brain_app), replay (3×→1 row), banker's rounding (10 golden fixtures), horizon (COD 25d vs prepaid 7d).

### Load-bearing walls proven
1. **No-double-count:** realized_gmv_as_of excludes provisional; naive SUM is 2× wrong — function is load-bearing.
2. **Append-only-by-GRANT:** brain_app SELECT+INSERT only; UPDATE→permission denied; DELETE→permission denied (structural, not convention).
3. **Dual-date immutability:** Late reversal posts new current-period row; original June rows unchanged.
4. **No-float BIGINT:** amount_minor + rounding_adjustment_minor are BIGINT in DDL (migration assertion proven), in TS (bigint, @brain/money), in SQL (grep clean).

### Open items
- D-5: Reconciliation tolerance Sprint-0 freeze (non-blocking; external Shopify test not in M1 scope).
- Next slice: metric engine + parity oracle reading realized_gmv_as_of() — Intelligence Engineer.

**Verification:** `pnpm --filter @brain/money typecheck` EXIT 0 · `pnpm --filter @brain/core typecheck` EXIT 0 · `pnpm --filter @brain/stream-worker typecheck` EXIT 0 · 30/30 live PG tests PASS · Migration 0018 applied + 3 assertions green.
**Next:** READY-FOR-SECURITY
