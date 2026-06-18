# 05 — Architecture Plan: feat-d13-consent-cancontact

**Stage:** 2 (Architect, binding) · **Lane:** high_stakes (compliance / PII / I-ST05 chokepoint)
**Branch:** `feat/d13-consent-cancontact` off master · **req_id:** `feat-d13-consent-cancontact`
**Regime honored:** COMPLIANCE.md (DPDP 2023 + TCCCPR/DLT + NCPR/DND, India). Roadmap doc 13 §13.4.

---

## 0. Cost paradigm (the gate)

**Paradigm: pure deterministic logic. ZERO model/ML/statistical calls.** Consent state, DND window
membership, tombstone suppression, and DLT/NCPR lookups are all boolean set-membership + a wall-clock
comparison against a fixed IST window. A model call here would be a compliance liability (non-determinism
in a fail-closed gate). Token budget: **0 tokens/day, $0/mo.** The only spend delta is one additional
stream-worker consumer group (same pod, no new deployable) — negligible. This is the cheapest-sufficient
tier by construction; any deviation toward statistical scoring is **Reject** (a compliance gate must be
reproducible and explainable row-by-row).

---

## 1. Single-Primitive sweep (extend before create)

| Concern | Decision | Evidence |
|---|---|---|
| Consent SoR | **ONE** `consent_record` (4-category) — NOT the coarse `customer.ai_processing_consent/resolution_consent` booleans (those stay as the legacy stand-in; this run does NOT retrofit them — doc 13 §13.4 "one SoR only"). | `db/migrations/0017_identity_graph.sql:40-41` |
| Send chokepoint | **EXTEND** the existing `canContact()` in the notification module. No new service, no second gate (I-ST05 / I-E05). | `apps/core/src/modules/notification/internal/notification.service.impl.ts:168-172` |
| Hasher | **REUSE** `@brain/identity-core` `hashIdentifier()` — the ONLY sanctioned hasher. No second hashing util (doc 13 §13.2 = Reject). | `packages/identity-core/src/index.ts:156-166` |
| Consumer pattern | **REUSE** the KafkaJS separate-consumer-group-on-existing-topic pattern; consume `dev.collector.event.v1`. No new topic, no new deployable. | `apps/stream-worker/src/interfaces/consumers/CollectorEventConsumer.ts`; `apps/stream-worker/src/main.ts:95,112,143` |
| Consent envelope field | **REUSE** the already-shipped first-class `consent_flags` field on `CollectorEventV1`. No new envelope. | `packages/contracts/src/events/sample.collector.event.v1.ts:89-96` |
| Audit | **REUSE** hash-chained `audit_log` via `DbAuditWriter`. `action='consent.withdrawn'`, `entity_type='consent_record'` are already enumerated as examples. | `packages/audit/src/index.ts:30,34` |
| RLS / NN-1 template | **REUSE** the verbatim NN-1 two-arg `PERMISSIVE FOR ALL TO brain_app` template + the assertion DO-block. No new RLS variant (doc 13 §13.1 = Reject). | `0017_identity_graph.sql:46-54,276-314` |
| Send-log | **EXTEND** `writeSendLog()` to carry the gate decision (`blocked_reason`, `pending_window`). | `apps/core/src/modules/notification/internal/send-log.ts` |

**Sweep result: CLEAN.** Everything extends a shipped seam; zero new deployables, zero new topics, zero new hashers, zero new RLS pattern.

> ASSUMPTION: this run ships the consent-suppressor as a SEPARATE consumer group (`stream-worker-consent-suppressor`) on the EXISTING `dev.collector.event.v1` topic, reading the already-present `consent_flags`. A dedicated `privacy.consent.withdrawn` topic (doc 13 §13.4 mentions it for the future CAPI-deletion consumer) is **deferred** — withdrawal in THIS slice is captured via (a) a `marketing:false` / absent flag on a collector event, and (b) an explicit operator/API withdrawal write to `consent_tombstone`. Adding a topic is "only if unavoidable"; it is avoidable here. CAPI-deletion + a withdrawal topic are explicit non-goals (req §Non-goals).

---

## 2. Migration 0032 — consent_record + consent_tombstone (additive, RLS FORCE, hashed keys)

**File:** `db/migrations/0032_consent_record_tombstone.sql` (next after `0031_connector_journey_stitch_map.sql`).
**Additive only (I-E02):** `CREATE TABLE IF NOT EXISTS`, `ALTER ... ADD COLUMN IF NOT EXISTS`. Down = `DROP TABLE IF EXISTS` reverse-FK order.

### consent_record — the 4-category lawful-basis SoR (append-only)

```sql
-- Subject key is HASHED (identity-core per-brand salt). NEVER raw email/phone. (I-S02)
CREATE TABLE IF NOT EXISTS consent_record (
  brand_id          UUID        NOT NULL,
  subject_hash      TEXT        NOT NULL,   -- sha256(per-brand-salt ‖ normalized email/phone); 64-hex; NEVER raw PII
  category          TEXT        NOT NULL
                      CHECK (category IN ('analytics','marketing','personalization','ai_processing')),
  state             TEXT        NOT NULL
                      CHECK (state IN ('granted','withdrawn')),
  source            TEXT        NOT NULL DEFAULT 'collector'
                      CHECK (source IN ('collector','operator','api','import','consent_manager')),  -- forward-compat (DPDP Rules ~Nov 2026)
  policy_version    TEXT        NOT NULL DEFAULT 'v1',     -- DPDP lawful-basis: which consent text was shown
  effective_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_event_id   UUID        NULL,                      -- idempotency anchor (collector event_id)
  PRIMARY KEY (brand_id, subject_hash, category, effective_at)   -- append-only; latest-wins by effective_at (doc 13 §13.4 PK shape, brain_id→subject_hash)
);
```

- **Append-only by GRANT** (mirrors `identity_audit`): `REVOKE ALL ... ; GRANT SELECT, INSERT ON consent_record TO brain_app;` — **no UPDATE/DELETE grant** (corrections = a new row with a later `effective_at`).
- **Idempotency:** `CREATE UNIQUE INDEX consent_record_event_dedup ON consent_record (brand_id, subject_hash, category, source_event_id) WHERE source_event_id IS NOT NULL;` → consumer writes `ON CONFLICT DO NOTHING` (replay-safe).
- **Lookup index:** `CREATE INDEX idx_consent_record_latest ON consent_record (brand_id, subject_hash, category, effective_at DESC);`
- **RLS:** `ENABLE` + `FORCE`; policy `consent_record_isolation AS PERMISSIVE FOR ALL TO brain_app USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid)` (NN-1 two-arg, verbatim from 0017).

> ASSUMPTION: doc 13 §13.4 specifies PK `(brand_id, brain_id, category, effective_at)`. This run keys on **`subject_hash`** (not `brain_id`) because the send path resolves a recipient email/phone → hash, not a `brain_id` (the notification chokepoint has the address, not the graph node). `subject_hash` is the same identity-core hash already stored as `identity_link.identifier_value`, so a `brain_id → subject_hash` join remains possible later. This is the I-S02-correct key for the chokepoint and does not regress the SoR.

### consent_tombstone — append-only withdrawal/erasure marker (drives fast-path suppression)

```sql
CREATE TABLE IF NOT EXISTS consent_tombstone (
  brand_id          UUID        NOT NULL,
  subject_hash      TEXT        NOT NULL,   -- hashed; NEVER raw PII
  category          TEXT        NULL        -- NULL = all marketing categories withdrawn; else a specific category
                      CHECK (category IS NULL OR category IN ('analytics','marketing','personalization','ai_processing')),
  reason            TEXT        NOT NULL DEFAULT 'withdrawal'
                      CHECK (reason IN ('withdrawal','erasure')),
  source            TEXT        NOT NULL DEFAULT 'collector'
                      CHECK (source IN ('collector','operator','api','consent_manager')),
  tombstoned_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_event_id   UUID        NULL,
  PRIMARY KEY (brand_id, subject_hash, COALESCE(category, '*'), tombstoned_at)
);
```
*(if a partial-coalesce PK is awkward, use a surrogate `tombstone_id UUID DEFAULT gen_random_uuid()` PK + the dedup unique index below — builder's call; either is additive.)*

- **Append-only by GRANT:** `GRANT SELECT, INSERT` only (no UPDATE/DELETE).
- **Idempotency:** `CREATE UNIQUE INDEX consent_tombstone_event_dedup ON consent_tombstone (brand_id, subject_hash, source_event_id) WHERE source_event_id IS NOT NULL;` → `ON CONFLICT DO NOTHING`.
- **RLS:** `ENABLE` + `FORCE`; same NN-1 two-arg policy.
- **Fast-path read:** `CREATE INDEX idx_consent_tombstone_subject ON consent_tombstone (brand_id, subject_hash);`

### Migration-tail asserts (REQUIRED in 0032)
1. The verbatim NN-1 assertion DO-block (copy `0017:276-314`) — fails the build on any one-arg policy.
2. A GRANT assertion: assert `has_table_privilege('brain_app','consent_record','UPDATE') = FALSE` and same for `DELETE` on both tables (append-only proof). Mirrors `0018` ledger assertion-2.

---

## 3. consent-suppressor consumer (stream-worker) + suppression-state read seam

**Pattern:** verbatim copy of the separate-consumer-group discipline. Consumes the EXISTING
`dev.collector.event.v1`, filters to events that carry `consent_flags` (and an identifiable subject),
hashes the subject via identity-core (server-side salt from `SaltProvider`), and projects into
`consent_record` + `consent_tombstone`. **No new topic. No new deployable.** New consumer group:
`stream-worker-consent-suppressor`.

**Suppression rule (the projection, fail-closed):** for `(brand_id, subject_hash, category)`, the subject
is **SUPPRESSED** for a marketing/messaging purpose when the **latest** `consent_record.state != 'granted'`
**OR** a `consent_tombstone` exists for that subject covering the category (or category=NULL).
Default when no record exists at all = **SUPPRESSED** (no row = no consent = fail-closed). The suppression
state is **derived by query** from the two tables (no separate materialized suppression table needed —
DPDP <15min SLA is met because the read seam queries the SoR directly; a row appears the instant the
consumer commits). This is the simplest reversible design.

**Offset-commit discipline:** copy `CollectorEventConsumer` D-7 — commit ONLY after the DB write (or dedup
hit) is confirmed; on write error, do not commit (retry → DLQ after MAX_RETRY). Idempotent via the
`source_event_id` dedup unique indexes → `ON CONFLICT DO NOTHING`.

**Suppression-state read seam** (consumed by the can_contact engine in core via a query, NOT a cross-service
DB read of stream-worker's store — both read the same `core` Postgres, which is the consent SoR owner;
stream-worker WRITES it, core READS it, same DB, per the existing identity pattern where stream-worker
writes `customer`/`identity_link` and core reads them):

```ts
// packages/contracts/src/consent/suppression.ts — the shared contract (Single-Primitive)
export interface SuppressionQuery {
  isSuppressed(args: {
    brandId: string; subjectHash: string; category: ConsentCategory;
  }): Promise<{ suppressed: boolean; reason: 'no_consent' | 'withdrawn' | 'tombstoned' | null }>;
}
```
Implemented once in `apps/core` (the notification module's infrastructure) against `consent_record` +
`consent_tombstone` with the brand GUC set. The stream-worker side only WRITES; the read seam lives in core
where the gate runs.

> ASSUMPTION: `consent_record`/`consent_tombstone` live in the `core` Postgres (the OLTP SoR DB), written
> by the stream-worker consumer with `SET LOCAL app.current_brand_id` per row (mirrors how
> `IdentityBridgeConsumer`/`LiveLedgerBridgeConsumer` set the brand GUC before writing `customer`/ledger in
> the same DB). This is the EXISTING cross-app, single-DB ownership pattern in this monorepo — not a new
> cross-service DB read.

---

## 4. The real can_contact() compliance engine (inside the notification module — no new service)

Replaces the `return true` stub. Lives as a **`compliance` bounded context inside the notification module**
(`apps/core/src/modules/notification/internal/compliance/`), DDD policies — each check is a `Policy`.

### Extended signature (channels expanded; transactional stays exempt)

```ts
export type ContactChannel =
  | 'transactional_email'   // consent-EXEMPT (TCCCPR transactional carve-out) — documented
  | 'marketing_email'
  | 'whatsapp'              // Phase-1 Scheduled Delivery Channel (Morning Brief)
  | 'sms';                  // Phase-3 seam (DLT) — slots in with no redesign

export type ContactPurpose = 'transactional' | 'marketing';

export interface CanContactResult {
  decision: 'allow' | 'block' | 'queue_pending_window';
  reason:
    | 'transactional_exempt' | 'allowed'
    | 'consent_absent' | 'consent_withdrawn'
    | 'dlt_unregistered' | 'ncpr_dnd' | 'unknown'        // default-closed reasons
    | 'out_of_window';
  releaseAfter?: string;   // ISO ts when a pending_window item flushes (next 9am IST)
}

canContact(recipient: string, channel: ContactChannel, purpose: ContactPurpose): Promise<CanContactResult>;
```

### Ordered checks — DEFAULT-CLOSED at every step (the engine)

1. **Transactional exemption.** `purpose==='transactional'` (e.g. `transactional_email`) → `allow` (`transactional_exempt`). The TCCCPR carve-out. (Withdrawal of MARKETING consent never blocks transactional — COMPLIANCE.md:106.) This is the ONLY allow-without-consent path.
2. **Hash the recipient** via identity-core `hashIdentifier(recipient, type, perBrandSalt)` (type from channel: email→`email`, whatsapp/sms→`phone`). Salt fetch fails → **HARD CRASH** (D-2), not a silent allow.
3. **Consent check** (marketing/messaging): `SuppressionQuery.isSuppressed({brandId, subjectHash, category:'marketing'})`. Suppressed (no row / withdrawn / tombstoned) → **`block`** (`consent_absent`/`consent_withdrawn`). No row = blocked (fail-closed).
4. **DLT template-approval seam** (sms/whatsapp): `DltRegistryPort.isTemplateApproved(brandId, channel, templateId)`. **Default-closed stub returns `false`** until real TRAI/Meta-BSP registration lands → **`block`** (`dlt_unregistered`). NEVER fakes approval.
5. **NCPR/DND seam:** `NcprRegistryPort.isOnDnd(brandId, subjectHash)`. **Default-closed stub returns `false` (not-on-DND) is WRONG for fail-closed** — instead the stub returns `unknown` → treated as **`block`** (`unknown`). A number whose DND status is unknown is NOT contacted (COMPLIANCE.md: "A number on the NCPR must never receive a commercial communication"). For email-only Phase-1 this check is skipped (NCPR is a telecom registry; email channel → not applicable, documented).
6. **Send-window (9am–9pm IST, Asia/Kolkata) — SERVER-side at the queue:** compute `now` in `Asia/Kolkata`. Inside `[09:00, 21:00)` → **`allow`**. Outside → **`queue_pending_window`** with `releaseAfter = next 09:00 IST`. NEVER `block`-and-drop, NEVER send out-of-window. Unknown/unparseable time → fail-closed `block` (`unknown`).

**The default-closed invariant:** any check that cannot affirmatively resolve `granted/approved/in-window`
returns `block` (or `queue` for the window). There is no code path where an unknown produces `allow`.

### pending_window queue

`pending_window` is a server-side queued state, NOT a UI hint. Implementation reuses the EXISTING send-log
seam plus a queue table is **avoided** in this slice by storing the queued intent in
`send_log` with `status='pending_window'` + `release_after` (extend `send-log.ts` + the additive
`send_log` columns). A scheduler (Argo cron / in-service handler, NOT a new deployable) at 09:00 IST
re-evaluates each `pending_window` row through `canContact` again (re-checks consent + tombstone — a
withdrawal between queue and flush MUST suppress, COMPLIANCE.md:106) and flushes only those that now `allow`.

> ASSUMPTION: there is no shipped `send_log` table yet (`send-log.ts` currently console-logs only). This
> run lands `send_log` as additive migration content within 0032 (or a sibling 0033 if the builder prefers
> separation) carrying `status` (incl. `pending_window`), `release_after`, `blocked_reason`, hashed
> recipient only (no raw email — extend the current `recipient_masked` discipline to a `subject_hash`
> column). The 9am-IST flush handler is an in-service scheduled handler, not a new app (I-E05).

### DLT / NCPR dev-honesty boundary

`DltRegistryPort` + `NcprRegistryPort` are **ports** (interfaces in the compliance domain). The shipped
impls are **default-closed stubs** (`StubDltRegistry` → always `templateApproved=false`;
`StubNcprRegistry` → always `dndStatus='unknown'`) that **block, never fake approval**. The boundary is
documented inline + in the journal: "real TRAI DLT template registration and NCPR/DND registry are
platform follow-ups; the seam is built, the stub is fail-closed." Phase-3 SMS and Phase-6 CAPI slot behind
the same ports with zero redesign. Audit every `block`/`queue`/`allow` decision via `DbAuditWriter`
(`action='notification.can_contact'`, `entity_type='consent_record'`, payload = `{decision, reason,
channel, purpose, subject_hash}` — hashed, no raw PII).

---

## 5. UI — per-brand Consent / Compliance view (mandatory, stakeholder-visible)

Next.js App Router page under the dashboard group; data via the BFF (apps/web calls ONLY the BFF).
shadcn/Radix/Tailwind; honest empty states; accessible (a11y).

- **Route:** `apps/web/app/(dashboard)/settings/consent/page.tsx` + `consent-compliance-content.tsx`.
- **Panels:** (1) Consent coverage — granted/withdrawn counts per `category × channel` (from `consent_record` latest-state aggregate). (2) Suppression count — subjects suppressed for marketing (tombstones + no-consent). (3) DND / send-window config — the 9am–9pm IST window shown read-only (it is server-enforced, not editable here; labeled "enforced server-side"). (4) can_contact gating status — last-N gate decisions by reason (allow / block:consent_absent / queue:pending_window / block:dlt_unregistered), proving default-closed visibly. Empty state when no consent rows: "No consent records yet — sends are blocked by default (fail-closed)."
- **BFF endpoints** (additive, in `bff.routes.ts`, brand-scoped, X-Brand-Id asserted): `GET /api/v1/consent/coverage`, `GET /api/v1/consent/suppression-summary`, `GET /api/v1/consent/gate-activity`, `GET /api/v1/consent/window-config`.
- **Aggregate use-cases** live in core's consent/notification read path (query `consent_record`/`consent_tombstone`/`send_log` with the brand GUC). No raw PII surfaced — counts + hashes only.

---

## 6. The three tracks (exact file targets, 2–5 min tasks)

### Track A — @data-engineer (migration + suppressor consumer + read seam)
- `db/migrations/0032_consent_record_tombstone.sql` — CREATE `consent_record` + `consent_tombstone` (§2); RLS ENABLE+FORCE; NN-1 two-arg policies; append-only GRANTs (no UPDATE/DELETE); dedup unique indexes; NN-1 assertion DO-block (copy `0017:276-314`); GRANT assertion. (Also lands additive `send_log` table + `status/release_after/blocked_reason/subject_hash` columns unless split to 0033.)
- `apps/stream-worker/src/interfaces/consumers/ConsentSuppressorConsumer.ts` — copy `CollectorEventConsumer` D-7 commit discipline; filter `consent_flags`-bearing events; hash subject via identity-core + `SaltProvider`; project into `consent_record` (+ `consent_tombstone` on `marketing:false`/absent) with `SET LOCAL app.current_brand_id`; `ON CONFLICT DO NOTHING`.
- `apps/stream-worker/src/application/ProjectConsentUseCase.ts` — the pure projection (event → consent rows); no I/O in domain logic.
- `apps/stream-worker/src/main.ts` — wire `ConsentSuppressorConsumer` with group `stream-worker-consent-suppressor` on `topic` (the existing `dev.collector.event.v1`); add to the `start`/`stop` lifecycle (mirror lines 95/112/212).
- `packages/contracts/src/consent/suppression.ts` — `SuppressionQuery` interface + `ConsentCategory` type (Single-Primitive read seam).
- `apps/stream-worker/src/tests/consent-suppressor.e2e.test.ts` — live test: a `consent_flags.marketing=false` event → suppression; a tombstone → suppressed; replay idempotent; **`SET ROLE brain_app`** isolation NON-INERT (a cross-brand subject_hash returns 0 rows under `brain_app`).

### Track B — @backend-developer (the can_contact compliance engine + write paths)
- `apps/core/src/modules/notification/service.ts` — extend `canContact` signature (§4): `ContactChannel`, `ContactPurpose`, `CanContactResult`.
- `apps/core/src/modules/notification/internal/compliance/can-contact.engine.ts` — the ordered, default-closed engine (steps 1–6).
- `apps/core/src/modules/notification/internal/compliance/policies/` — `consent.policy.ts`, `send-window.policy.ts` (9–9 IST, Asia/Kolkata), `dlt.policy.ts`, `ncpr.policy.ts` (each a DDD Policy).
- `apps/core/src/modules/notification/internal/compliance/ports.ts` — `SuppressionQuery` impl (queries `consent_record`/`consent_tombstone`), `DltRegistryPort`, `NcprRegistryPort`.
- `apps/core/src/modules/notification/internal/compliance/stubs.ts` — `StubDltRegistry` (approved=false), `StubNcprRegistry` (dnd=unknown) — default-closed, dev-honest.
- `apps/core/src/modules/notification/internal/notification.service.impl.ts:168-172` — replace the stub `canContact` with a delegation to the engine; audit each decision via `DbAuditWriter`.
- `apps/core/src/modules/notification/internal/send-log.ts` — extend `SendLogEntry` with `status:'pending_window'`, `releaseAfter`, `blockedReason`, `subjectHash` (drop raw `recipient`, store hash); real INSERT into `send_log`.
- `apps/core/src/modules/notification/internal/pending-window.handler.ts` — the 09:00-IST in-service flush handler: re-run `canContact` per `pending_window` row, flush only `allow`.
- Consent write path (operator/API): `apps/core/src/modules/notification/internal/compliance/consent-write.ts` — record `consent_record`/`consent_tombstone` from an operator/API action (the non-collector `source`), GUC-scoped, audited.
- `apps/core/src/modules/notification/tests/can-contact.engine.test.ts` — default-closed proof for EVERY unknown; transactional exempt; out-of-window → `queue_pending_window` with next-9am `releaseAfter`; withdrawal-between-queue-and-flush suppresses.

### Track C — @frontend-web-developer (the consent/compliance UI)
- `apps/web/app/(dashboard)/settings/consent/page.tsx` — server component shell.
- `apps/web/app/(dashboard)/settings/consent/consent-compliance-content.tsx` — the 4 panels (§5); loading/empty/error states.
- `apps/web/components/consent/coverage-card.tsx`, `suppression-card.tsx`, `send-window-card.tsx`, `gate-activity-table.tsx` — shadcn/Radix.
- `apps/web/lib/api/` (extend `client.ts`/`types.ts`/`schemas.ts`) — typed fetchers for the 4 BFF endpoints.
- `apps/core/src/modules/frontend-api/internal/bff.routes.ts` — add the 4 brand-scoped consent endpoints (§5) + aggregate use-cases.
- `apps/web/e2e/` — Playwright: empty state shows fail-closed copy; coverage renders; gate-activity shows a `block:consent_absent` row.

### Deploy-pipeline track (folded into A/B/C — no follow-up)
No new service. Changed deployables: **core** (Track B+C BFF), **stream-worker** (Track A), **web** (Track C).
Each builder's slice MUST include the affected-only build + per-service container image + per-service deploy
app + canary + auto-rollback for ITS changed deployable (core / stream-worker / web). No deploy-all.

---

## 7. Acceptance contract (REQUIRED pass-1 — all persona must-fix folded in)

1. **can_contact is the SOLE gate (I-ST05):** no channel adapter has a direct send path; every send calls `canContact` first. Verified by a grep-test that no SES/WhatsApp call exists outside the notification module.
2. **DEFAULT-CLOSED:** unknown consent / unknown DLT / unknown DND / unknown window → NOT send. A test asserts EVERY `unknown`/absent input yields `block` or `queue`, never `allow`. `non_consented_sends=0`, `out_of_window_send_attempts=0` provable.
3. **pending_window:** out-of-window → queued + flushed at 09:00 IST, never dropped, never out-of-window. A withdrawal between queue and flush suppresses (re-check on flush).
4. **Suppression on tombstone:** a `consent_tombstone` write → `isSuppressed=true` for the category within the consumer commit (<15min SLA trivially met — direct SoR read).
5. **Isolation NON-INERT under `brain_app`:** every consent isolation test runs `SET ROLE brain_app` (superuser `brain` BYPASSES → proves nothing; MEMORY: dev-db-superuser-masks-rls). Cross-brand `subject_hash` returns 0 rows.
6. **PII:** subject keys are identity-core hashes; raw email/phone NEVER in `consent_record`/`consent_tombstone`/`send_log`/logs/audit payload. No-PII discipline on every new column.
7. **Additive only:** 0032 is `IF NOT EXISTS`/`ADD COLUMN`; append-only-by-GRANT asserted (no UPDATE/DELETE grant); NN-1 assertion DO-block present and passing.
8. **No new deployable / topic / hasher / RLS pattern / second consent model** (I-E05; doc 13 §13.1/§13.2/§13.4).
9. **Dev-honesty:** DLT/NCPR are default-closed stubs that block — never fake approval; boundary documented.
10. **UI ships:** the per-brand consent/compliance view renders with honest empty (fail-closed) copy; accessible; data via BFF only.
11. **Real network smoke:** the suppressor consumer e2e runs against a real Redpanda + Postgres (not a mock); gate decisions audited to the real `audit_log`.

---

## 8. Alternative considered + rejection

**Alt: a dedicated `consent_suppression` materialized table** (consumer maintains a denormalized current-state
row per subject×category). **Rejected:** it adds a second source of truth to keep consistent with the
append-only SoR, risks the suppression lagging a just-written tombstone (defeats the <15min fail-closed SLA),
and is not needed — a direct latest-state query over `consent_record` + a tombstone existence check meets the
SLA and is strictly more reversible (no projection to rebuild). Revisit only if read volume demands it (a
later, reversible optimization behind the same `SuppressionQuery` seam).

**Reversibility:** 0032 is additive; down-migration drops the two tables. The engine replaces a stub behind an
unchanged chokepoint; reverting = restore `return true` (a one-line stub) — fully reversible.

## 9. Cost estimate

LLM tokens: **0/day, $0/mo** (deterministic). Infra delta: one consumer group on an existing topic in the
existing stream-worker pod (no new pod), + 2 small OLTP tables + additive columns. Negligible spend (<$5/mo
incremental DB + consumer CPU). No model, no new deployable, no new topic.

---

## Journal

```markdown
## 2026-06-18T13-58-47Z — Architect — feat-d13-consent-cancontact
**Stage:** 2 · **Paradigm:** deterministic-logic (0 tokens; a fail-closed compliance gate must be reproducible — no model/ML) · **Tracks:** A @data-engineer (0032 consent_record/tombstone + ConsentSuppressorConsumer + SuppressionQuery seam) ∥ B @backend-developer (can_contact engine: consent→DLT→NCPR→9-9-IST window, default-closed + pending_window + dev-honest DLT/NCPR stubs) ∥ C @frontend-web-developer (per-brand consent/compliance UI via BFF)
**Single-Primitive:** clean — extended canContact (no 2nd gate), reused identity-core hasher, the CollectorEventConsumer pattern, the shipped consent_flags envelope, audit_log, the NN-1 RLS template; zero new deployable/topic/hasher/RLS variant
**Migration:** 0032 (next after 0031) · subject_hash key (chokepoint has the address, not brain_id) · RLS FORCE + NN-1 two-arg + append-only GRANT + assertions
**DLT/NCPR boundary:** ports + default-closed stubs (block, never fake) — real TRAI DLT + NCPR registry are platform follow-ups
**Next:** @data-engineer ∥ @backend-developer ∥ @frontend-web-developer — Stage 3 (dev-parallel)
```
</content>
</invoke>
