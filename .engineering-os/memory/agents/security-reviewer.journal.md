
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
## 2026-06-17T20:56:14Z — Security Reviewer — feat-razorpay-settlement-connector
**Stage:** 4 · **Mode:** FULL · **Verdict:** BOUNCE
**Findings:** CRIT 0 / HIGH 1 (SEC-RZ-H1) / MED 1 / LOW 1 · **Scanners:** diff secret-grep + C5 raw-ID grep run (clean); full SAST/SCA = CI gate (not local) · **Next:** data-engineer wires no-pci-card-fields into eslint.config.mjs + log-grep-patterns.json into nightly CI → DELTA re-review
**Verified live under brain_app (non-bypassed):** map-table FORCE RLS no-GUC negative control = 0 (non-inert, superuser sees rows); SECURITY DEFINER enumeration returns connected-only with no GUC (durable rule system-job-force-rls-enumeration satisfied); cross-brand = 0. HMAC-first anti-spoof (brand from DB ROW), replay age+Redis dedup, C1 boundary-hash, C4 mapper allowlist (43/43 unit), MB-4 wiring (e2e RED when un-wired) all PASS. BOUNCE is the dead C4 lint + C5 log-grep gates (bound as mandatory CI gates; primary controls live so no active leak).
