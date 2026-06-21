# Shiprocket — partner-gated surfaces (tracked blockers)

**Status:** Shiprocket is **complete to the limit of public documentation.** What remains is gated
on a real Shiprocket account / partner API docs, NOT on engineering. Per the no-fabrication
posture (deep-research *refuted* guessed schemas), none of the items below are built on assumed
field shapes — they are documented here and each carries a clearly-flagged seam in code.

## ✅ Done (on master)
- Canonical pipeline (Slice 1): `shiprocket.shipment_status.v1` → shared `@brain/logistics-status`
  `terminal_class` normalizer → `ShipmentLedgerConsumer` (cod_rto_clawback / cod_delivery_confirmed)
  → Bronze (server-trusted) → `silver_shipment_event` / `silver_shipment` → Logistics analytics surface.
- Auth: `ShiprocketTokenProvider` — login → 10-day JWT, cached + auto-relogin (verified public scheme).
- Live REST client **scaffold** (`shiprocket-client.ts`): dev=fixture / prod=HTTP, Bearer auth, paged,
  401→reconnect. Production-SHAPED; the list endpoint + response field names are env-configurable and
  flagged confirm-at-real-account (see below).

## ⚠️ Confirm-against-a-real-account (live read)
The live read path exists but these specifics are unverified in public docs — confirm, then they're
a CONFIG change (no code rewrite):
| Unknown | Code seam (env) | Default (assumed) |
|---|---|---|
| Shipment-list endpoint | `SHIPROCKET_SHIPMENTS_PATH` | `/v1/external/orders` |
| Response array key | `SHIPROCKET_SHIPMENTS_KEY` | `data` |
| Pagination params | (in `shiprocket-client.ts`) | `per_page`, `page`, `from`, `to` |
| Field names | defensive `pick()` map | awb/awb_code, channel_order_id/order_id, current_status/status, … |
| Numeric `current_status_id` → label map | `@brain/logistics-status` (status labels) | label strings only |

## ⛔ Partner-doc-blocked (not built — need real schemas)
Each would be additive (no redesign); reserved event names noted for when docs arrive:
1. **NDR detail** (`shiprocket.ndr.created.v1`) → `silver_delivery_attempt`. Need: NDR list/action
   payload (reason codes, attempt count, escalate/re-escalate fields).
2. **COD remittance** (`shiprocket.cod_remitted.v1`) → `realized_revenue_ledger` settlement events
   (like Razorpay). Need: remittance API fields (COD amount, UTR, status, expected/paid dates).
3. **Freight / shipping cost** → CM2 cost input (`cost_input`). Need: per-shipment freight/charge fields.
4. **Real-time tracking webhook** → collector `/collect` (HMAC). Need: the tracking-webhook payload
   shape + auth-header (X-Api-Key/token) verification (research explicitly refuted guesses here).

## To unblock
Provide a Shiprocket sandbox/account or partner API + webhook docs. Then: (a) confirm the live-read
config above, and (b) build the ⛔ items against real schemas. Until then the connector runs fully on
the synthetic fixture (dev) and is production-swappable for the order/shipment outcome surface.
