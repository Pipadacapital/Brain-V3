# 11 — Final Review (Stage 6, Engineering Advisor go/no-go): feat-ad-connectors (Slice 1)

> **Reviewer:** Engineering Advisor (final-review hat) · **req_id:** `feat-ad-connectors`
> **Lane:** high_stakes (connectors, money, multi_tenancy, secrets/oauth, schema_proto, outbound)
> **Branch:** `feat/ad-connectors-slice1` (base `master`) · **Reviewed:** 2026-06-18
> **Upstream:** Security = BOUNCE (1 HIGH, 1 MED) · QA = BOUNCE (1 money-path cursor bug)

## Advisor recommendation: REJECT (bounce to fix-loop)

Both upstream gates returned BOUNCE with an unresolved HIGH (security) and an unresolved
money-path correctness defect (QA). Per the Stage-6 rule, EITHER an upstream BOUNCE or an
unresolved CRITICAL/HIGH forces a final BOUNCE. I independently reproduced **both** blocking
findings at `file:line` and replicated the relevant gates; this is not a rubber-stamp of the
upstream summaries.

---

## Independent spot-check (did not trust the summaries)

| Claim | Verified at | Result |
|---|---|---|
| **SEC-AD-H1** — META_APP_SECRET in a GET URL | `HandleMetaOAuthCallbackCommand.ts:183-193` | **CONFIRMED.** `client_secret` is placed in `URLSearchParams` then sent as `?${params}` on a `method:'GET'` to `graph.facebook.com/.../oauth/access_token`. Secret lands in proxy/ALB/CDN access logs. |
| **SEC-AD-M1** — Meta access_token in /me/adaccounts query | `HandleMetaOAuthCallbackCommand.ts:213-217` | **CONFIRMED.** `?...&access_token=${encodeURIComponent(accessToken)}` in the URL. Same log-leak class, lower blast radius (short-lived token, best-effort path). |
| **Correct contrast pattern exists** | `HandleGoogleAdsOAuthCallbackCommand.ts:165-177` | **CONFIRMED.** Google does it right: `method:'POST'`, creds in `body`, `Content-Type: x-www-form-urlencoded`. The fix is a mechanical mirror of this. |
| **Q-CURSOR** — throttle classifier aborts on QPS | `google-ads-searchstream-client.ts:271-279` | **CONFIRMED.** Line 271 returns `'DAILY'` (abort run) when `status==='RESOURCE_EXHAUSTED'` **before** the line 275 `RESOURCE_TEMPORARILY_EXHAUSTED` check. Real Google QPS errors arrive as `RESOURCE_EXHAUSTED` envelope + `RESOURCE_TEMPORARILY_EXHAUSTED` quotaError → mis-routed to abort, violating ADR-AD-7. |
| **Q-CURSOR test dodges the case (inert probe)** | `google-ads-searchstream-client.test.ts:28-44` | **CONFIRMED.** The test constructs the exact mixed-field body (`status:'RESOURCE_EXHAUSTED'` + `quotaError:'RESOURCE_TEMPORARILY_EXHAUSTED'`) at lines 28-33, comments that it "means QPS" (line 34), then asserts on a *different* `qpsOnly` body and discards the real one with `void body` (line 44). The suite passes (4/4) **because** it avoids the failing assertion — a green-but-inert probe. |

### Gates I re-ran (captured)
- `npx vitest run google-ads-searchstream-client.test.ts ad-spend-mapper/src/index.test.ts` → **17 passed (4 + 13)**. The Google suite passing is itself the evidence for Q-CURSOR: it is green only because the bug-exposing assertion was elided.
- **Negative-control validity (tenancy):** `ad-spend-metrics.live.test.ts:301-307` asserts `current_user==='brain_app'` AND `is_superuser===false` before the isolation assertions at 309-341 (positive control BRAND_A visible, BRAND_B `no_data`; GUC=BRAND_B cross-brand `COUNT(*)=0`). This is a **non-inert** negative control — it would have been inert under the dev superuser `brain` (which bypasses RLS), and the test explicitly guards against exactly that. PASS.
- **Secrets-in-transit cross-check:** the *ingestion* path (`meta-insights-client.ts:144`) correctly rides the token in the Authorization header — so SEC-AD-H1/M1 are isolated to the connect/callback command, not systemic.

---

## Reconciled findings table

| ID | Sev | Gate | Status | file:line | Required fix |
|---|---|---|---|---|---|
| SEC-AD-H1 | HIGH | Security (secrets-in-transit) | **BLOCKING** | `HandleMetaOAuthCallbackCommand.ts:183-193` | Change to `method:'POST'`, move `client_id/client_secret/code/redirect_uri` into the request body (mirror Google `:165-177`). |
| Q-CURSOR | (money-path correctness) | QA (ADR-AD-7 throttle) | **BLOCKING** | `google-ads-searchstream-client.ts:271-279` + test `:28-44` | Check `quotaErrors.includes('RESOURCE_TEMPORARILY_EXHAUSTED')` BEFORE `status==='RESOURCE_EXHAUSTED'`; add a direct assertion on the mixed-field body (remove `void body`). |
| SEC-AD-M1 | MED | Security (secrets-in-transit) | Should-fix (fix alongside H1) | `HandleMetaOAuthCallbackCommand.ts:213-217` | Move `access_token` out of the query string (POST or header per Graph API support); already in the same file as H1 — fix together. |

All other gates **PASS** (independently sampled): R-OAUTH brand-from-state (state nonce IS the auth, never body), CSRF state, token storage (secret_ref ARN only, never logged), R-RLS FORCE-RLS under `brain_app` non-inert, SECURITY DEFINER enumeration (`list_ad_connectors_for_spend_repull` prosecdef + search_path + brain_app EXECUTE, migration assertions SEC-AD-0029a/b/c), R-MONEY `spend_minor BIGINT` + micros→minor (NO-FLOAT guard F-2), R-PII allowlist (ad-ids operational refs), R-MIGRATION 0029 additive + assertions, append-only GRANT (no UPDATE/DELETE, F-3), SpendLedgerConsumer wired in `main.ts`, parity oracle, honest-empty UI.

## Over-engineering / hard-rule audit — CLEAN
- No new deployable/topic/envelope: confirmed in the diff-stat (jobs inside stream-worker, `spend.live.v1` on the collector envelope, additive migration 0029 only). Single-Primitive sweep holds.
- Cost paradigm: Tier-0 deterministic, 0 model tokens — matches plan §1; no model-call creep.
- Migration renumber 0028→0029 (collision with feat-collection-foundation) is documented in the SQL header and is content-identical — not a hard-rule deviation.
- No drive-by refactoring beyond the in-scope stale `connector-marketplace.live.test.ts` assertion update (justified: the providers changed state).

## Risks remaining (post-fix)
1. **Primary residual (must clear before re-PASS):** until SEC-AD-H1 is fixed, the Meta app secret leaks to every network log intermediary on the token-exchange path — a credential-exposure HIGH.
2. **Money-path silent-loss (must clear before re-PASS):** until Q-CURSOR is fixed, a Google QPS burst aborts the entire daily repull instead of backing off → a full day of spend silently missing from `ad_spend_ledger`, corrupting ROAS for that brand/day.
3. **Lower residual (acceptable, declared):** real OAuth requires real app credentials + public callback + approved Google developer token — a declared platform follow-up (dev-honest, same boundary as Shopify/Razorpay). Not a blocker for this slice.

## Next action
**Fix-loop** (NOT the Stakeholder gate). Bounce to the build/fix stage for: (1) SEC-AD-H1 + SEC-AD-M1 in `HandleMetaOAuthCallbackCommand.ts`, (2) Q-CURSOR classifier + a non-inert assertion in `google-ads-searchstream-client.test.ts`. On return, delta-review re-verifies only these two findings + the Google-throttle and Meta-callback regression checks, then re-runs the security and QA gates.

---

VERDICT: BOUNCE
