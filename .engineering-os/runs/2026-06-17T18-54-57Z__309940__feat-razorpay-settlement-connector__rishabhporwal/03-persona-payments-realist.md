# Persona Review — Payments / Settlement-Reconciliation Realist
**Req ID:** feat-razorpay-settlement-connector
**Persona:** Payments / Settlement-Reconciliation Realist (India, Razorpay domain)
**Skill loaded:** `integration-connectors`
**Tier:** `:sonnet` (open-ended reasoning — Razorpay API reality vs. requirement assumptions)
**Written at:** 2026-06-17T19:30:00Z
**Decision:** PASS (with concerns — Architect must address all before design is finalised)

---

## Journal stub

```
## 2026-06-17T19:30:00Z — Persona:PAYMENTS_REALIST — feat-razorpay-settlement-connector
Angle: Razorpay settlement data reality vs. architectural assumptions · Top concern: order_id is NOT reliably present in Razorpay settlement items — the entire join strategy in MB-1 rests on an optimistic assumption about a field that Razorpay marks optional · Severity: H
```

---

## 1. Angle and lens

I am pressure-testing the **messy ground truth of Razorpay settlement data and the reconciliation logic that depends on it**. The requirement and the CTO intake are architecturally tidy. Razorpay's actual settlement API is not. This review surfaces the five places where the requirement's assumptions collide with what Razorpay actually returns — and what goes wrong if the Architect designs for the optimistic case.

---

## 2. Concrete concerns

### RISK-P1 (CRITICAL): order_id is NOT guaranteed in Razorpay settlement items — the MB-1 join strategy is built on an optional field

**The risk:** The requirement states "join on order_id when Razorpay carries it, else payment_id→order mapping." The CTO intake elevates this to MB-1 and asks the Architect to confirm whether `order_id` is reliably present. The answer from Razorpay's actual settlement data is: **it is not**.

Razorpay's Settlements API (`GET /v1/settlements`) returns a settlement-level object. The per-payment breakdown lives in `GET /v1/settlements/{id}/recon/combined` or the settlement report download. In the combined reconciliation endpoint, each line item carries:
- `payment_id` — always present
- `order_id` — **present only when the payment was created via a Razorpay Order** (i.e., the merchant created an order with `POST /v1/orders` first and linked the payment to it). For payments created via the payment link flow, the checkout-only flow, or subscriptions, `order_id` is null or absent.

For a Shopify DTC brand on Razorpay, the Shopify checkout creates the Razorpay order via its native integration. This means `order_id` **is** typically present for standard Shopify-Razorpay checkouts. However:

- COD orders do NOT go through Razorpay at all — they never appear in settlements (no concern here).
- Shopify's Razorpay payment integration creates a Razorpay Order for each checkout. The Razorpay `order_id` here is a Razorpay-native ID (`order_XXXX`), NOT the Shopify order ID. Brain's provisional ledger rows are keyed by Shopify order ID, not by Razorpay order ID.
- This means even when `order_id` is present in the settlement item, it is **a Razorpay order ID (`order_XXXX`)**, not the Shopify `order_id` (`#1001` / gid). The join `settlement.order_id → ledger.order_id` WILL FAIL unless there is an explicit mapping table `razorpay_order_id → shopify_order_id`.

**The actual join chain needed:**
```
Razorpay settlement item: payment_id → order_id (razorpay, optional)
                           ↓
Mapping table: razorpay_order_id → shopify_order_id  (must be populated from payment webhooks at capture time)
                           ↓
Brain ledger: shopify_order_id (the provisional row key from the Shopify connector)
```

If the mapping table does not exist or is not populated before the settlement arrives, reconciliation fails silently or creates an unmatched settlement. The requirement gestures at a `razorpay_payment_order_map` table but does not make this ID-type mismatch explicit. The CTO intake's MB-1 also misses it — it asks "is there a payment_id→order_id mapping" but does not distinguish between Razorpay order IDs and Shopify order IDs.

**Severity: CRITICAL — HIGH**
**Recommended binding for Architect:**
- Bind explicitly: the join key on the Brain ledger side is `shopify_order_id`. The settlement item carries `razorpay_order_id`. A mapping table `connector_razorpay_order_map(brand_id, razorpay_order_id, shopify_order_id, razorpay_payment_id)` must be populated at webhook `payment.captured` time (before any settlement arrives). The reconciliation consumer joins through this table, never directly on `order_id`.
- The case where `order_id` is absent in the settlement item resolves via `razorpay_payment_id → razorpay_order_id → shopify_order_id` (two-hop through the mapping table).
- If the mapping table has no row for a given `payment_id` (payment webhook never received or not yet processed), the settlement event is parked, not silently dropped. A metric `settlement_unmatched_count` must be emitted and monitored.

---

### RISK-P2 (HIGH): Rolling-reserve deduction and rolling-reserve RELEASE are different settlement events — the fee decomposition model collapses them incorrectly

**The risk:** Razorpay's rolling reserve mechanism works in two phases:
1. **Reserve deduction:** when a payment settles, Razorpay withholds a % (typically 5–10% for new/high-risk brands) from the settled amount. This reduces the net payout but is NOT a fee — it is a temporarily held float that will be returned.
2. **Reserve release:** 90–180 days later, Razorpay releases the withheld amount in a separate settlement with a different settlement_id. This release is a POSITIVE inflow with no corresponding order.

The requirement's fee decomposition model (`settlement_finalization` + `payment_fee` + `settlement_reversal`) and the CTO intake's MB-3 table lists "rolling_reserve deducted → payment_fee (or `rolling_reserve_deduction`?) | - | reserve amount" — but this is wrong in two ways:

1. **A reserve deduction is NOT a fee.** It is a timing difference: the money comes back. Booking it as `payment_fee` (a permanent negative) overstates the cost. The net realized revenue will be understated by the reserve amount until the release posts, and no correction will fire because the `payment_fee` row has no mechanism to match to a future release.
2. **The reserve release arrives as a standalone settlement** with its own `settlement_id`, containing no `payment_id` or `order_id` at all (it is a bulk release of held funds). The reconciliation consumer cannot join it to any order row. If the consumer expects every settlement item to have a `payment_id`, the release event will be unprocessable.

For Boddactive and similar India DTC brands with 15–35% total fee structures, rolling reserve can represent 5–10% of GMV held for 3–6 months. At scale this is a material reconciliation error.

**Severity: HIGH**
**Recommended binding for Architect:**
- Define a distinct event_type `rolling_reserve_deduction` (sign: -, represents held float, NOT a permanent cost) and `rolling_reserve_release` (sign: +, the corresponding return). These must NOT be `payment_fee`.
- Reserve releases arrive as settlement-level events with no order join key. The consumer must handle order-keyless settlement events as a standalone ledger row against the brand's "reserve balance" account, not attempt a per-order reconciliation.
- The ledger schema needs a `reconciliation_type` enum that distinguishes `per_order` (has a join key) from `brand_level` (no join key — rolling reserve release, adjustment settlements). The billing module must understand that `rolling_reserve_deduction` reduces the period's net cash but will reverse in a future period.

---

### RISK-P3 (HIGH): The 30-day re-pull window is too short for rolling-reserve releases and chargeback cycles

**The risk:** The requirement states a "trailing 30-day re-pull window (settlements correct/arrive late)" mirroring the Shopify 35-day window. The 30-day assumption is correct for ordinary payment settlements (T+2 for most Razorpay settlements, T+1 for some). It is NOT correct for:

1. **Rolling reserve releases:** released 90–180 days after the original settlement. A 30-day window will NEVER pull a reserve release if the release settlement was created more than 30 days ago. The cursor high-water advances past the release date and it is permanently missed.
2. **Chargeback reversals:** a payment challenged at month 3 may generate a chargeback settlement reversal at month 4–5 (after the bank dispute cycle completes). The 30-day window will not catch this.
3. **Razorpay adjustment settlements:** Razorpay occasionally issues bulk correction settlements (e.g. fee recalculations, error corrections). These appear as new settlement_ids but reference payment_ids that are months old. A 30-day cursor re-pull misses them.

The result is that Brain's realized revenue number for a given order becomes permanently stale — the reserve release never posts, the chargeback reversal never posts, and the bill remains incorrect.

**Severity: HIGH**
**Recommended binding for Architect:**
- The re-pull window must be split by settlement_type. For standard payment settlements: 30 days is correct. For reserve release and chargeback/dispute settlements: the connector must either (a) maintain a separate long-tail cursor with a 180-day window, or (b) treat reserve releases and chargeback settlements as a separate polling endpoint (`GET /v1/settlements?type=reserve_release`) with its own cursor that never ages out under 180 days.
- Alternatively: the settlement report (downloaded file) contains all settlement types in one place; if the connector uses the report download rather than the API, the window concern is mitigated — but the report download has its own pagination and retry complexity.
- The dual-date rule (MB-7) partially mitigates billing impact: if `economic_effective_at` = settlement date and closed periods are immutable, a late reserve release posts forward. But the CASH FLOW view (what did we actually receive?) will be wrong until the release posts. The architect must decide whether the cash-flow view is in scope for this slice.

---

### RISK-P4 (HIGH): Idempotency under correction — uuidv5(settlement_id) WILL collapse a Razorpay-corrected settlement into the original, silently dropping the correction

**The risk:** This is the idempotency-under-correction trap. Razorpay, in practice, does NOT issue a corrected settlement with the SAME `settlement_id`. When Razorpay corrects a settlement (e.g. fee recalculation error, disputed amount adjusted), it issues one of two mechanisms:

**Mechanism A (more common):** Razorpay creates a NEW settlement_id for the correcting entry. The original settlement_id remains in the system unchanged. In this case, `uuidv5(brand:settlement_id:settlement.live.v1)` correctly treats the correction as a distinct event. No dedup collision. This is the common case.

**Mechanism B (less common but documented):** For certain types of corrections (particularly fee adjustments under Razorpay's fee revision cycles), Razorpay issues a credit/debit NOTE against the original settlement, which appears in the settlement report as a line item referencing the original `settlement_id` but with a different `entity_type` or a negative `amount`. If the connector event_id seed is `brand:settlement_id:settlement.live.v1`, BOTH the original and the correction map to the same event_id. The second write (the correction) hits `ON CONFLICT DO NOTHING` and is silently dropped.

The requirement states the uuidv5 seed as "brand:settlement_id:..." but does not specify what disambiguates a per-payment line item within the settlement from a correction line item referencing the same settlement_id.

The CTO intake's MB-2 notes this risk for settlement-level vs per-payment-item granularity but frames it as a schema question, not a correction-collapse question. The more dangerous scenario is: the Architect picks a seed of `brand:settlement_id` (settlement-level dedup), a correction arrives referencing the same `settlement_id` with a corrected amount, and `ON CONFLICT DO NOTHING` silently absorbs the correction. The ledger is now permanently wrong for that settlement, and no alert fires.

**Severity: HIGH**
**Recommended binding for Architect:**
- The event_id seed must include the **settlement report line item sequence or a type discriminator**, not just the settlement_id. Proposed: `uuidv5("${brandId}:${settlementId}:${paymentId}:${entityType}:settlement.live.v1")` where `entityType` differentiates `payment`, `refund`, `adjustment`, `reserve_deduction`. For settlement-level summary events (no payment_id), use `uuidv5("${brandId}:${settlementId}:summary:settlement.live.v1")`.
- This means the dedup unit is settlement+payment+type, not settlement alone. A correction that arrives as a new line item referencing the same settlement_id but with a different `entityType=adjustment` gets a unique event_id and lands correctly.
- The `ON CONFLICT DO NOTHING` remains correct at the Bronze level (truly identical line items are fine to dedup). The fix is in the seed, not in switching to ON CONFLICT DO UPDATE.

---

### RISK-P5 (MEDIUM): GST on Razorpay fees is a SEPARATE tax line in the settlement report and must not be collapsed into MDR — it has India-specific compliance implications

**The risk:** Razorpay settlement reports decompose fees into:
- `fee` — the MDR / processing fee (18% GST NOT included)
- `tax` — GST charged on the fee (currently 18% of `fee`)
- `settlement_amount` — what actually lands in the merchant's bank account (gross - fee - tax - reserve)

The requirement correctly names `fee` and `tax` as fields. The CTO intake's MB-3 asks whether GST should be a separate event_type (`settlement_tax`). The answer from the India payments compliance lens is: **yes, it should be separate, and here is why it matters beyond just auditability:**

1. **GST input credit**: Indian GST-registered businesses can claim input tax credit on the GST they pay on payment gateway fees. If Brain collapses `fee + tax` into a single `payment_fee` ledger row, the GST component is not queryable for ITC claims. For Boddactive as a GST-registered entity, this is a meaningful amount (18% of MDR, which is itself 1.5–3% of GMV, so 0.27–0.54% of GMV in claimable ITC). The billing module needs to separate this.
2. **Razorpay GST invoice**: Razorpay issues a separate monthly GST invoice for the tax charged. The settlement report `tax` field is the underlying data; if it is not preserved separately, reconciling the settlement report against Razorpay's GST invoice becomes impossible.
3. **Future compliance exposure**: Under India's GST regime, businesses that file GSTR-2B must reconcile supplier credits. If Brain's ledger collapses tax into fees, the brands using Brain for financial data cannot reconcile their GSTR without going back to raw Razorpay reports.

**Severity: MEDIUM** (does not break revenue correctness today; does create compliance debt and ITC reconciliation impossibility)
**Recommended binding for Architect:**
- Bind `settlement_tax` as a distinct event_type in the ledger (sign: -, amount: `tax` field from Razorpay in INR minor units, with `tax_code: 'GST_18'`). Do NOT collapse into `payment_fee`.
- The full event_type taxonomy: `settlement_finalization` (+ net settled amount), `payment_fee` (MDR/processing fee), `settlement_tax` (GST on fee), `rolling_reserve_deduction` (- held float), `rolling_reserve_release` (+ returned float), `settlement_reversal` (refund or chargeback, negative).

---

### RISK-P6 (MEDIUM): Razorpay settlement timing for India prepaid brands — the T+2 assumption may hold, but the real long-tail risk is the settlement BATCH, not the individual payment

**The risk:** The requirement and CTO intake treat settlement timing as "settlements arrive/correct days after capture." The actual timing is:

- Standard prepaid (card/UPI/netbanking): **T+2 business days** from payment capture. The 30-day re-pull window is vastly more than enough for the payment settlement itself.
- The risk is NOT lateness of individual payments — it is that Razorpay settles in **daily batch settlements** that aggregate all payments captured in a 24-hour window. If the connector pulls settlements daily, it will catch all standard payments within 3 days.
- The real long-tail cases are reserve releases (180 days), chargebacks (90–150 days), and adjustment settlements (unpredictable).

The 30-day re-pull window is **correct for the common case** (standard payment settlements) but **wrong for the exception cases** (reserve releases, chargebacks). The requirement's design would have the connector miss these exception cases not because of the window size for standard settlements, but because the same cursor logic is applied uniformly.

This is a refinement of RISK-P3 but with a clearer statement: the problem is not that 30 days is too short overall — it is that the connector uses ONE cursor for ALL settlement types, when different types have materially different late-arrival profiles.

**Severity: MEDIUM**
**Recommended binding for Architect:**
- Use a multi-cursor strategy: `cursor_settlements_payments` (30-day window, daily) + `cursor_settlements_reserves` (180-day window, weekly) + `cursor_settlements_adjustments` (90-day window, weekly). Each cursor is a separate row in `connector_cursor` with a distinct `resource` field. The re-pull job processes all three cursors per brand per run.

---

## 3. Concerns NOT found (where the requirement holds up)

- **HMAC-first validation:** correctly specified. Razorpay uses `HMAC-SHA256(raw_body, webhook_secret)` exactly as described. The X-Razorpay-Signature header is the correct header. This is a non-issue.
- **Integer minor units:** correctly specified. Razorpay returns `amount` in paisa (INR minor units) in all API responses. No float conversion needed.
- **Per-settlement vs per-payment reconciliation unit:** the requirement's implicit choice (per-payment, driven by the order join) is correct. A per-settlement row would lose per-order granularity. The CTO intake's MB-3 correctly flags this as a binding decision.
- **Brand resolution from connector_instance (never webhook body):** correctly specified and correctly important. Razorpay webhook payloads do not carry a reliable brand identifier; resolving from the account_id→connector_instance mapping is the only safe approach.

---

## 4. Impact on existing MB-1..MB-7

| CTO Intake Item | Impact from this review |
|---|---|
| MB-1 (join key + late arrival) | AMPLIFIED: the join is a 2-hop chain (razorpay_order_id → shopify_order_id) that the intake missed. The mapping table spec must distinguish Razorpay order IDs from Shopify order IDs. |
| MB-2 (uuidv5 seed) | REFINED: seed must include entityType discriminator, not just settlement_id + payment_id, to survive correction events. |
| MB-3 (fee decomposition) | EXPANDED: needs `rolling_reserve_deduction`, `rolling_reserve_release`, `settlement_tax` as distinct event_types. MB-3's current table is incomplete. |
| MB-4 (consumer class) | No change from this lens. |
| MB-5 (SECURITY DEFINER fn) | No change from this lens. |
| MB-6 (dev scheduler trigger) | No change from this lens. |
| MB-7 (dual-date + billing period) | REFINED: reserve releases and chargebacks that arrive 90–180 days late will always post to the current open period (correct per the dual-date rule); but the cash-flow view will be stale until they arrive. The Architect should document this explicitly in the dev guide. |

---

## HANDOFF

**Decision: PASS** — concerns are real but do not kill the requirement; they must be resolved by the Architect before implementation begins.

| id | severity | risk | recommended architect binding |
|---|---|---|---|
| RISK-P1 | CRITICAL | `order_id` in Razorpay settlement items is a Razorpay-native order ID (`order_XXXX`), NOT the Shopify order ID. The join to the Brain ledger requires a two-hop mapping table `razorpay_order_id → shopify_order_id`, populated at `payment.captured` webhook time. Without this, the reconciliation join fails for every settlement — silently. | Architect must spec the `connector_razorpay_order_map(brand_id, razorpay_order_id, shopify_order_id, razorpay_payment_id)` table as a prerequisite to the SettlementLedgerConsumer. MB-1 must be rewritten to acknowledge the Razorpay-vs-Shopify order ID distinction. |
| RISK-P2 | HIGH | Rolling-reserve deductions and releases are NOT fees — they are a timing float that reverses. Booking them as `payment_fee` overstates costs and leaves the release event (which has no order join key) unprocessable by the current consumer design. | Architect must define `rolling_reserve_deduction` and `rolling_reserve_release` as distinct event_types. The SettlementLedgerConsumer must handle order-keyless settlement events (brand-level, no per-order join) for reserve releases and adjustment settlements. |
| RISK-P3 | HIGH | The 30-day re-pull window is insufficient for reserve releases (90–180 days) and chargeback reversals (90–150 days). A single cursor that advances past these settlement dates will permanently miss them. | Architect must implement a multi-cursor strategy: one cursor per settlement category (`payments`, `reserves`, `adjustments`) with appropriate window widths. Or use the settlement report download (which captures all types) with a separate long-tail cursor. |
| RISK-P4 | HIGH | If Razorpay issues a correction that appears as a new line item referencing an existing `settlement_id` (same ID, different amount/type), `uuidv5(brand:settlement_id)` collapses the correction into the original and `ON CONFLICT DO NOTHING` silently drops the corrected value. The ledger is permanently wrong with no alert. | Architect must include `entityType` (payment / refund / adjustment / reserve) in the uuidv5 seed: `uuidv5("${brandId}:${settlementId}:${paymentId}:${entityType}:settlement.live.v1")`. This is a prerequisite to finalising MB-2. |
| RISK-P5 | MEDIUM | GST on Razorpay fees (`tax` field) must be a separate `settlement_tax` event_type. Collapsing it into `payment_fee` makes GST input credit reconciliation impossible for India GST-registered brands and prevents matching against Razorpay's monthly GST invoice. | Architect must add `settlement_tax` to the event_type taxonomy in MB-3. The field carries `tax_code: 'GST_18'`. |
| RISK-P6 | MEDIUM | The single-cursor 30-day re-pull conflates standard payment settlements (T+2, 30 days is fine) with exception settlement types (reserve releases, chargebacks, adjustments) that arrive months later. | Refine MB-1's late-arrival policy and the cursor design to acknowledge the multi-type settlement universe. Multi-cursor approach (per settlement category) is the cleanest binding. |

**Bottom line:** The most dangerous assumption in this requirement is that `order_id` in the Razorpay settlement report is the Shopify order ID — it is not. Every other concern is serious but recoverable at design time. This one, if unaddressed, means the settlement connector writes zero correctly-reconciled ledger rows in production, silently.
