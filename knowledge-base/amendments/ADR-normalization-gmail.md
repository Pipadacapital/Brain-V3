<!-- SPEC: A.1.3 -->
# ADR — Email normalization does NOT strip Gmail dots or plus-tags (A.1.3 / WA-06)

**Status:** ACCEPTED (spec-mandated: §A.1.3 "Do NOT strip Gmail dots/plus-tags (ADR)")
**Date:** 2026-07-06
**Owner:** packages/identity-normalization + db/iceberg/spark/_identity_normalization.py

## Decision
Email normalization is exactly: strip edge whitespace, lowercase, NFC-normalize — nothing
provider-specific. `f.irst+tag@gmail.com` and `first@gmail.com` are DIFFERENT identifiers
and produce different hashes in both AMD-01 hash spaces.

## Why not strip
1. **Deliverability truth ≠ identity truth.** Gmail treats `a.b+t@gmail.com` as the same
   MAILBOX as `ab@gmail.com`, but the CUSTOMER chose to present a distinct identifier;
   plus-tags in particular are used intentionally to segment merchants. Folding them merges
   identities the customer deliberately separated — a silent, irreversible over-merge in a
   system where merge is audited and reversible (§A.2.4).
2. **Provider-sniffing is unbounded and wrong.** Dot-insensitivity is a Gmail-ism (and
   googlemail.com alias-ism); it is NOT true for most providers. A correct implementation
   needs an ever-stale provider list and breaks the "one normalization, two hash spaces"
   simplicity that keeps the TS/Python twins byte-identical.
3. **Interop-space compatibility (AMD-01).** The interop hash must equal what OTHER parties
   (pixel client-side today; platforms tomorrow) compute. The industry convention for
   pre-hashed email exchange (e.g. Meta CAPI `em`) is trim+lowercase+sha256 — no Gmail
   folding. Stripping would orphan our interop hashes from every external counterpart.
4. **Determinism/replay.** Bronze replays must re-derive identical hashes forever; a
   provider-behavior-dependent rule makes historical hashes hostage to provider changes.

## Consequence accepted
A user who checks out as `a.b@gmail.com` once and `ab@gmail.com` later is NOT
deterministically linked by email hash alone. That linkage is the job of the OTHER
identity signals (phone, platform_customer_id, anonymous_id, checkout_session_id) and the
quarantined probabilistic layer (§A.3) — never of lossy normalization.
