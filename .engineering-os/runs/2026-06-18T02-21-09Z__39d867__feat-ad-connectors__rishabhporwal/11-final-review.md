# 11 — Final Review (Stage 6, Engineering Advisor go/no-go): feat-ad-connectors (Slice 1) — DELTA RE-REVIEW (round 3, re-bless)

> **Reviewer:** Engineering Advisor (final-review hat) · **req_id:** `feat-ad-connectors`
> **Lane:** high_stakes (connectors, money, multi_tenancy, secrets/oauth, schema_proto, outbound)
> **Branch:** `feat/ad-connectors-slice1` (base `master`) · **HEAD:** `ea0f4cd` · **Reviewed:** 2026-06-18
> **Delta scope this round:** verify F-REV-R2-1 (state-corruption) fix at HEAD + confirm the four prior findings (SEC-AD-H1, SEC-AD-M1, Q-CURSOR, SEC-NEW-M1) remain resolved at HEAD + regression: no new conflict markers anywhere in `git diff master...HEAD`.

## Advisor recommendation: APPROVE — PASS to Stakeholder gate

All five prior blockers are independently re-verified at HEAD `ea0f4cd` (not trusting claims — commands re-run, output captured below). The product-code fixes (SEC-AD-H1, SEC-AD-M1, Q-CURSOR, SEC-NEW-M1) are intact at `file:line`, and the round-2 blocker F-REV-R2-1 (committed merge-conflict markers / corrupt orchestrator state) is now fully resolved: 0 conflict markers in any tracked `.engineering-os/` file, both `state/active.json` and `state/orchestrator-cursor.json` parse as valid JSON, the `feat-ad-connectors` record is present, and `git diff master...HEAD` adds no new conflict markers. The gate is clean. Releasing to the Stakeholder.

---

## Verification this round (5 checks — all re-run at HEAD `ea0f4cd`)

| # | Check | Result | Evidence (captured) |
|---|---|---|---|
| 1 | SEC-AD-H1: Meta token exchange POSTs `client_secret` in body, not URL | **PASS** | `HandleMetaOAuthCallbackCommand.ts` — `method: 'POST'` @197, `body: params.toString()` @199, `client_secret: clientSecret` in `URLSearchParams` body @185, bare URL `.../oauth/access_token` @195 (no query). |
| 2 | SEC-AD-M1: `/me/adaccounts` uses `Authorization: Bearer`, no `access_token` in URL | **PASS** | `…Command.ts:226` — `headers: { Authorization: \`Bearer ${accessToken}\` }`; URL query is only `?fields=account_id` @225, no token. |
| 3 | Q-CURSOR: precedence TEMPORARILY→QPS before RESOURCE_EXHAUSTED→DAILY before bare-429→QPS; test asserts mixed-field directly (no `void body`) | **PASS** | `google-ads-searchstream-client.ts:282-289` ordering correct. Test `…client.test.ts:32-39` asserts `classifyGoogleError({status:RESOURCE_EXHAUSTED, quotaError:RESOURCE_TEMPORARILY_EXHAUSTED}, 429)==='QPS'`. **Re-ran** `vitest run google-ads-searchstream-client` → **4/4 passed**. |
| 4 | SEC-NEW-M1: `members-lifecycle.spec.ts` 0 conflict markers + parses | **PASS** | `grep -nE '<<<<<<<\|=======\|>>>>>>>'` → exit 1 (none). **Re-ran** `playwright test members-lifecycle --list` → lists 4 tests (`:84 :272 :327 :355`), no SyntaxError. |
| 5 | F-REV-R2-1: 4 `.engineering-os` files 0 markers, both state JSONs parse, AND `git diff master...HEAD` adds no new markers | **PASS** | `git grep -nE '^(<<<<<<<\|=======\|>>>>>>>)' -- '.engineering-os/*'` → exit 1 (none). `python3 -c json.load` on `state/active.json` + `state/orchestrator-cursor.json` → both **OK**; committed `active.json` parses and contains `feat-ad-connectors`. `live.log`/`usage.jsonl` marker-free. `git diff master...HEAD \| grep -nE '^\+(<<<<<<<\|=======\|>>>>>>>)'` → exit 1 (nothing added). |

## Findings table

| ID | Sev | Status | file:line (HEAD `ea0f4cd`) | Evidence |
|---|---|---|---|---|
| SEC-AD-H1 | HIGH | **RESOLVED** | `apps/core/src/modules/connector/sources/advertising/meta/application/commands/HandleMetaOAuthCallbackCommand.ts:185,190,194-200` | Token exchange is `POST` (@197) to bare `.../oauth/access_token` (@195) with `client_secret` in the form-urlencoded **body** (@185,199), `Content-Type: application/x-www-form-urlencoded` @198. No secret in query → not captured by proxy/ALB/CDN access logs. SEC-AD-H1 comment @190-193. |
| SEC-AD-M1 | MED | **RESOLVED** | `…/HandleMetaOAuthCallbackCommand.ts:222-227` | `/me/adaccounts` request rides `headers: { Authorization: \`Bearer ${accessToken}\` }` @226 (SEC-AD-M1 comment @222); URL @225 carries only `?fields=account_id`, no `access_token`. |
| Q-CURSOR | money-path | **RESOLVED** | `apps/stream-worker/src/jobs/google-ads-spend-repull/google-ads-searchstream-client.ts:282-289` + `…client.test.ts:32-39` | `RESOURCE_TEMPORARILY_EXHAUSTED → 'QPS'` (@282-283) runs **before** `RESOURCE_EXHAUSTED → 'DAILY'` (@285-286), then bare-429 → `'QPS'` (@288-289). Test asserts the exact mixed-field case directly (no `void body`); re-ran green 4/4. A QPS burst backs off instead of aborting the day's spend repull. |
| SEC-NEW-M1 | MED | **RESOLVED** | `apps/web/e2e/members-lifecycle.spec.ts` | 0 conflict markers (grep exit 1); `playwright test members-lifecycle --list` lists 4 tests, parses cleanly. |
| F-REV-R2-1 | BLOCKING (round-2) | **RESOLVED** | `.engineering-os/state/active.json`, `.engineering-os/state/orchestrator-cursor.json`, `.engineering-os/live.log`, `.engineering-os/usage.jsonl` (fixed in `ea0f4cd`) | All four files 0 conflict markers; both state JSONs parse via `python3 json.load`; committed `active.json` parses with the `feat-ad-connectors` record present. `git diff master...HEAD` adds no new markers. Orchestrator can read its own live state. |

## Residual risk
Real Meta/Google app credentials + the public OAuth callback endpoint are a declared platform follow-up (Phase-2 connector enablement), not a slice-1 blocker. Otherwise none — product code (apps/core, apps/stream-worker, apps/web) is clean and the orchestrator state is valid.

## Hard-rule / over-engineering / negative-control notes
- Over-engineering: none new this round (delta is conflict-marker cleanup + re-bless only).
- Negative controls on the money/auth paths (Q-CURSOR mixed-field assertion proven non-tautological by re-run; Meta secret-in-body verified by source): present and non-inert.
- Hard-rule: the committed-conflict-marker / corrupt-state-file escape is a recurring class — flagged for the streamlining audit; no auto-rule adopted here (human runs `/adopt-rule`).
- Cost paradigm: this slice introduces only deterministic OAuth/HTTP connector + error-classification logic — no model calls — so the cost-routing gate is N/A by inspection.

## Mechanical commit (explicit product-code paths — no `git add -A`)
Work is already committed at HEAD `ea0f4cd` on `feat/ad-connectors-slice1`. No further staging required for the gate; the Stakeholder owns merge/deploy authority (Stage 7). Do NOT push / open a PR from this stage.

VERDICT: PASS
