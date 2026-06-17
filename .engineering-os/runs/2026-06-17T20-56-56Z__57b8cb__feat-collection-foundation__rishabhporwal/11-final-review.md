# 11 — Final Review (Stage 6): Collection Foundation (Phase 1)

| Field | Value |
|-------|-------|
| **req_id** | `feat-collection-foundation` |
| **Stage** | 6 — Final Review (VETO gate) |
| **Reviewer** | Engineering Advisor (final-reviewer) · Opus 4.8 (1M) |
| **Verdict** | **BOUNCE** → Stage 3 (Build) on Track C read seam, then Stage 5 re-verify |
| **Recommendation** | **REJECT** (do not commit / do not advance to Stakeholder gate yet) |
| **Blocking findings** | 1 (FR-CF-01, MEDIUM) |
| **Lane** | high_stakes (multi_tenancy / pii / schema_proto / compliance / outbound-edge) |

---

## Verdict in one line

The R2 isolation keystone is **real and non-inert** and the diff is clean of drift/over-engineering — but a **write/read JSON-path mismatch on `consent_flags`** makes the Tracking Center's consent KPIs always read **0/false**, on a stakeholder-visible, compliance-adjacent Phase-1 deliverable. That is a shipped-but-wrong feature → BOUNCE (there is no pass-with-reservations at this gate).

---

## 1. Keystone confirmation — R2 isolation (PASS, non-inert)

- **Server-side derivation wired on the live path:** `ProcessEventUseCase.ts:120-157` derives the authoritative `brand_id` from `properties.install_token` via `BronzeRepository.resolveBrandByInstallToken` (`:68/83`) → `SELECT brand_id FROM resolve_brand_by_install_token($1::uuid)` (migration `0028`). The client-stamped top-level `brand_id` is used for partitioning only and is **never** trusted. The Bronze GUC is set from the derived value (`BronzeRepository.write:101-104`).
- **Live lane defaults ON:** `main.ts:74` `new ProcessEventUseCase(dedup, bronze, auditWriter)` → `enforceTenantDerivation=true`. Backfill/live-ledger lanes correctly opt out (`main.ts:107-108`, `enforceTenantDerivation=false`) — those carry no `install_token` and a server-trusted brand.
- **Quarantine branches real:** token absent/malformed/unresolved → `quarantined` (`tenant_unresolved`); claimed≠derived → `quarantined` + `pixel.brand_mismatch` audit under the DERIVED brand (`:134-143`, `writeBrandMismatchAudit:212-242`); absent `consent_flags` → `quarantined` (`consent_absent`). Consumer routes `quarantined` → `${topic}.quarantine` then commits offset (`CollectorEventConsumer.ts:84-103`).
- **Migration hardening:** `0028` is `SECURITY DEFINER`, `SET search_path=public`, `STABLE`, `LANGUAGE sql`, `GRANT EXECUTE TO brain_app`, dispatch-only `(brand_id)`, with three migration-time assertions (prosecdef / search_path / EXECUTE). Mirrors the `0026` connector-resolver precedent exactly.
- **Non-inertness re-confirmed:** QA's negative control disabled the derivation (`if(false)` + `brand_id=claimedBrandId`) → cross-brand test went RED (`expected 'written' to be 'quarantined'`, `ingest-hardening.e2e:258`), restored → GREEN. `brain_app` confirmed `rolsuper=f rolbypassrls=f` (RLS genuinely enforced, not superuser-masked). Recorded in `qa-review.json.negative_control[]`.

**Wired-to-nothing near-miss (NOTED):** migration `0028`'s fn was an exact candidate for the WATCH #2-of-3 "built-but-unwired" pattern (`lessons-learned.md:30`). It is **CONFIRMED WIRED** end-to-end (`ProcessEventUseCase:123 → BronzeRepository:68/83 → main.ts:74`). This is a near-miss, **not** a 3rd occurrence — so no `rule-proposals/*` file is written and the WATCH stays at #2. The near-miss is logged here as a live signal that the pattern continues to recur structurally.

## 2. Drift check (PASS)

- **No new deployable / service:** `docker-compose.yml` diff adds only the sanctioned `dev.collector.event.v1.quarantine` topic creation; no new container/Dockerfile.
- **No new external dependency:** the only `dependencies` additions are internal workspace packages (`@brain/audit` in stream-worker; `@brain/contracts` as a pixel-sdk dev-dep for the eval-parity test). No new runtime npm dep.
- **Envelope extended additively:** `consent_flags` promoted to a first-class optional field on `CollectorEventV1Schema` + FULL_TRANSITIVE-safe mirror in `collector.event.v1.avsc`. No second envelope, no shape (b).
- **Single topic suffix** (`.quarantine`) on the existing family, reusing the shipped `DlqProducer` (parametric on topic). No new topic family / OLTP table / RLS variant.
- **`pixel-sdk`** was a pre-existing `export {}` stub package (sanctioned per the plan); now implemented. The only new package surface, as the plan sanctioned.
- All seven Phase-1 deliverables are present, including the MANDATORY Tracking Center (setup wizard, live verification, tracking health, event explorer).

## 3. Paradigm / cost audit (PASS)

- Cost paradigm = **deterministic tier-1 only**, exactly as the plan declared. No model/statistical/ML call anywhere in the diff (grep clean). A model call here would have been a paradigm-bypass VETO; none present. $0 incremental inference. No effort-tier declaration is required because no path calls a model.

## 4. PII / ADR-2 (PASS)

- SDK + collector: no `Set-Cookie` (only VETO-comments and negative-assertion tests); no salt, no raw email/phone capture — the only `hash` hit is a URL-fragment index calc (`attribution.ts:13-14`). Browser sends behaviour + anon-id + opaque attribution only.
- Read path `get-recent-events.ts` selects only `event_type/occurred_at/brain_anon_id/hashed_session_id` + a boolean — never raw PII; inside `withBrandTxn` (RLS, brand from arg not body), `MAX_LIMIT=50`.

## 5. Gates spot-re-run this session (≥3, captured)

| Gate | Result | Note |
|---|---|---|
| `packages/pixel-sdk` unit | **12/12 GREEN** | re-run independently this session |
| `apps/web` tracking-status unit | **9/9 GREEN** | re-run independently this session |
| `packages/contracts` consent-propagation + no-pii CI gate | **3/3 GREEN** | re-run independently this session |
| consent-gate **mutation** (removed `consent_flags` from envelope) | **2 failed / 1 passed = RED** | proves the gate is **non-inert**; restored byte-identical |

**Infra-bound gates (ingest-hardening.e2e, etc.) could NOT be replicated here:** the running containers are the separate `brainv3-*` compose project (tied to the concurrent `Brain V3`/`brain-ui` work I was told not to touch) and publish **no host ports**; the `brain-spec` stack is not up with published ports. The suite correctly **fails-closed** (ECONNREFUSED → ERROR, not silent exit-0), which confirms the anti-inert-probe property. I rely on QA's captured live run + `negative_control[]` (EXIT 0, 28 files) for those gates, corroborated by the static keystone audit above. This environment gap is **not** the basis for the bounce.

## 6. Blocking finding

### FR-CF-01 — MEDIUM — consent_flags write/read JSON-path mismatch — BOUNCE → Stage 3

- **Writer** (`ProcessEventUseCase.ts:177-181`): persists `consent_flags` at the **top level** of the Bronze payload (sibling of `event_name`/`properties`) → `payload->'consent_flags'`.
- **SDK** (`capture.ts:85`): emits `consent_flags` top-level only; it is NOT inside the `properties` bag.
- **Readers** (`get-tracking-health.ts:102,105` and `get-recent-events.ts:69`): query `payload->'properties'->'consent_flags'` — a path the writer never populates.
- **Effect:** Tracking Health `consent_total`/`consent_granted` and Event Explorer `has_consent` render **0 / false for every real event**, regardless of actual consent — on deliverable 7's explicitly-required "consent/quarantine counts" surface.
- **Why it escaped:** no test drives a consented event into Bronze and reads the consent flag back via the BFF query. `tracking-status.test.ts` uses hand-built consent fixtures (presentation only); `ingest-hardening.e2e:387` asserts the absent-consent QUARANTINE (write-side gate), never a consent-count READ. This is a Stage-5 coverage gap that let the path mismatch through.
- **Fix (smallest):** correct the two reader JSON paths to `payload->'consent_flags'` (preferred — matches the envelope's first-class promotion of `consent_flags` per ADR-1). Add a Stage-5 e2e: consented event → Bronze → BFF read asserts `consent_total≥1`/`has_consent=true` (the missing negative-to-positive control).
- **Not** an isolation/PII/money breach — RLS, tenant-derivation, and no-PII all hold; severity is MEDIUM (functional correctness on a stakeholder-visible, compliance-adjacent surface). Per the no-pass-with-reservations rule, a real defect in a Phase-1 deliverable bounces.

## 7. Non-blocking / carry-forward

- **SEC-CF-01 / LOW** — dedup-observability e2e asserts via `incrementCounter` directly rather than through `CollectorEventConsumer:108-114`. Shipped control correct; loose assertion. Tighten on the FR-CF-01 re-spin.
- **SEC-CF-02 / NOTE** — audit_log test-read via superuser pool (audit_log is RLS-disabled by design; write path under brain_app). Acceptable, no leak.
- Pre-existing `AwsSecretsManager TS2307` in stream-worker is outside this diff (confirmed untouched) — unrelated, non-blocking.

## 8. Security/QA reconciliation

Both upstream gates logged PASS (Security: 0 CRIT/HIGH/MED, 2 LOW; QA: 74 core + 57 regression green). They are reconciled and correct on what they tested. FR-CF-01 is a **new** finding from the writer↔reader cross-check that neither gate exercised end-to-end — it does not contradict either artifact; it fills the coverage gap they share.

## 9. Retro (→ lessons-learned candidate)

- **Root cause of FR-CF-01:** a field promoted to a new structural location (top-level `consent_flags`) while consumers were written against the old/assumed nested location (`properties.consent_flags`), with no end-to-end test spanning the writer and reader of that field. Same *family* as the wired-to-nothing pattern (isolation-tested components, untested seam between them), but distinct (a path/shape mismatch, not an unwired component) — so it does NOT increment the wired-to-nothing WATCH counter.
- **Auto-candidate rule check:** root cause does not yet recur in ≥3 distinct prior runs (it is the 1st of this specific "field-relocation read/write path drift" shape). No `rule-proposals/*` written. The **wired-to-nothing** WATCH remains at #2-of-3 (this run was a near-miss, not an occurrence).
- **Process improvement for the re-spin:** every newly-relocated/promoted envelope field that a UI surface reads requires a writer→reader round-trip test asserting a non-zero/true read (a positive control), not just a write-side gate test.

## HANDOFF
See the HANDOFF block returned to the orchestrator + `final-review.verdict.json`.
