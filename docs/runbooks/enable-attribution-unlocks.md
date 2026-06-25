# Runbook — enable the three remaining attribution unlocks

The code for all three is already in `master`. Each is gated only on an **external action** that can't
run from this repo's CI/headless (Shopify Partner auth, AWS secrets, a per-brand business choice). This
runbook is the turnkey checklist. Status after this PR:

| Unlock | Code | This PR | Remaining (you) |
|---|---|---|---|
| Spark Bronze sink | complete | **`enabled: true` flipped** | provision core-env Spark secrets |
| Shopify checkout Web Pixel | complete | runbook | `shopify app deploy` + reconnect |
| Ad-account live spend/ROAS | complete | runbook | activate the right account in the UI |

---

## 1. Spark Bronze sink — FLIPPED ON (needs secrets)

Correction to earlier notes: the sink does **NOT** need a Spark Operator or a dedicated cluster. It runs
`spark-submit --master local[*]` in a **single Argo Workflow pod** (`infra/helm/cronworkflows/templates/
spark-bronze.yaml`; `db/iceberg/spark/Dockerfile`), sized 4Gi (driver heap 3g). The image is CI-built +
digest-pinned (`build-data-images`). This PR sets `sparkBronze.enabled: true`.

**Remaining prerequisite (operational, not infra):** the `core-env` secret (External Secrets ←
AWS Secrets Manager) must carry the sink's config, or the scheduled runs fail **loudly** (visible Argo
failures — not silent):
- `KAFKA_BROKERS`
- `ICEBERG_REST_URI` + `BRONZE_WAREHOUSE` + AWS creds (`AWS_*`) for S3/Glue
- `CHECKPOINT_LOCATION` — a **durable** `s3a://…` path (NOT the local-dev `file:///tmp` default)
- `COLLECTOR_TOPIC` **and** `BACKFILL_TOPIC` (both lanes — omitting the backfill lane silently drops
  backfilled orders from Bronze)

Verify: `kubectl get cronworkflows -n <ns> | grep bronze` → two (materialize `*/15`, maintenance daily);
after a run, the Iceberg `collector_events` row count grows. To stop instantly: flip `enabled: false`.

---

## 2. Shopify checkout Web Pixel — deploy + reconnect

Why it matters: the storefront ScriptTag can't run on Shopify's checkout origin, so today there are **no
checkout events** and the journey→order stitch (`gold_attribution_paths`) + anon↔customer identity bridge
stay empty. The Web Pixel covers checkout. The code is complete: extension registered
(`extensions/brain-web-pixel/`), scopes present (`write_pixels,read_customer_events`), `webPixelCreate`
called by `InstallPixelCommand` (best-effort), collector ingests checkout events, and the mapper reads
`brain_anon_id` back from checkout `note_attributes` for the stitch.

**The remaining step is a manual ops action** — `shopify app deploy` needs Partner-app auth + a linked
app config (`shopify.app.toml`, deliberately not committed). On a machine with the Brain Shopify Partner
app access:

```sh
shopify app config link        # one-time: link this repo's extension to the Brain Partner app
shopify app deploy             # registers/updates the brain-web-pixel extension
```

Then, per merchant:
1. **Reconnect Shopify** in Brain so OAuth re-grants `write_pixels` + `read_customer_events`.
2. Re-run Install Pixel (or it runs on connect) → `webPixelCreate` activates checkout tracking.

Verify (a live test checkout): `checkout.started` / `checkout.completed` events arrive at `/collect`;
`silver_touchpoint` gets a checkout stage; an order placed after browsing carries `stitched_anon_id`
(note_attributes) → `gold_attribution_paths` starts populating. (CI deploy is intentionally avoided to
not store Partner credentials — see `extensions/brain-web-pixel/shopify.extension.toml`.)

---

## 3. Ad-account live spend / ROAS — activate the right account

Why it matters: spend/ROAS need an **activated** ad account (migration 0106 — one per brand+platform) that
actually has live campaigns. The platform connection + activation feature are complete; this is a per-brand
business choice that only you can make (which agency account belongs to this brand).

Steps (Brain → Settings → Connectors):
1. Connect Meta / Google (if not already) — discovers all accounts under the agency login.
2. On the connector card, **Activate** the one account for this brand (switch semantics — activating one
   deactivates the others). Pick an account with **live campaigns** (the dev test used Meta
   `act_507668214437296` "BODD Active New Ad Account", which had no recent spend → no ROAS).
3. The hourly `ingest-scheduler` repulls only the activated account → `spend.live.v1` → Bronze →
   `silver_marketing_spend` → `gold_cac` + blended ROAS.

Verify: the spend page shows non-zero spend within ~an hour; `/insights` blended-ROAS insight fires with
real numbers (and, for multi-currency, the blended-primary ROAS from the FX work).

---

### Summary
sparkBronze is enabled here; the other two are code-complete and gated on the external actions above.
None can be executed headlessly from CI (Partner auth / AWS secrets / a human business decision).
