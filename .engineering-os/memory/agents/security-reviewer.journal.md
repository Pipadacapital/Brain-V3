
## 2026-06-18T00:00:00Z — Security Reviewer — feat-collection-foundation
**Stage:** 4 · **Mode:** FULL · **Verdict:** PASS
**Findings:** CRIT 0 / HIGH 0 / MED 0 / LOW 2 · **Scanners:** secret-grep run (clean); container/SCA suite is the Stage-8 CI gate · **Model:** Opus 4.8 (1M)
- R2 keystone PASS non-inert: brand_id DERIVED server-side via 0028 resolve_brand_by_install_token (SECURITY DEFINER, search_path=public, brain_app EXECUTE, dispatch-only); cross-brand claim → quarantined + audit + .quarantine produced, 0 Bronze rows under brain_app (assertBrainApp guard). Connector/backfill lanes opt out (enforceTenantDerivation=false).
- R3 PASS: absent consent_flags → quarantined (not dropped/Bronze); consent-propagation + no-pii-schema-lint CI gates wired + non-inert.
- ADR-2 PASS: no PII/no salt in SDK or collector_spool; no Set-Cookie on /collect or /pixel.js (grep clean).
- Edge PASS: per-install_token rate-limit + origin allowlist reject-before-spool, stateless.
- R4 PASS: collector_dedup_conflict_total observable; malformed→DLQ.
- Read-path PASS: BFF reads via withBrandTxn, brand from session, no raw PII, cross-brand=0 under brain_app.
- LOW SEC-CF-01: dedup-observability test asserts metric directly, not through consumer (control itself correct). LOW SEC-CF-02: audit_log test-read via superuser (RLS-disabled forensic table, acceptable).
**Next:** reconcile with QA (QA PASS already logged 22:09:47Z) → advance.
