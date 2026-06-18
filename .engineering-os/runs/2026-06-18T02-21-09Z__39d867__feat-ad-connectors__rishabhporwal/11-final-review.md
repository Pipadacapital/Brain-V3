# 11 — Final Review (Stage 6, Engineering Advisor go/no-go): feat-ad-connectors (Slice 1) — DELTA RE-REVIEW (round 2)

> **Reviewer:** Engineering Advisor (final-review hat) · **req_id:** `feat-ad-connectors`
> **Lane:** high_stakes (connectors, money, multi_tenancy, secrets/oauth, schema_proto, outbound)
> **Branch:** `feat/ad-connectors-slice1` (base `master`) · **HEAD:** `f910bb0` · **Reviewed:** 2026-06-18
> **Delta scope this round:** verify SEC-NEW-M1 fix (commit `f910bb0`) + confirm the three prior fixes intact at HEAD + regression: no new conflict markers anywhere in the diff.

## Advisor recommendation: REJECT — BOUNCE to dev/orchestrator fix-loop

SEC-NEW-M1 as originally scoped (the e2e spec file) **is resolved**, and all three prior
product-code fixes (SEC-AD-H1, SEC-AD-M1, Q-CURSOR) are **intact at HEAD** — I independently
re-verified each at `file:line`. **However, the regression gate (check 5) FAILS:** four
`.engineering-os/` orchestrator state/log files carry **committed git merge-conflict markers** at
HEAD, two of which are now **unparseable JSON** — including `state/active.json`, which holds the
live `feat-ad-connectors` record. These markers were committed in `b019405` (the same fix-loop
commit that resolved the product-code findings); the SEC-NEW-M1 fix commit `f910bb0` cleaned only
the spec file and did not touch them. A corrupt `active.json` breaks the next orchestrator read and
the Stakeholder gate's own bookkeeping. This is a green-before / red-now state corruption that
escaped the previous round's spec-only focus. Cannot bless the gate.

---

## Verification this round (5 checks)

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | 0 conflict markers in `apps/web/e2e/members-lifecycle.spec.ts` | **PASS** | `grep -nE '^<<<<<<<\|^=======$\|^>>>>>>>'` → exit 1 (none). |
| 2 | spec parses (`playwright test members-lifecycle --list`) | **PASS** | Lists 4 tests (`:84 :272 :327 :355`), no SyntaxError. |
| 3 | `tsc --noEmit` clean for members-lifecycle.spec.ts | **PASS** | tsc exit 0, 0 lines of output, 0 hits on `members-lifecycle`. |
| 4 | three prior fixes still present at HEAD | **PASS** | see table below. |
| 5 | no NEW conflict markers anywhere in the diff (`git diff master...HEAD \| grep '^\+(<<<\|===\|>>>)'`) | **FAIL** | 21 added marker lines in 4 `.engineering-os/` files (see below). |

## Findings table

| ID | Sev | Status | file:line (HEAD `f910bb0`) | Evidence |
|---|---|---|---|---|
| SEC-AD-H1 | HIGH | **RESOLVED** | `apps/core/src/modules/connector/sources/advertising/meta/application/commands/HandleMetaOAuthCallbackCommand.ts:185,190,194-195,207` | Token exchange is `POST` to bare `.../oauth/access_token` with `client_secret` in the form-urlencoded **body** (`client_secret: clientSecret` @185; explicit SEC-AD-H1 comment @190; `fetch(... method POST ...)` @194). No query string → secret no longer reaches proxy/ALB/CDN access logs. |
| SEC-AD-M1 | MED | **RESOLVED** | `…/HandleMetaOAuthCallbackCommand.ts:222-226` | `/me/adaccounts` rides `headers: { Authorization: \`Bearer ${accessToken}\` }` @226 (explicit SEC-AD-M1 comment @222); URL has no `access_token` query param. |
| Q-CURSOR | money-path | **RESOLVED** | `apps/stream-worker/src/jobs/google-ads-spend-repull/google-ads-searchstream-client.ts:282-289` | `RESOURCE_TEMPORARILY_EXHAUSTED → 'QPS'` (@282-283) runs **before** `RESOURCE_EXHAUSTED → 'DAILY'` (@285-286); bare-429 → `'QPS'` (@289). Precedence correct: a QPS burst backs off instead of aborting the day's repull. |
| SEC-NEW-M1 | MED (scoped) | **RESOLVED** | `apps/web/e2e/members-lifecycle.spec.ts` | 0 conflict markers; suite lists 4 tests; tsc clean. Commit `f910bb0` removed the 23 corrupt lines. |
| **F-REV-R2-1** | **BLOCKING (new)** | **OPEN** | `.engineering-os/state/active.json` (6 markers, **invalid JSON**), `.engineering-os/state/orchestrator-cursor.json` (9 markers, **invalid JSON**), `.engineering-os/live.log` (3 markers), `.engineering-os/usage.jsonl` (6 markers) — all at HEAD, introduced by `b019405` | `git show HEAD:<file> \| python3 -m json.tool` → `JSONDecodeError` on both state files. `active.json` line 3 splits `updated_at`/`updated_by`, and the `feat-ad-connectors` record itself is split across a `<<<<<<< Updated upstream … ======= … >>>>>>> Stashed changes` conflict. The orchestrator cannot parse its own live state. |

## Residual risk (would apply on a clean PASS)
Real Meta/Google app credentials + the public OAuth callback endpoint are a declared platform
follow-up (Phase-2 connector enablement), not a slice-1 blocker. No other product-code residual.

## What must be fixed to clear the bounce
Re-resolve the four `.engineering-os/` files so 0 conflict markers remain and both state JSONs
parse (`active.json`, `orchestrator-cursor.json`), keeping the intended `feat-ad-connectors`
record (status/stage as the orchestrator decides post-review). Re-run check 5 to green, then
re-request the Stage-6 gate. Product code (apps/core, apps/stream-worker, apps/web) is clean and
needs no further change.

## Hard-rule / over-engineering / negative-control notes
- Over-engineering: none new this round (delta is conflict-marker cleanup only).
- Negative controls on the money/auth paths (Q-CURSOR mixed-field assertion; Meta secret-in-body): present and non-inert per the prior round; unchanged.
- Hard-rule: a committed-conflict-marker / corrupt-state-file escape is a recurring class — flag for the streamlining audit, but no auto-rule adopted here (human runs `/adopt-rule`).

VERDICT: BOUNCE
