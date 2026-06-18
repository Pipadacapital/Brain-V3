# 05 — Architecture: Onboarding captures website → auto-provisions per-brand pixel

**req_id:** `feat-onboarding-website` · **Stage:** 2 (Architect) · **Lane:** high_stakes (multi_tenancy)
**Paradigm:** deterministic logic only (string/URL normalization + an INSERT-or-return). No statistical/ML/model call anywhere — the cheapest sufficient tier. Justification: canonical-host derivation is a pure deterministic function; provisioning is a unique-keyed upsert. A model call here would be a paradigm-bypass.

---

## 0. The decisive grounding (why this is the smallest plan)

Every heavy primitive this requirement needs **already exists**; the slice is wiring + one shared util + UI:

| Capability | Already in code | `file:line` |
|---|---|---|
| Idempotent per-brand pixel provision | `GetOrCreatePixelInstallationCommand` — idempotent on `brand_id`, mints server-side `install_token` uuid, creates `pixel_status`, emits `pixel.installed` | `apps/core/src/modules/connector/pixel/application/commands/GetOrCreatePixelInstallationCommand.ts:34-90` |
| 1:1 brand:installation guarantee | `UNIQUE (brand_id)` on `pixel_installation` | `db/migrations/0007_pixel.sql:26` |
| Tenant-key derivation (server never trusts client brand_id) | `resolve_brand_by_install_token(uuid)` SECURITY DEFINER | `db/migrations/0028_resolve_brand_by_install_token.sql` |
| Brand create / update + audit | `BrandService.create` / `.update` | `apps/core/src/modules/workspace-access/internal/application/brand.service.ts:45,187` |
| Snippet builder + read endpoints | `buildDefaultSnippet`, `GET /api/v1/pixel/installation`, `POST /verify`, `GET /health` | `apps/core/src/modules/connector/pixel/interfaces/http/pixelRoutes.ts:129`; `apps/core/src/main.ts:1029` |
| Tracking Center surface | `TrackingCenter` → `PixelWizard` (already has provision + snippet + verify) | `apps/web/components/pixel/tracking-center.tsx`; `apps/web/components/pixel/pixel-wizard.tsx` |

**The only real gaps:**
1. `BrandService.create`/`.update` persist `brand.domain` but never call the provisioner → a brand finishes onboarding with no `pixel_installation`.
2. Host normalization is done **client-side and inconsistently** (`pixel-wizard.tsx:70-71` does `new URL(rawDomain).host`; the create form does none) → the same site typed three ways can yield three `target_host` strings, but the token must key off ONE canonical host.
3. The onboarding flow has no "tracking ready / add website" surface (Deliverable 3).

**> ASSUMPTION:** the requirement floated a possible `(brand_id, target_host)` partial unique index. Under the Stakeholder-confirmed **1:1 brand:website**, the existing `UNIQUE(brand_id)` (0007:26) is already the correct and stronger idempotency key (a brand can hold exactly one row, period). **No migration is needed.** Adding a `(brand_id, target_host)` index would *weaken* 1:1 (it would permit a second row on a different host) and is therefore explicitly rejected here — see ADR-3. The 1:N future is unblocked at the schema level later by dropping `UNIQUE(brand_id)` and adding the composite; that is a deferred non-goal.

---

## 1. ADR-1 — Canonical-host normalization (the deterministic rule)

**Decision.** One shared, pure, server-authoritative function `normalizeBrandHost(input: string): string | null`. It is the **single source of truth**; the FE may mirror it for live preview but the **server value wins** and is what gets persisted to `brand.domain` and used as `target_host`. Lives in `@brain/pixel-sdk` (already a shared package consumed by both core and web → no new package, satisfies Single-Primitive).

### Algorithm (exact, ordered)
```
normalizeBrandHost(raw):
  1. if raw == null or raw.trim() == ""      → return null      (skip-for-now path)
  2. s = raw.trim()
  3. if s has no "://" scheme separator       → s = "https://" + s   (bare "shop.com" → parseable)
  4. parse u = new URL(s)                      → on throw, return null (invalid)
  5. if u.protocol not in {http:, https:}      → return null      (reject mailto:, ftp:, javascript:, data:)
  6. host = u.hostname                          (drops scheme, path, query, fragment, port, userinfo, trailing slash — URL does this for us)
  7. host = host.toLowerCase()
  8. host = host via URL's built-in IDN→punycode (u.hostname already returns ASCII/punycode for IDN, e.g. "münchen.de" → "xn--mnchen-3ya.de")
  9. strip a single leading "www."  →  host = host.replace(/^www\./, "")   (ADR-2 decides this; canonical host excludes www)
 10. if host == "" or host has no "." or host == "localhost"  → return null  (must be a real registrable host; reject "localhost", bare TLD-less)
 11. if host.length > 253                       → return null     (matches brand.domain max(253), contracts brand.api.v1.ts:28)
 12. return host
```

### Edge-case table (these become the test matrix — REQUIRED pass-1)
| Input | Output | Note |
|---|---|---|
| `https://MyStore.com/products?ref=x` | `mystore.com` | scheme+path+query+case stripped |
| `mystore.com` | `mystore.com` | bare host gets scheme prepended then parsed |
| `http://www.mystore.com/` | `mystore.com` | www stripped, trailing slash gone |
| `HTTPS://Shop.MyStore.CO.UK` | `shop.mystore.co.uk` | subdomain preserved (only leading `www.` stripped) |
| `münchen.de` | `xn--mnchen-3ya.de` | IDN→punycode via URL.hostname |
| `https://店铺.example` | `xn--...example` | punycode-safe |
| `https://mystore.com:8443/` | `mystore.com` | port dropped |
| `  mystore.com  ` | `mystore.com` | trimmed |
| `""` / `"   "` / `null` | `null` | skip-for-now (first-class, no error) |
| `not a url` / `ftp://x` / `javascript:alert(1)` / `mailto:a@b.com` | `null` (invalid → form error) | scheme allowlist + parse guard |
| `localhost` / `http://localhost:3000` | `null` | not a registrable host |
| `https://192.168.1.1` | `null` | **> ASSUMPTION:** reject bare IPs for M1 (step 10 "has a dot" passes, so add explicit IPv4/IPv6 reject in step 10). A storefront is a domain, not an IP. Reversible: relax later if a customer needs it. |

**Determinism contract:** `normalizeBrandHost(x) === normalizeBrandHost(normalizeBrandHost(x))` (idempotent) for all non-null outputs. This is the test that proves "same site typed three ways → one canonical host → one token."

**Two outcomes, two behaviours:** `null` from a **non-empty** input = validation error (422 / form error "Enter a valid website"). `null` from an **empty/absent** input = the legitimate **skip-for-now** path (no error, no provision).

---

## 2. ADR-2 — Strip leading `www.` from the canonical host

**Decision:** canonical host excludes a single leading `www.`. **Rejected alternative:** keep `www.` as typed. **Why strip:** `www.mystore.com` and `mystore.com` are the same storefront; keeping both would let a re-edit "change the host" and (under a future 1:N) mint a second token for the same site — exactly the duplicate the requirement forbids. The pixel's `/pixel.js` runs on whatever host serves the page; `target_host` is a **verify/display** hint (0004:21 "pixel-verify target host"), not an origin allowlist, so stripping `www.` does not break collection. **Reversible:** drop step 9 if verification ever needs the exact host.

---

## 3. ADR-3 — No migration; reuse `UNIQUE(brand_id)` as the idempotency key

**Decision:** ship **zero migrations**. Next free number would be `0029` but it is **not used**. Idempotency is enforced by (a) `GetOrCreatePixelInstallationCommand.findByBrandId` returning the existing row (command-level), and (b) `UNIQUE(brand_id)` (DB-level, 0007:26) as the race backstop. **Rejected alternative:** an additive `0029` partial unique index on `(brand_id, target_host) WHERE installed`. **Why rejected:** under 1:1 it is strictly weaker than `UNIQUE(brand_id)` and would *permit* the duplicate-per-brand the requirement bans. The 1:N future is a deferred non-goal and is unblocked by a *later* migration, not this one.

**Re-edit semantics (the one real behaviour question):** today `GetOrCreate` is brand-keyed and returns the existing row unchanged — so if a brand provisions with host A then edits the website to host B, the existing token is kept and `target_host` is **stale**. **Decision:** on website *edit*, after `brand.domain` is updated, call the provisioner; if an installation already exists and its `target_host != newHost`, **UPDATE `target_host` in place, keep the same `install_token`** (the token is the stable tenant key; the host is a mutable display/verify hint). This needs a 2-line extension to the command (see Track A) — no schema change, no new token, idempotent.

---

## 4. ADR-4 — Provision seam location (server-side, post-persist, inside core)

**Decision:** the provision call fires **server-side inside `BrandService`**, immediately after `brand.domain` is persisted, on **both** `create` and `update`, guarded by `normalizedHost != null`. `BrandService` derives `brandId` from the row it just wrote (`brand.id`) — it **never** reads a client-sent brand_id (R2 invariant upheld; the FE has no way to inject brand_id into this path).

**Wiring (smallest reversible diff):** inject a thin `provisionPixel?: (brandId, targetHost, idempotencyKey, ctxClient) => Promise<void>` into `BrandService`'s constructor. In `main.ts`, the `GetOrCreatePixelInstallationCommand` instance must be constructed **before** `new BrandService(...)` (currently at `main.ts:333`, command at `main.ts:1006` → move the command construction up, or wrap it in a closure). The provisioner runs on the **same `QueryContext` / same client** as the brand write so it executes under the brand's RLS scope (brandId GUC = the just-created brand) — **provision runs under `brain_app`, scoped to this brand**.

**Rejected alternative A — provision in the brand REST route handler** (`brand.routes.ts`): also viable and one fewer constructor change, but it splits the invariant across two files and a future caller of `BrandService.create` (e.g. an MCP tool) would silently skip provisioning. Putting it in the service keeps it a Single-Primitive guarantee. **Rejected alternative B — FE calls `POST /pixel/installation` after brand-create:** rejected because it trusts the client to make a second call (it can be skipped/fail/replayed) and re-introduces a client-driven provision; the server must guarantee it.

**Idempotency key:** the brand mutation already carries an `Idempotency-Key` (I-ST04, contracts brand.api.v1:11). Reuse it (or `correlationId`) as `GetOrCreateInstallationInput.idempotencyKey`. Re-submitting the same brand-create is a no-op at the brand layer and at the pixel layer.

---

## 5. ADR-5 — Soft-gate (website strongly encouraged, Skip-for-now first-class)

**Decision:** the website field becomes **prominent + recommended**, not `(optional)` in muted text, but **Skip-for-now stays a first-class button** that submits with `domain: null`. No hard block. Server contract is unchanged: `domain` remains nullable (contracts brand.api.v1:48). If skipped → no provision → the onboarding "tracking" surface shows the honest **"Add your website to start tracking"** state, and the Tracking Center offers the inline add-website→provision action (which already exists via `PixelWizard.handleGenerate`). This is purely an FE affordance change + copy; the server already supports both paths.

---

## 6. Isolation proof obligation (THE invariant — high_stakes gate)

The dev superuser `brain` **BYPASSES** RLS, so every isolation assertion below is INERT unless it runs as **`brain_app`**. REQUIRED pass-1 live tests (real Postgres, role `brain_app`):

1. **Provision under tenant scope:** create brand A with website → assert exactly one `pixel_installation` row for A, `install_token` is a server-minted uuid, `target_host` == canonical host. Run the SELECT as `brain_app` with `app.current_brand_id = A` → 1 row; with `app.current_brand_id = B` → **0 rows** (RLS isolates).
2. **Never trust client brand_id:** the provision path takes `brandId` only from the freshly-written `brand.id`; assert no code path reads brand_id from request body into the provisioner (grep guard in test).
3. **Token round-trips:** `SELECT resolve_brand_by_install_token(<A's token>)` returns A's brand_id (proves the provisioned row is resolvable by the collector).
4. **Idempotency under brain_app:** call create/provision twice for A → still exactly 1 row, same token.
5. **Edit-host in place:** provision A with host1, update A's website to host2 → still 1 row, **same token**, `target_host == host2`.

> All five MUST run as `brain_app`. A green run as superuser `brain` is treated as a FAIL (inert test).

---

## 7. Build tracks (binding — exact file targets)

### Track A — @backend-developer (normalization + provision seam + isolation proof)
Cost paradigm: deterministic only. Tasks (2–5 min each):

1. **`packages/pixel-sdk/src/normalize-host.ts`** (NEW) — implement `normalizeBrandHost` per §1; export from `packages/pixel-sdk/src/index.ts`. Pure, no I/O.
2. **`packages/pixel-sdk/src/normalize-host.test.ts`** (NEW) — encode the full §1 edge-case table + the idempotence property. REQUIRED pass-1.
3. **`apps/core/src/modules/connector/pixel/application/commands/GetOrCreatePixelInstallationCommand.ts`** — extend `execute`: when `existing` is found and `existing.targetHost !== input.targetHost`, UPDATE `target_host` (keep token), return `isNew:false` (ADR-3 edit-in-place). Add `update(targetHost)` use of the repo's existing `update` (extend repo to set `target_host` — `PgPixelInstallationRepository.update` currently only sets `installed_at,updated_at`; add `target_host` to the UPDATE at `infrastructure/repositories/PgPixelInstallationRepository.ts:103`).
4. **`apps/core/src/modules/workspace-access/internal/application/brand.service.ts`** — (a) normalize `data.domain` via `normalizeBrandHost` in `create` (line 74 area) and `update` (line 245 area) before persist; non-empty→null = throw `BrandError('INVALID_WEBSITE', ...,422)`. (b) After the brand row is written, if normalized host != null, call the injected `provisionPixel(brand.id, host, idempotencyKey, ctx)`. Add `provisionPixel?` to the constructor.
5. **`apps/core/src/main.ts`** — move `GetOrCreatePixelInstallationCommand` construction (currently `:1006`) above `new BrandService(pool, auditWriter)` (`:333`); pass a closure `(brandId, host, key) => getOrCreateInstallation.execute({brandId, targetHost: host, idempotencyKey: key})` into `BrandService`.
6. **`packages/contracts/src/api/brand.api.v1.ts`** — no breaking change; `domain` stays `nullable().optional()`. Add a doc-comment that the server canonicalizes it. (If a normalized-echo field is wanted in the response, it is already `brand.domain` — no schema change.)
7. **`apps/core/src/modules/connector/pixel/tests/provision-isolation.live.test.ts`** (NEW) — the five `brain_app` proofs in §6. REQUIRED pass-1.

### Track B — @frontend-web-developer (first-class website + onboarding tracking-ready + Tracking Center)
Every slice ships stakeholder-visible UI. Tasks (2–5 min each):

1. **`apps/web/lib/api/schemas.ts:75-79`** — make `domain` a recommended field; keep `.optional().or(z.literal(''))` so Skip works. Optionally add a soft client-side `normalizeBrandHost` preview (import from `@brain/pixel-sdk`) — **server value is authoritative**; FE preview is cosmetic only.
2. **`apps/web/components/onboarding/create-brand-form.tsx:216-238`** — promote the website field: remove the muted `(optional)`, add "Recommended — powers your tracking pixel" helper, and add a distinct **"Skip for now"** secondary action that submits `domain: undefined`. Keep `type="url"` + the existing error slot.
3. **`apps/web/app/(onboarding)/brand/new/page.tsx`** OR a new step component — after successful create, route to a **"tracking ready"** state:
   - if the created brand has a website → show the install snippet for *this* brand (reuse `GET /api/v1/pixel/installation` via `usePixelInstallation`) + copy + a "verify later in Tracking Center" link. **New component `apps/web/components/onboarding/tracking-ready.tsx`.**
   - if skipped → show **"Add your website to start tracking"** with a link to `/settings/pixel`.
4. **`apps/web/components/pixel/pixel-wizard.tsx:69-72`** — replace the inline ad-hoc `new URL(rawDomain).host` host extraction with `normalizeBrandHost(rawDomain)` from `@brain/pixel-sdk` (kills the duplicate normalization — Single-Primitive). The Tracking Center website+snippet surface is otherwise already shipped; verify it renders `target_host` + snippet + status and the inline "add website → provision" path (`handleGenerate`) still works for the skipped-website brand.
5. **`apps/web/components/onboarding/create-brand-form.test.tsx`** + **`apps/web/components/pixel/*.test.ts`** — assert: recommended-website renders, Skip submits null, tracking-ready snippet shows the token, skipped state shows add-website. REQUIRED pass-1.

> No deploy-pipeline track: this slice creates **no new service, topic, envelope, or deployable** (constraint §69). It extends existing core routes + web components + one shared util. No GitOps app change.

### Persona must-fix → acceptance contract (folded as REQUIRED pass-1)
- All five §6 isolation proofs run as **`brain_app`** (a superuser-`brain` green is a FAIL).
- `normalizeBrandHost` idempotence property test passes (same-site-three-ways → one host → one token).
- Skip-for-now submits `domain:null`, creates **no** `pixel_installation`, and the honest "add website" state renders.
- Edit-website updates `target_host` in place, **same token**, still exactly one row.
- Server is authoritative for normalization; the FE preview never overrides the persisted value.

---

## 8. Reversibility, cost, alternatives
- **Reversible:** no migration → nothing to roll back at the DB. Revert = remove the `provisionPixel` injection + the normalize call; `BrandService` returns to persist-only. The util is additive.
- **Cost:** ~0 incremental spend. One extra INSERT (or no-op SELECT) per brand-create-with-website; no tokens, no model calls, no new infra. Est: <1 DB round-trip added per onboarding; effectively $0/mo.
- **Alternatives considered & rejected:** (A) FE-driven provision call — rejected (trusts client). (B) `0029` partial index on `(brand_id,target_host)` — rejected (weakens 1:1). (C) provision in the route handler vs the service — service chosen for Single-Primitive guarantee.

## 9. Over-engineering self-check: PASS
No new service/package/topic/migration. Reuses the existing idempotent command, the existing `UNIQUE(brand_id)`, the existing snippet builder, the existing Tracking Center. Net new: 1 pure util (+test), ~6 small edits, 2 UI states.
