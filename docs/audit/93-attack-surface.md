# Attack Surface Map

Consolidated from the Security (08), Compliance (16), Negative (15), Database (04), and API (03) boards. Organized by trust boundary, outermost first.

---

## What is genuinely well-defended (do not regress)

The auth/token/secrets/webhook spine is principal-grade and scans came back clean:

- **Auth:** argon2id with dummy-hash timing safety, enumeration-safe, rotating refresh tokens with family-wipe on reuse.
- **Webhooks:** HMAC-first ordering, server-derived `brand_id` (not from body), constant-time compare.
- **Tokens:** brand_id sourced from verified JWT (not body) — a real cross-tenant defense; alg-confusion closed; header pinned; constant-time payload compare.
- **CSRF:** HMAC-session-bound. **OAuth callbacks:** state-protected.
- **Secrets:** per-brand CMK, ARN-only DB rows, KMS hard-fail in prod.
- **Audit:** hash-chained append-only with PII masking.
- **Consent:** `can_contact()` default-closed, no unknown-to-allow path; append-only-by-GRANT SoR with RLS.
- Injection and token-in-log scans: clean.

---

## Trust boundary 1 — The database / tenant isolation (THE primary weakness)

| Surface | State | Exploit path | Risk |
|---|---|---|---|
| OLTP RLS enforcement | **BROKEN** — app connects as superuser; FORCE RLS bypassed unconditionally | Any missing/wrong app-WHERE → full cross-brand read of revenue/identity/PII/consent/spend | RISK-002 |
| `@brain/db` GUC middleware | **BROKEN** — `SET LOCAL` outside txn; GUC never applies | Under brand_app every read fails-closed (0 rows); if hot-patched with BYPASSRLS, isolation collapses to app-WHERE-only | RISK-003 |
| Collector ingest write path | **BROKEN** — no `SET ROLE brain_app`, default superuser DSN | Unfiltered spool read/write is cross-tenant on the ingest path | RISK-049 |
| StarRocks Silver/Gold | **No engine row policy** — one app seam (`${BRAND_PREDICATE}` sentinel) | One forgotten sentinel in a new metric/DQ query = cross-brand analytics leak, no DB backstop | RISK-024 |
| StarRocks credential | **Weak default** — `brain_analytics_dev` hardcoded, no fail-closed guard | Misconfigured prod → all brands' Silver reachable with repo-known password | RISK-025 |
| `dev_secret` table | **No RLS, full DML to brain_app, runs every env** | Cross-tenant connector OAuth token store; any brand context reads all tokens | RISK-037 |
| `collector_spool` | **No brand_id, no RLS, PII raw bodies, never purged** | Cross-tenant unfiltered reads; GDPR/DPDP erasure can't target a tenant | RISK-009 |

**Net:** the isolation *design* (FORCE RLS, two-arg fail-closed, migration assertions) is excellent, but the *enforcement* is absent at the running layer. This is the single highest-priority security item. **The primary isolation control has never been validated against the production `brain_app` role.**

## Trust boundary 2 — The API edge

| Surface | State | Risk |
|---|---|---|
| Idempotency-Key | Unenforced on most mutations; connector-connect & consent-write duplicate rows on retry; silent `?? randomUUID()` fallback | RISK-022 |
| Rate limiting | None on read/NLQ surface (incl. LLM-backed `/ask`); only auth IP/email paths, and that fails OPEN on Redis error | RISK-023, RISK-041 |
| Error envelope | No `trace_id`; correlation-id never echoed → support can't correlate | RISK-021 |
| RBAC | Role trusted from JWT claim; demotion not reflected for ≤1h | RISK-054 |
| Consent `/check` | Non-idempotent POST writes audit_log every call, no rate limit → audit-log flooding | API-M |
| Domain `/api/v1/*` + MCP | Largely unbuilt; external/partner/MCP clients get 404s | RISK-020 |

## Trust boundary 3 — Identity / PII at rest

| Surface | State | Risk |
|---|---|---|
| `contact_pii` vault | **Plaintext at rest**, no `pii_ciphertext`, no DELETE grant | Snapshot/backup leak exposes plaintext email/phone/name for every brand | RISK-010 |
| Per-brand salt | Guard-by-convention across 8+ sites; prod KMS path dead, returns `''` fail-open by default | One forgotten guard → identical cross-brand hashes (D-2 violation) | DEBT-E2 |
| Erasure | **No pipeline** — no crypto-shred, no surrogate, dead is_active toggle | Bad merge / erasure request irreversible; statutory right unfulfillable | RISK-010 |
| DSAR / export | **Not implemented** | Right-to-access & portability unmet | RISK-053 |

## Trust boundary 4 — Supply chain / deploy

| Surface | State | Risk |
|---|---|---|
| Checkov policy gate | 16-ID allowlist → hundreds of checks silently disabled (open SG, IAM `*:*`, IMDSv2) | Wide class of misconfig passes the gate | RISK-044 |
| OIDC trust | ECR push role never created; trust scoped to `main` but plan gate runs on PRs | Plan-time policy gate dead on PRs; build AssumeRole fails | RISK-045 |
| AI safety gate | `eval.yml` is `echo TODO` — NLQ/injection/narration golden-sets unenforced | Prompt-injection / decision regressions ship unblocked | RISK-046 |
| Audit WORM anchor | Claimed in Canon, not implemented; chain forks under concurrency | DB-superuser tamper undetected; chain-walk paging does not exist | RISK-052 |

---

## Adversary scenarios (from the negative + security boards)

1. **"Exfiltrate one tenant's data"** — trivially plausible the moment any app-WHERE is missed, because the DB enforces nothing (RISK-002). The auditor's primary attack is *open*.
2. **"Hammer the LLM endpoint"** — `/ask` has no per-brand rate limit and defaults to Opus with no cap → cost-amplification DoS on shared infra (RISK-023/047).
3. **"Reach :9030 on a misconfigured deploy"** — StarRocks weak default credential + no row policy → all-brand commerce data (RISK-024/025).
4. **"Demand erasure to test compliance"** — cannot be honored; PII is plaintext and there is no destruction path; the Canon claims otherwise (RISK-010).
5. **"Flood the spool during a Redpanda stall"** — unbounded, brand-id-less spool fills shared RDS → platform-wide write outage (RISK-009).

## Priority security remediation

1. **NOSUPERUSER `brain_app` + transactional GUC, proven under brand_app in CI** (RISK-002/003/049) — without this, nothing else in this map matters.
2. Fail-closed StarRocks query gateway + credential guard (RISK-024/025).
3. RLS + brand_id + retention on `dev_secret` and `collector_spool` (RISK-037/009).
4. Idempotency + per-brand rate limiting on the API edge incl. `/ask` (RISK-022/023).
5. `pii_ciphertext` KMS vault + reconcile `COMPLIANCE.md` to reality (RISK-010).
6. Restore Checkov full check set; fix OIDC trust; make `eval.yml` real (RISK-044/045/046).
