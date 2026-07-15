# Runbook — Enable Stitch v2 (multi-key deterministic stitch)

Audit gap **G2**. The full 5-identifier deterministic stitch ("Stitch v2") is **already
implemented** in `db/iceberg/duckdb/silver/silver_session_identity.py` (matches
`anonymous_id`, `hashed_customer_email`, `hashed_customer_phone`,
`storefront_customer_id`, `checkout_session_id` against the bi-temporal
`silver_identity_map` under the `identity_current` predicate; never-guess on ambiguity)
with event-driven re-stitch (`apps/stream-worker/.../RestitchDirtyConsumer.ts`).

It is gated by the per-brand flag **`stitch.v2`** (`packages/platform-flags/src/registry.ts`),
**DEFAULT OFF, fail-closed**. With the flag OFF, `silver_session_identity` is effectively a
no-op and identification falls back to the legacy single-key path (≈ <1%). **There is no code
to write — this is an operational rollout.**

## Flag mechanics
- Redis key: `{brand_id}:flag:stitch.v2`, value literal `"true"` (only `"true"` enables).
- In-process cache TTL ≈ 10s — other app/worker instances converge within ~10s of a change.
- `setFlag` rejects any flag not in the typed registry, so a typo cannot silently enable anything.

## Enable for ONE test brand
Call the admin surface as a `brand_admin`/owner **of the target brand** — the brand is taken from
the **session**, never the body:

```
# enable
curl -X PUT https://<host>/api/v1/admin/flags \
  -H "Authorization: Bearer <brand_admin session for the TARGET brand>" \
  -H 'content-type: application/json' \
  -d '{"flag":"stitch.v2","enabled":true}'

# confirm
curl https://<host>/api/v1/admin/flags -H "Authorization: Bearer <same session>"   # stitch.v2 -> enabled:true
```

## Validate the identification lift
Prod DB reads are guardrailed, so validate via the **golden dataset** (`@brain/testing-golden`)
rather than an ad-hoc prod query:

1. Generate the golden collector/raw lanes (`packages/testing-golden` CLI) — it already covers
   `anon_to_known_mid_session`, `multi_device`, `shared_device_family`, `late_identify_day7`.
2. Run the Silver refresh (`tools/dev/duckdb-refresh.sh`) with `stitch.v2` ON vs OFF and compare
   linked-session counts in `silver_session_identity`. Expect the identified fraction to rise from
   <1% toward the **40–60%** target (brand-data dependent).
3. Spot-check a handful of known customers for correct linkage; confirm ambiguous cases land in the
   conflict path (not mis-linked).

## Staged rollout
1. One test brand → monitor identification rate, `silver_stitch_conflicts`, and journey/attribution
   output for ~24h.
2. Enable in batches, monitoring after each.
3. Once stable, make `stitch.v2` the default for new brands (registry default flip — a code change,
   separate PR).
4. Optional: retire the legacy single-key `journey-stitch-from-identity` fallback after a grace period.

## Rollback
Turn the flag OFF per brand (`{"flag":"stitch.v2","enabled":false}`). The legacy single-key path
remains available; `silver_session_identity` reverts to the no-op empty state on the next refresh.
