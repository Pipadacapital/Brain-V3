# Brain — Product Functional Specification

**Product:** Brain — the AI-native commerce operating system for DTC brands in India, UAE & GCC.
**Document type:** Product Functional Specification — the authoritative, story-ready definition of *every feature and how it behaves*.
**Status:** Final. **Version:** 1.0 (definitive consolidation). **Date:** 2026-06-14.
**Companion documents:** `01_Brain_Business_Requirements_Document.md` (what Brain is and why) and `03_Brain_Technology_Stack_and_Technical_Decisions.md` (the technology).

**How to read this document.** Each feature is specified in a consistent nine-part shape so a BA can slice stories directly and an engineer or AI agent can implement without external explanation:
**Purpose · User Journey · Business Rules · Positive Scenarios · Negative Scenarios · Edge Cases · Permissions · Dependencies · Success Criteria.**
Database schemas, API specifications, sprint plans, architecture diagrams, implementation plans, and deployment plans are deliberately **out of scope**. The four roles referenced throughout are **Owner, Brand Admin, Manager, Analyst** (BRD §13.3). Standards in §0 are inherited by **every** feature and are not repeated per feature.

---

## Table of Contents
0. Global standards inherited by every feature
1. Access & onboarding
2. Organizations, brands, teams & roles
3. The Third-Party Data Integration Platform
4. The First-Party Data Collection Platform
5. The Customer Identity Platform
6. The lakehouse, cost setup & the metric layer
7. The Measurement & Attribution Platform
8. Daily surfaces & the AI Decision Intelligence Platform
9. Pricing, metering & billing
10. Lifecycle, support & safe automation (later phases)
11. Trust, privacy, compliance & reliability

---

## 0. Global standards inherited by every feature

These apply to every feature below; treat them as default acceptance criteria.
- **Standard states:** every surface implements loading (skeleton), empty (guided, drives next action), error (network/500/timeout with retry), permission-denied (clear, not a dead end), and offline/stale (last-known-good, labeled). Data-honesty states (Estimated; provisional/settling/finalized; "collecting your data") layer on top.
- **Accessibility:** WCAG 2.2 AA; **status is never colour-only** (RAG, the seven health states, and confidence bands carry an icon/label as well as colour).
- **Internationalization:** locale-aware number/date/currency formatting; Arabic + RTL for GCC.
- **Mobile-web:** responsive web is a primary surface; Home/brief/approve-reject is mobile-first.
- **Isolation:** every read/write carries a brand_id; cross-brand access is blocked in the data layer (not just the UI), logged, and raised as a P0.
- **Audit:** every sensitive action writes to the append-only audit log; AI/MCP-touched actions also write AI provenance.
- **Honesty:** never present an invented or unverifiable number as fact; label what is not trusted.

---

## 1. Access & onboarding

### 1.1 Registration (Google & email+password)
**Purpose.** Take a new operator from "never heard of Brain" to an Owner account without letting anyone slip into an org they were not invited to.
**User Journey.** Landing → choose *Sign up* → Google one-tap *or* email+password → (email path: verify via single-use link) → become the sole Owner of a new organization → onboarding Step 1.
**Business Rules.** The first registrant of a new org becomes its **sole Owner**; exactly one Owner per org always. A Google-verified email is treated as verified (no second email). Email+password accounts are created **unverified** and cannot reach the product until verified. Passwords are never stored/shown in plaintext or logged. One verified email = one identity, which may belong to multiple isolated orgs.
**Positive Scenarios.** Google sign-up creates account+org+Owner and proceeds to onboarding. Email sign-up creates an unverified account, sends a verification link, and activates on click.
**Negative Scenarios.** Email already registered → refuses a duplicate, offers Sign in / Forgot password, reveals nothing beyond "already in use." Invalid email / weak/mismatched password / terms not accepted → inline validation blocks submission. Google shares no email → fall back to email+password. Verification link expired/reused → rejected with one-click resend.
**Edge Cases.** Register → abandon before verifying → register same email later → re-issues verification against the existing unverified record, not a second one. Two people at one brand both try to register it → only the first becomes Owner; the second is routed to request an invitation. An invited teammate who clicks Sign up is guided to accept their invitation instead.
**Permissions.** Public (unauthenticated).
**Dependencies.** Authentik IdP; email delivery.
**Success Criteria.** A new user reaches onboarding Step 1 within one sitting; no path creates two Owners for one org; no path silently merges a registration into an existing org.

### 1.2 Sign-in, password reset, MFA, logout & sessions
**Purpose.** Authenticate returning users securely and revoke access instantly when authorization changes.
**User Journey.** Sign in (Google or email+password) → MFA if enabled → land in the product (or resume point).
**Business Rules.** MFA is available to **every** account from day one. Wrong credentials → generic "email or password is incorrect" (never disclose which) with rate-limiting/lockout. Password reset uses a **single-use, time-expiring magic link** with a neutral "if an account exists, we've sent a link." **Immediate revocation is non-negotiable:** removing/suspending a user, changing a role/permission, or revoking an integration invalidates affected sessions/tokens/keys immediately; an access-*adding* change applies on next protected action.
**Positive Scenarios.** Valid credentials + MFA → access. Reset link → set new password → signed in, other sessions ended.
**Negative Scenarios.** Unverified → blocked, verify-first. Suspended → refused ("contact your administrator"). Removed → refused as if no access. Google-only account requests a password reset → directed to Google.
**Edge Cases.** A person in multiple orgs is asked which to enter. A role changed mid-session is re-evaluated immediately (removal of access takes effect at once). "Remember me" extends on a trusted device; MFA still applies. Lost second factor → backup codes or an identity-verified, audited recovery (never permanently locked out).
**Permissions.** Authenticated; reset is for email+password accounts.
**Dependencies.** Authentik; session store (Redis); email.
**Success Criteria.** No information leak on failed sign-in or reset; revocation is observable immediately; no permanent lockout path.

### 1.3 The four-step onboarding wizard
**Purpose.** Get an operator into a working product fast without making any single integration a gate.
**User Journey.** Organization → Brand → Integration selection (connect now or *Skip For Now*) → Done.
**Business Rules.** Progress is saved after every step (resume if interrupted). No single connection is mandatory. **Pixel install is not part of onboarding** (done later in Tracking). Brand setup **hard-validates currency and timezone** (they drive every monetary and day-boundary metric) and sets a default revenue definition (Realized/Delivered recommended for COD-heavy markets).
**Positive Scenarios.** Complete all four steps → land in the product (populated if a source connected; guided empty state if skipped).
**Negative Scenarios.** Missing required field blocks Continue. OAuth failure/denied → source left Disconnected with retry; the wizard is not blocked. Invalid credentials → validated at connect time, rejected with a specific reason. A source that connects but returns zero data → Connected but "no data yet," never a fabricated number.
**Edge Cases.** Browser crash mid-step → resume at the last saved step with data intact. Unsupported/not-yet-active region → org still created but flagged that some features activate later. Currency contradicting the region → allowed with a confirm prompt.
**Permissions.** The registering Owner.
**Dependencies.** Connector platform (§3); regional adapters.
**Success Criteria.** A brand can finish onboarding with zero connections; every required field is validated; progress survives interruption.

### 1.4 Account states & lifecycle
**Purpose.** Make membership state explicit and revocation safe.
**User Journey.** A membership moves Invited → Active → (Suspended) → (Removed).
**Business Rules.** Each membership is in exactly one state. Suspension and removal trigger immediate revocation. Removing a teammate never destroys the decision history (it references customers by Brain ID).
**Positive Scenarios.** Invite accepted → Active. Suspend → fast re-enable later.
**Negative Scenarios.** Suspended/Removed user attempts sign-in → refused; existing sessions already revoked.
**Edge Cases.** Re-inviting a removed email creates a **new** membership. An agency staffer who leaves loses only the revoked brand's access; their identity and other-org memberships are untouched.
**Permissions.** Owner / Brand Admin per the invite hierarchy (§2.5).
**Dependencies.** Audit log; session store.
**Success Criteria.** Every transition is audit-logged; revocation is immediate; history survives removal.

---

## 2. Organizations, brands, teams & roles

### 2.1 The Organization → Brand model & absolute isolation
**Purpose.** Make each brand a sealed tenant world.
**User Journey.** An org owns one or more brands; a user works inside one active brand (or the Owner's rollup).
**Business Rules.** A **brand = workspace** is the tenant boundary, billing basis, and unit of everything (region, currency, timezone, revenue definition, integrations, cost setup, users, goals, Decision Log). **Brand isolation is absolute** — no path (dashboard, API, AI, MCP, export, invite) crosses it; the only cross-brand view is the Owner rollup, which still reads each brand within its own isolation and never merges customer records or ledgers across brands. Two brands sharing a customer keep two separate Brain IDs.
**Positive Scenarios.** A user assigned to Brand A sees only Brand A (Brand B is not even listed).
**Negative Scenarios.** Any cross-brand query/report/AI/MCP attempt is blocked **at the data layer**, logged, and raised as a P0 with breach assessment even if nothing escaped.
**Edge Cases.** The same human in several brands holds one login but separate, independent grants per brand.
**Permissions.** Isolation is enforced for all roles including internal Brain staff.
**Dependencies.** Postgres RLS, per-brand S3 prefix, per-brand KMS, StarRocks row policies (Tech §16).
**Success Criteria.** Continuous isolation fuzzing passes in CI on every read/write path; the target for cross-brand leaks is zero.

### 2.2 Active-brand context & switching
**Purpose.** Let agency/multi-brand users move between brands without leakage or lost work.
**User Journey.** Open the always-visible brand switcher → pick a brand (or enter the Owner rollup) → the whole product re-scopes.
**Business Rules.** The active brand persists across sessions and tabs; deep-links are scoped to brand_id; entering/exiting the Owner rollup is explicit.
**Positive Scenarios.** Switching re-scopes navigation, data, and the Decision Log instantly.
**Negative Scenarios.** Switching with unsaved work → prompt before discarding.
**Edge Cases.** A single-brand user sees no switcher friction. A staffer on multiple client brands sees each fully but never a blended report.
**Permissions.** Scoped to the brands a user is granted; rollup is Owner-only.
**Dependencies.** §2.1 isolation; session state.
**Success Criteria.** No surface ever shows two brands' data together except the Owner rollup; the active brand is unambiguous at all times.

### 2.3 Creating & deleting brands
**Purpose.** Provision and wind down sealed brand worlds safely.
**User Journey.** Owner creates a brand (name, website, industry, region, currency, timezone, defaulted revenue definition) → Brain provisions the isolated world. Delete → warn → confirm → export-then-delete.
**Business Rules.** **Owner-only.** Each new brand is fully partitioned from creation. Deletion follows the "no hostage data" flow (export first); a delinquent brand degrades to read-only, never deleted as a side effect of non-payment; closed billing periods are never edited.
**Positive Scenarios.** Create → a fresh isolated lakehouse, integration slots, cost setup, roster, goals, and Decision Log. Delete → confirmed, logged, exported, then deleted.
**Negative Scenarios.** A non-Owner attempting create/delete is blocked and logged.
**Edge Cases.** Deleting the org's only brand is permitted but warned.
**Permissions.** Owner only.
**Dependencies.** Offboarding/export (§11.5); billing (§9).
**Success Criteria.** No brand is ever silently destroyed; provisioning yields full isolation.

### 2.4 Roles & the approval matrix
**Purpose.** Give each person exactly the access their job needs.
**User Journey.** A role template (Owner/Brand Admin/Manager/Analyst) is assigned per brand; permissions enforce every action.
**Business Rules.** Exactly four roles today on a permission engine (the atomic unit is a permission). Executive personas (CEO/CMO/CFO views) are **lenses**, not roles. Cost setup is Brand Admin/Owner only; the one execution-class right a Manager has is integration/pixel/sync write. Auto-execute, billing, brand creation, and Brand Admin creation are **Owner-only, no delegation**. Higher-risk/irreversible actions require approval regardless of AI confidence. A template editor for custom roles is deferred to a later phase.
**Positive Scenarios.** Each role can do exactly what the approval matrix grants.
**Negative Scenarios.** An Analyst attempting any write is blocked everywhere (not just hidden) and logged. A Brand Admin attempting to create another Brand Admin or enable auto-execute is blocked.
**Edge Cases.** A persona that "feels like two roles" maps to Brand Admin (execution) or Manager (integrations only).
**Permissions.** As per the approval matrix (BRD §13.4).
**Dependencies.** §2.1; audit log.
**Success Criteria.** Permissions (not role labels) gate every action; exactly one Owner per org.

### 2.5 Inviting & managing the team
**Purpose.** Grow a team by invitation only, with correct authority limits.
**User Journey.** Inviter enters email + role template + brand(s) → invitee verifies + joins → granted the role's permissions on the assigned brand(s).
**Business Rules.** Invitation is the only way in. Owner invites Brand Admins (and may invite Managers/Analysts); a Brand Admin invites Managers/Analysts for their brands; Managers/Analysts invite no one. Inviters can grant only brands they manage and roles at or below their authority. Revocation is immediate.
**Positive Scenarios.** Invite → verify → join works identically in shape for every role (only the template differs).
**Negative Scenarios.** Inviting an email that belongs to another org → creates a separate independent membership (or is rejected per policy), never linking two orgs or exposing cross-org data. Assigning a brand the inviter doesn't manage → blocked. A Brand Admin inviting another Brand Admin → blocked.
**Edge Cases.** Removing a user mid-session kills access immediately (in-flight action cut off). Suspend preserves the record; remove ends membership; both revoke live access at once.
**Permissions.** Owner / Brand Admin per the hierarchy.
**Dependencies.** Authentik; email; audit log.
**Success Criteria.** Every invite/accept/remove/suspend/role-change/brand-assignment is logged; no path grants access beyond the inviter's authority.

### 2.6 Owner continuity (transfer & break-glass)
**Purpose.** Ensure an org never becomes permanently inaccessible or reaches zero Owners.
**User Journey.** Planned: the Owner transfers ownership (step-up auth). Unplanned: support-mediated, identity-verified break-glass recovery.
**Business Rules.** Always exactly one Owner, never zero. Transfer leaves exactly one Owner (the prior Owner drops to an assigned role or is removed). Break-glass is never automatic. The delinquent-and-Owner-gone case also recovers via break-glass.
**Positive Scenarios.** Transfer moves ownership cleanly and is fully audited.
**Negative Scenarios.** A normal removal can never produce zero Owners.
**Edge Cases.** A disputed recovery is resolved by support against verified identity and the immutable audit trail.
**Permissions.** Owner (transfer); Brain support + verified party (break-glass).
**Dependencies.** Audit log; identity verification.
**Success Criteria.** No org can be orphaned; both paths are fully audited.

### 2.7 The audit-log viewer
**Purpose.** Let an enterprise buyer/auditor verify access governance after the fact.
**User Journey.** Open the audit-log viewer → filter by actor/action/date/brand → inspect or export entries.
**Business Rules.** The log is append-only and tamper-evident; entries cannot be edited or selectively deleted from within the product (an attempt is itself a security event). It records logins, role/permission changes, invites/removals, integration connect/disconnect, sync/token failures, cost/goal/attribution-model/metric-definition changes, AI & MCP queries, lifecycle approvals, refunds/replacements, auto-execute toggles & kill-switch events, and data export/deletion.
**Positive Scenarios.** A reviewer reconstructs who did what, to whom, and when.
**Negative Scenarios.** An edit/delete attempt is blocked and itself logged.
**Edge Cases.** Retained for workspace life; included in the offboarding export.
**Permissions.** Owner / Brand Admin (brand-scoped); Analyst read where granted.
**Dependencies.** Append-only store; export (§8.10).
**Success Criteria.** Every sensitive action is present and immutable; the log is filterable and exportable.

---

## 3. The Third-Party Data Integration Platform

### 3.1 The Integration Marketplace
**Purpose.** Discover and connect the brand's stack with honest status on every tile.
**User Journey.** Browse by category → see each tile's truthful status → connect.
**Business Rules.** Every tile carries exactly one status: Connected, Syncing, Disconnected, Error, Coming Soon (and Disabled where a plan doesn't entitle a category). No tile implies "live" when it isn't. Cost setup stays Brand Admin/Owner only.
**Positive Scenarios.** A brand finds a tool by category and connects it.
**Negative Scenarios.** An Analyst sees everything but no connect buttons. A Coming-Soon tile lets the brand register interest, never faked live.
**Edge Cases.** A Disabled category is visibly distinct from "not connected."
**Permissions.** Connect: Owner/Brand Admin/Manager. Browse: all roles.
**Dependencies.** Entitlement layer; connector catalogue.
**Success Criteria.** Every tile shows exactly one truthful status; views are brand-scoped.

### 3.2 Connecting a source & historical backfill
**Purpose.** Bring an authorized source into the lakehouse with its history.
**User Journey.** Choose OAuth or credential entry → connect → backfill runs → live + historical data flow.
**Business Rules.** Credentials are encrypted and never shown back in full. Backfill targets **24 months where the API permits**, on the **same code path** as live so they reconcile; **achieved depth is labeled per connector**.
**Positive Scenarios.** A source connects and the brand opens with its history.
**Negative Scenarios.** OAuth cancelled/rejected → stays Disconnected (no half-state). Wrong token → fails fast with the specific reason. Partial backfill → ingests what it can, labels the real achieved depth.
**Edge Cases.** A 60-day-cap provider is shown honestly as a 60-day connector.
**Permissions.** Owner/Brand Admin/Manager.
**Dependencies.** Provider APIs; lakehouse; secrets/KMS.
**Success Criteria.** A failed auth never leaves a misleading "connected-but-empty" state; achieved depth is always labeled.

### 3.3 Managing a connector (lifecycle controls)
**Purpose.** Let an operator run and recover a sync without a support ticket.
**User Journey.** Start / Pause / Resume / Retry Sync; read monitoring (Last Sync, Last Successful Sync, Next Sync, Status, Error Reason/Logs, Sync Duration).
**Business Rules.** Resume continues from the saved position — no gap, no duplicate (idempotent). Resume after a long pause re-pulls a trailing window to catch changes without duplicating.
**Positive Scenarios.** An errored sync → read reason → fix → Retry → recover.
**Negative Scenarios.** Retry on a rate-limited source doesn't help, and Brain says so.
**Edge Cases.** Pause during a provider outage, resume cleanly after.
**Permissions.** Owner/Brand Admin/Manager; Analyst sees monitoring read-only.
**Dependencies.** Connector cursors; provider APIs.
**Success Criteria.** Pause/resume never loses position and never duplicates; the same control set exists for every provider.

### 3.4 Connection health — the seven states
**Purpose.** Tell the operator exactly what's wrong and what to do.
**User Journey.** A source shows one of seven states with a prescribed action.
**Business Rules.** Exactly one of **Healthy / Delayed / Failed / Disconnected / Rate Limited / Token Expired / Disabled** at a time, each with a defined entry condition, plain explanation, prescribed action, and a declaration of whether recommendations on this data are **blocked / degraded / safe**. Token Expired always links to re-auth; Rate Limited says retrying doesn't help; status is never colour-only.
**Positive Scenarios.** A healthy source is left alone; a Token-Expired source links straight to re-auth.
**Negative Scenarios.** Token expiry mid-sync → stops cleanly at the last committed position, marks Token Expired (not Failed), pauses dependent high-risk recommendations.
**Edge Cases.** A flapping source is grouped into one calm notification; a brittle CSV/sheet source is labeled brittle and caps what Brain will claim.
**Permissions.** All roles see state; action per §3.3.
**Dependencies.** Health monitoring; notification tiers (§8.8).
**Success Criteria.** Every state has a defined cause and action; the state correctly gates recommendation safety.

### 3.5 Data freshness (honest by source type)
**Purpose.** Show the real freshness of each source, never stale-as-current.
**User Journey.** Each source displays its achieved freshness; provisional numbers are labeled "until final."
**Business Rules.** "Real-time" is whatever each source can honestly deliver (orders <30s webhook / hourly poll fallback; ad spend ~15min + daily finalized correction; payments <60s / settlement daily; logistics hourly; etc.). A breach is shown, not buried; when the fast serving copy lags the authoritative store, Brain falls back to the source of truth rather than serving stale-as-current.
**Positive Scenarios.** A webhook source shows sub-minute freshness.
**Negative Scenarios.** Webhooks fail → silent fallback to hourly polling, labeled on the slower cadence.
**Edge Cases.** A provisional/restating number (ad spend) is labeled "until final."
**Permissions.** All roles.
**Dependencies.** Connector cadence; serving layer.
**Success Criteria.** Freshness is always shown honestly; stale never masquerades as current.

### 3.6 Per-source vs combined (dual) views
**Purpose.** Make cross-tool comparison honest and traceable.
**User Journey.** View each source alone and all sources in a category combined.
**Business Rules.** Combined views are built only from like-for-like normalized data and disclose when a contributor is missing/degraded. Cross-platform double-counting resolves against the realized-revenue ledger.
**Positive Scenarios.** Meta/Google/TikTok combine into one "advertising" shape.
**Negative Scenarios.** A source in Error → the combined view flags it ("Google excluded — connector failing") rather than silently undercounting.
**Edge Cases.** A one-source category shows per-source and combined as identical and says so.
**Permissions.** All roles (view).
**Dependencies.** Normalization; metric registry.
**Success Criteria.** Every connected source is visible both ways; missing/degraded contributors are disclosed.

### 3.7 Marketplaces (Amazon, Flipkart, Noon) & settlement reconciliation
**Purpose.** Handle channels with no pixel and fee-heavy settlement correctly.
**User Journey.** Connect via seller API → ingest from settlement reports → revenue counted net of fees, as channel contribution.
**Business Rules.** No pixel (no journey to observe). **Fees captured before revenue is counted** (referral/closing/fulfilment fees populated from the settlement report before the order is realized). Measured as **channel contribution, not journey attribution**. Prepaid-gateway settlement reconciles the same way (net of actual MDR/reserve/adjustments).
**Positive Scenarios.** A marketplace order counts at the settled amount net of fees.
**Negative Scenarios.** Settlement report delayed → the order is held **provisional**, not counted at gross. Placed vs settled differ 20–35% → Brain trusts the settlement file.
**Edge Cases.** Masked marketplace PII → a marketplace-scoped pseudo-identifier, never a weak merge. A refunded marketplace order posts a reversal like any other.
**Permissions.** Owner/Brand Admin/Manager (connect).
**Dependencies.** Settlement files; the realized-revenue ledger; channel contribution (§7.4).
**Success Criteria.** Marketplace CM2 is never overstated by the fee; marketplace revenue is never journey-attributed.

### 3.8 The tracking-plan / event-governance surface
**Purpose.** Let a brand define and govern its expected event taxonomy (the CDP table-stake).
**User Journey.** Define expected events → see schema-violation and missing-event reports → govern the plan over time.
**Business Rules.** Built on the schema registry; backward-compatible evolution; violations surface as reports, not silent corruption. Distinct from the Event Explorer (which is debugging, not governance).
**Positive Scenarios.** A brand sees that all expected events are arriving conformantly.
**Negative Scenarios.** An event schema violation or a missing expected event → a report/alert, never silent.
**Edge Cases.** A new event version is introduced backward-compatibly; old events remain readable.
**Permissions.** Owner/Brand Admin/Manager.
**Dependencies.** Apicurio schema registry (Tech §8); collection platform (§4).
**Success Criteria.** A brand can credibly govern its first-party taxonomy; violations are always visible.

---

## 4. The First-Party Data Collection Platform

### 4.1 Installing the Brain Pixel
**Purpose.** Begin first-party collection on the brand's own domain.
**User Journey.** Open Tracking → copy the snippet (or enable the storefront app) → paste → events appear within seconds, SDK shows healthy.
**Business Rules.** The pixel sets a brand-scoped anonymous visitor ID and never slows the store (async, size-budgeted, batched, retried, offline-buffered, degrades silently). Everything is brand-scoped.
**Positive Scenarios.** Install → events appear in the Event Explorer; tracking health is green.
**Negative Scenarios.** Pasted-but-no-events → "No events / SDK not detected" with re-check, never a false green. Mis-installed → SDK loads but health flags missing event types.
**Edge Cases.** First-party-domain (CNAME) not yet configured → works at reduced cookie persistence and says so. Multiple storefronts → per-property health.
**Permissions.** Manager/Brand Admin/Owner install; Analyst cannot (view-only).
**Dependencies.** Collector endpoint (Tech §7); storefront app.
**Success Criteria.** The pixel never degrades store performance; install status is never a false green.

### 4.2 Event capture (client + server, dedup, click IDs)
**Purpose.** Capture the full commerce event set resiliently and without double-counting.
**User Journey.** A visitor browses/carts/buys → events captured client- and server-side → stitched onto the session and customer.
**Business Rules.** Full commerce event set + marketing context (UTMs and `fbclid`/`gclid`/`ttclid` + a generic `click_ids` map). The purchase is captured client-side *and* from the order webhook; the same purchase carries one event ID and **collapses to one — never double-counted**. On field disagreement, the higher-confidence server/connector value wins. A click ID with no later conversion is still persisted for first/last touch.
**Positive Scenarios.** A purchase is recorded exactly once with full marketing context.
**Negative Scenarios.** Browser closes mid-checkout or the client pixel is blocked → the server-side order webhook still records the purchase.
**Edge Cases.** In-app webview (Instagram/TikTok) sessions → identity relies on server-side click-ID→order reconciliation, not cookie persistence; a webview match-rate is surfaced.
**Permissions.** System (capture); operators view.
**Dependencies.** Collector; identity moments (§5).
**Success Criteria.** A purchase is never double-counted; client and server dedup by a shared event ID.

### 4.3 Durable collection (accept-before-validate)
**Purpose.** Guarantee a collected event is never lost.
**User Journey.** An event hits the collector → durably accepted and acknowledged → validated/enriched downstream.
**Business Rules.** The collector durably accepts and **acks before any gate**; schema validation, consent evaluation, bot detection, and enrichment run as **downstream stream stages**. A schema-invalid event lands in Bronze quarantine + a dead-letter path — never dropped with a 4xx.
**Positive Scenarios.** Even with the schema registry slow or downstream degraded, the event is accepted and later processed.
**Negative Scenarios.** A malformed event → quarantined and dead-lettered, not lost.
**Edge Cases.** Collector endpoint briefly down → the client buffers and retries; nothing lost.
**Permissions.** System.
**Dependencies.** Redpanda; Bronze quarantine.
**Success Criteria.** No validation/downstream outage drops a collected event; the 99.95% endpoint SLO holds.

### 4.4 Consent at capture & withdrawal propagation
**Purpose.** Enforce consent at the point of collection and honor withdrawal retroactively.
**User Journey.** A visitor's consent (four categories) is recorded with the event; a withdrawal suppresses them everywhere within the propagation window.
**Business Rules.** Four categories (Necessary/Analytics/Marketing/Personalization) recorded with who/when/where/region/prompt-language/consent-text-version; the snapshot rides with the event into resolution (stitching is consent-gated). A separate **AI-processing flag** governs individual-profile use. **Capture fails closed.** Withdrawal is retroactive within a defined window (target <15 min): a tombstone/overlay is written (Bronze never destructively edited), the customer is suppressed from every audience/journey/pending send, and a deletion signal is sent for already-passed-back conversions.
**Positive Scenarios.** Analytics denied → analytics not collected; Marketing denied → marketing/attribution not collected.
**Negative Scenarios.** Consent withdrawn → collection stops immediately; the customer is suppressed from all targeting and pending sends.
**Edge Cases.** A withdrawal after a conversion was already passed back → a deletion signal goes to the ad platform.
**Permissions.** System; consent text managed by Brand Admin/Owner.
**Dependencies.** Consent store; the send/passback services.
**Success Criteria.** No event is collected against a denied category; every consent change is audit-logged; withdrawal propagates within the window.

### 4.5 Sessionization & bot filtering
**Purpose.** Produce honest sessions and exclude non-human traffic.
**User Journey.** Events are grouped into sessions; bots are flagged and excluded.
**Business Rules.** Sessions: 30-min inactivity timeout, new session on UTM/campaign change, day boundary at midnight in the brand timezone, a grace window for late events, bot sessions excluded. Session-derived metrics are registered like any other metric. Bots: known-bot UA + datacenter-IP + velocity heuristics; flagged with a reason; excluded from **both** analytics and identity-match-rate denominators; retained, never deleted.
**Positive Scenarios.** Two analysts get the same "sessions" number (one registry definition).
**Negative Scenarios.** A datacenter-IP crawler → flagged bot, excluded from analytics and match-rate.
**Edge Cases.** A late/out-of-order event within the grace window joins its session; outside it, it attaches as a new low-completeness touch (a sealed session is not re-opened).
**Permissions.** System.
**Dependencies.** Stream consumers (Tech §9); metric registry.
**Success Criteria.** Session definition is single-sourced; bot traffic never inflates analytics or match rate.

### 4.6 Event Explorer, tracking health & "tracking-dark" monitoring
**Purpose.** Give operators a real-time debugging surface and proactive quality alarms.
**User Journey.** Search/inspect events in the Event Explorer; watch the tracking-health dashboard; receive an alert if tracking goes dark.
**Business Rules.** Per-(brand, event-type) volume baselines with anomaly thresholds, a schema-violation-rate SLO, the **client-vs-server purchase match rate** as a named/fired signal, and a **"tracking went dark"** detector wired into the notification tiers. Health feeds the data-quality grade, which gates behaviour.
**Positive Scenarios.** An operator inspects an event's payload/identity/session to debug an install.
**Negative Scenarios.** A volume drop / schema violation / missing event type → a data-quality alert fires rather than silently corrupting analytics.
**Edge Cases.** No events → surfaced clearly, never a false green.
**Permissions.** Owner/Brand Admin/Manager (full); Analyst read.
**Dependencies.** Quality monitoring; notifications (§8.8); DQ grades (§6.3).
**Success Criteria.** A silent tracking break is detected and alerted before it corrupts numbers; the match-rate answers "how much am I missing to ITP/ad-block?"

### 4.7 Conversion passback (CAPI), output-only
**Purpose.** Improve the brand's own ad delivery using first-party conversions — without ever feeding Brain's attribution.
**User Journey.** Enable passback per ad platform → consent-gated server-side conversions flow to Meta/Google/TikTok → the feature shows its own status/health.
**Business Rules.** Marketing-consent-gated; **output to ad platforms only, never an input to Brain's attribution**, and must not inflate any Brain measurement signal. A consent withdrawal triggers a deletion signal for already-passed conversions.
**Positive Scenarios.** Consented conversions improve the brand's ad delivery; Brain's own numbers are unaffected.
**Negative Scenarios.** A non-consented conversion is never passed back.
**Edge Cases.** Withdrawal after passback → deletion signal sent.
**Permissions.** Owner/Brand Admin (enable).
**Dependencies.** Ad-platform CAPIs; consent store.
**Success Criteria.** Passback never appears as an attribution input; a reconciliation view explains why Brain's number is lower than the platform's claim.

---

## 5. The Customer Identity Platform

### 5.1 Identity resolution (anonymous → Brain ID → stitch)
**Purpose.** Resolve scattered events into one customer per real person per brand.
**User Journey.** Anonymous on arrival → Brain ID minted/matched on a strong identifier → earlier anonymous sessions stitched back.
**Business Rules.** **Deterministic matching only (Phase 1):** verified/hashed email, storefront customer ID, authenticated user ID, phone, and the first-party cookie once linked by a real login/signup/auth-checkout. Device/behavioural = medium (Phase 2, never alone); IP/UA/name/pincode = weak, **never auto-merge**. **Brain ID is brand-scoped and never global** (per-brand salt prevents cross-brand correlation even of hashes). The graph holds **hashed** identifiers; real email/phone live in a vault readable only by the send service. Links are appended, never overwritten, each recording rule + confidence. Resolution is consent-gated.
**Positive Scenarios.** A login links an anonymous history to a known customer.
**Negative Scenarios.** A cookieless visitor who never identifies → stays anonymous/unlinked, reported honestly (never invented).
**Edge Cases.** Same person across two devices → unified the moment a shared strong identifier appears. Same person at two brands → two unrelated Brain IDs. A shared-device new login on an already-linked cookie → the cookie **re-binds** to the new person, never merges.
**Permissions.** System; operators view via Customer 360.
**Dependencies.** Identity-graph service (Tech §11); consent.
**Success Criteria.** Strong-id matches resolve correctly; weak signals never auto-merge; cross-brand identity is impossible.

### 5.2 The India phone guard & the review queue
**Purpose.** Prevent false merges on shared COD phone numbers.
**User Journey.** A phone match with conflicting strong evidence → routed to a review queue with the evidence shown → an operator merges or keeps apart.
**Business Rules.** A phone match auto-merges only when no conflicting strong evidence exists; if two profiles share a phone but carry different verified emails/storefront IDs, Brain does **not** merge. The queue has a defined working SLA, a volume alarm, and a default disposition on expiry (keep apart).
**Positive Scenarios.** Two real customers sharing a phone are held apart.
**Negative Scenarios.** A pair that can't be confidently resolved is never auto-merged.
**Edge Cases.** Queue backlog at COD scale → the volume alarm fires; expiry defaults to no-merge.
**Permissions.** Owner/Brand Admin work the queue.
**Dependencies.** §5.1; notifications.
**Success Criteria.** No false merge from a shared phone; the queue is worked within SLA.

### 5.3 Merge & unmerge
**Purpose.** Combine and safely separate identities without rewriting history.
**User Journey.** A merge runs under a versioned rule; a wrong merge is reversed.
**Business Rules.** Governing principle: **a false merge is worse than a missed merge.** Merges record the rule version, identifier combo, confidence, and action; history is never rewritten — a read-time **alias** re-points the merged profile's events to the canonical Brain ID. **Unmerge is first-class and reversible** (constituent identities restored with full histories; itself reversible). A cycle guard aborts a loop-creating merge to review. An undone merge closes the alias (history preserved), never deletes it.
**Positive Scenarios.** A correct merge unifies two profiles; orders/sessions follow without editing events or money.
**Negative Scenarios.** Conflicting strong evidence → never auto-merges; goes to review.
**Edge Cases.** A wrong merge → unmerge restores both with full histories.
**Permissions.** Owner/Brand Admin.
**Dependencies.** brain_id_alias model (Tech §11); audit + Decision Log.
**Success Criteria.** Every merge and unmerge is logged with actor/rule/evidence; no merge rewrites emitted facts or revenue.

### 5.4 Identity confidence, completeness & Customer 360
**Purpose.** Expose one unified, trust-scored profile per Brain ID.
**User Journey.** Open Customer 360 → one timeline (behaviour, orders, payments, communication) + identity confidence/completeness.
**Business Rules.** Each profile carries a **profile identity-confidence and completeness score** (from link tier/count/recency), consumed by attribution and the AI so a weak-link guess and a strong profile are never treated identically. Customer 360 is a **derived read model** (the lakehouse + graph remain authoritative), rebuildable from source. View-only roles see it PII-minimized.
**Positive Scenarios.** An operator sees one complete, trust-scored customer timeline.
**Negative Scenarios.** An unresolved/cookieless visitor is shown honestly as anonymous.
**Edge Cases.** A just-merged/unmerged profile re-projects to the current canonical view without destroying history.
**Permissions.** Brand-scoped, `customer.read`; view-only roles see no PII beyond minimization.
**Dependencies.** §5.1–5.3; serving layer.
**Success Criteria.** Every profile carries confidence + completeness; no view-only role sees vault plaintext.

---

## 6. The lakehouse, cost setup & the metric layer

### 6.1 The per-brand lakehouse & raw retention
**Purpose.** Hold one complete, isolated, traceable store of the brand's commerce reality.
**User Journey.** Connected sources flow in → raw kept exactly as received → reshaped into one model that every surface reads.
**Business Rules.** Holds **both** raw and normalized data across ten canonical domains; **isolated per brand**; raw retained **24 months** for replay/audit; **every number traces to its raw origin** (metric → normalized record → raw event) or it doesn't render as fact. The most important facts arrive several times and change → every restatable fact is labeled provisional/settling/finalized.
**Positive Scenarios.** The revenue on the P&L, in an ad report, and quoted by the AI is the same revenue.
**Negative Scenarios.** A source down/behind → visible lag, retries without loss, last trustworthy figure marked stale.
**Edge Cases.** On recovery, backlog replays on the **same code path** as live, so a recovered gap looks identical to data never missed.
**Permissions.** System; read via the Analytics API.
**Dependencies.** Iceberg/Glue (Tech §13); stream pipeline.
**Success Criteria.** No silent loss; raw retained 24 months; a still-moving number is never shown as final.

### 6.2 Normalization & the dual view
**Purpose.** Make cross-tool comparison honest.
**User Journey.** Different tools' data maps into one model; everything is viewable per-source and combined.
**Business Rules.** Normalization never overwrites raw; an unmapped/changed field keeps raw and flags the gap rather than dropping it.
**Positive Scenarios.** Doubt the combined number → flip to per-source to see exactly what each tool reported.
**Negative Scenarios.** An unmapped field → raw retained, the gap flagged.
**Edge Cases.** A one-source category shows both views as identical and says so.
**Permissions.** All roles (view).
**Dependencies.** Connector contracts; metric registry.
**Success Criteria.** Dual view is always available; normalization is non-destructive.

### 6.3 Data quality, grades & the gating table
**Purpose.** Make trust explicit and let it change product behaviour.
**User Journey.** Each source and the brand are graded A+→D; the grade changes what Brain will do.
**Business Rules.** Grades span completeness, freshness, accuracy, consistency, identity-match. A single authoritative **gating table** maps (grade/confidence band) → (render label, recommendation eligibility, auto-execute eligibility, MMM-training inclusion, billing-cap applicability). "High-risk action" = reversibility + monetary threshold. Below the 70 line / below a C grade: numbers render "estimated," high-risk recommendations are blocked, the slice is excluded from training, the CM2 cap does not apply.
**Positive Scenarios.** A high-grade brand gets full recommendations and the cap.
**Negative Scenarios.** A below-grade source labels its reports "estimated" and holds back high-risk advice.
**Edge Cases.** Two sources disagree → a reconciliation check yields one number with the discrepancy made visible (the system of record wins; a note is raised, not a silent override).
**Permissions.** System; visible to all roles.
**Dependencies.** Quality monitoring; metric registry; billing (§9).
**Success Criteria.** Below-grade data is labeled, never hidden; behaviour follows the gating table consistently.

### 6.4 Cost setup
**Purpose.** Capture real costs so true profit can be computed and the cap can apply.
**User Journey.** Open cost setup → enter/import COGS, payment fees, packaging, shipping, COD fees, returns/RTO → reach Trusted.
**Business Rules.** Scored by **cost-confidence** (Trusted ≥95% / Estimated 70–95% / Insufficient <70%), weighted by revenue share; every margin is stamped with its confidence. A first-class input surface supports per-SKU COGS vs blended, guided import vs manual, and category-benchmark defaults to bootstrap a new brand toward Trusted. The cap only applies at Trusted (billing teeth — §9.3).
**Positive Scenarios.** Complete cost data → margins render with Trusted confidence; the cap can apply.
**Negative Scenarios.** Partial costs → Estimated label; below the floor → Insufficient → shows the **missing inputs, not a fake margin**.
**Edge Cases.** Costs slipping Trusted→Estimated lose the cap prospectively.
**Permissions.** Owner/Brand Admin only.
**Dependencies.** Product/Order domains; billing.
**Success Criteria.** Every CM number carries cost-confidence; a margin without one never renders.

### 6.5 The metric registry & "same question, same number"
**Purpose.** Guarantee one definition computed identically everywhere.
**User Journey.** Every surface (dashboard, API, AI/NLQ, MCP, export) computes from one registry definition.
**Business Rules.** All non-additive math (per-SKU tax, realization-date FX, rounding, allocation, ratios) lives in one deterministic engine; the AI narrates, never invents. A continuous **parity oracle** fails loudly on drift. **Qualification:** the guarantee is "same **finalized** number everywhere"; a fast pre-dedup serving copy may lag, so provisional/hot reads are **labeled** and may differ until convergence, and the hot number **never** feeds a decision/billing/attribution surface. Definitions are versioned so old reports remain reproducible.
**Positive Scenarios.** Asking the same question two ways returns the identical finalized number.
**Negative Scenarios.** Drift between a surface and the independent recomputation → the build/run fails.
**Edge Cases.** During the hot-vs-finalized lag window, the hot number is labeled and excluded from decisions.
**Permissions.** System; governed by CI.
**Dependencies.** Registry (Postgres); StarRocks; parity oracle (Tech §14).
**Success Criteria.** No surface can compute a different finalized number; provisional reads are always labeled.

### 6.6 The numbers Brain computes
**Purpose.** Define every headline metric precisely.
**Business Rules (definitions).** **Revenue ladder:** Placed → Paid → Shipped → Delivered (provisional recognition) → Realized (finalized; the honest number). **Recognition (the one rule):** provisional at delivery, finalized at the realization horizon/settlement; settlement effects post as append-only ledger rows; the sale row is never mutated; billing reads finalized only. **CM waterfall:** Revenue (net of per-SKU tax, never blended) − COGS − other variable costs = CM1; − marketing = CM2; − fixed = CM3. **True CM2:** realized-only, subtracting only the incremental cost of failure (return-leg shipping + damage) + provisions; `CM1 ≥ CM2 ≥ True CM2`. **Efficiency:** MER, aMER, CAC, LTV:CAC — all on realized revenue. **New customer = first *finalized* realized order, merge- and clawback-reactive** (a fully-RTO'd first order = not acquired; merges restate the cohort). **RTO/COD:** RTO rate/cost (diagnostic only), COD share/realization, `r* = M/(M+C)`, with the realization-rate model pincode-/courier-/payment-/seasonality-aware. **FX:** each ledger row converts at its own recognition-date rate from a declared, dated, locked source; a missing rate fails closed. **Goals/RAG:** green/amber/red with explanation; no goal → no RAG.
**Positive/Negative/Edge.** A delivered-but-unsettled COD order is labeled provisional/settling, not counted as realized. Retargeting COD buyers who later RTO cannot inflate efficiency metrics (all on realized). No fabricated target where no goal is set.
**Permissions.** System; visible per role.
**Dependencies.** §6.1–6.5; the attribution platform (§7).
**Success Criteria.** Each metric means one specific thing everywhere; True CM2 never double-counts RTO cost.

---

## 7. The Measurement & Attribution Platform

### 7.1 Journey attribution & per-channel windows
**Purpose.** Split credit across a customer's real first-party touches, honestly.
**User Journey.** Brain builds the journey → splits credit by the chosen model → the brand can switch models.
**Business Rules.** Models: first-touch, last-touch (dangerous in India), last-non-direct, linear, time-decay, **position-based (the default)**, W-shaped, and the data-driven **Markov removal-effect** + **Shapley** models (data-driven reserved to Phase 2+ per the attribution-engine phasing). All models are computed **side-by-side as a comparison/triangulation view** — platform-reported vs Brain-attributed vs **self-reported survey** (doc 08 §35); the **single `attribution_credit_ledger` (position-based) stays the economic source of truth** for CM2/billing. Touch-eligibility windows are **per-channel, brand-configurable** (default 7-day click; 14–30 day for prospecting/influencer), frozen at conversion per order. Attributed numbers are always in **CM2, not ROAS**; platform-claimed figures are display-only. Switching a model recomputes but **history stays reproducible** (every number pinned to the model version + data snapshot).
**Positive Scenarios.** Position-based spreads credit across the touches that built the sale.
**Negative Scenarios.** A truncated cookieless journey that looks single-touch is flagged low-completeness (lowering confidence), not credited as if retargeting did all the work.
**Edge Cases.** A brand switches model → history can be re-viewed under the new model without corrupting the original.
**Permissions.** Owner/Brand Admin set the model.
**Dependencies.** Identity (§5); the realized-revenue ledger.
**Success Criteria.** Default is position-based; switching never alters history; credit reconciles to realized revenue.

### 7.2 Realized-time attribution & clawback
**Purpose.** Attribute only realized revenue, and move credit as reality moves.
**User Journey.** Pass 1 (provisional at placement, discounted by RTO likelihood) → Pass 2 (finalized at the horizon) → clawback when an order reverses.
**Business Rules.** Provisional credit never feeds billing or high-stakes recommendations. On RTO/refund/chargeback, Brain **claws credit back from the exact campaigns/touches that got it, in the same saved proportions**. Three labels (provisional/settling/finalized) are always visible; "finalized" means "no longer *expected* to move," not "frozen against a real reversal."
**Positive Scenarios.** A campaign's CM2 falls weeks after the spend as its COD orders RTO — the intended behaviour.
**Negative Scenarios.** A fully-RTO'd campaign → each sale's credit exactly negated; attributed revenue/CM2 fall to zero (why provisional is blocked from auto-scaling).
**Edge Cases.** Partial refund → proportional clawback across the same touches/weights. Late chargeback after finalization → label stays finalized, the reversal still lands. NDR then re-delivery → nothing reverses, the horizon shifts. Pre-ship cancellation → no sale recognized, nothing to claw back. A reversal too old to fairly blame → routed to the unattributed bucket.
**Permissions.** System; visible per role.
**Dependencies.** The append-only ledger (§6.6); saved per-touch weights.
**Success Criteria.** Clawback mirrors the original credit exactly; billing never reads provisional credit.

### 7.3 Attribution confidence, baseline & view-through
**Purpose.** Tell the operator how much to trust the credit, and stay honest about what can't be measured.
**User Journey.** Every attributed number carries a confidence band; baseline and view-through are handled explicitly.
**Business Rules.** Confidence: **Low/Medium/High** today; **Calibrated** (Phase 3) only after incrementality/holdout validation. Two guardrails: a **trust line at 70** (below → estimated, gap shown, high-risk blocked; shared across cost/data/attribution) and **`effective_confidence = min(cost-confidence, attribution-confidence)`** with the display naming the weaker leg. **Baseline:** branded-search/direct/organic flagged `harvested_demand` with a configurable haircut + confidence penalty; an `organic_baseline` contribution row recorded. **View-through:** **Phase 1 credits none** — VT lives in the unattributed bucket; every paid-social card carries a "view-through blind spot" disclosure. **Cross-device:** a `cross_device_unlinked_rate` signal lowers journey confidence where loss is high; the bias direction is documented.
**Positive Scenarios.** A high-identity, mostly-finalized, clean-data campaign reads High.
**Negative Scenarios.** A new campaign with few realized orders is honestly Low and blocked from recommendations until it has data. A contributing source below a C grade hard-caps confidence at Medium and excludes the slice from MMM training.
**Edge Cases.** Rising clawbacks drop both realized credit and confidence, dropping a campaign out of auto-execute eligibility.
**Permissions.** System; the AI may narrate confidence but never invent/inflate it.
**Dependencies.** Identity confidence (§5.4); realization maturity (§7.2); DQ grade (§6.3).
**Success Criteria.** No attributed number renders without both confidence legs and the binding minimum; Calibrated is impossible until validated; the paid-social blind spot is always disclosed.

### 7.4 Channel contribution & spend homing
**Purpose.** Answer the strategic, cross-channel question without double-counting.
**User Journey.** Each channel shows a contribution range + method + confidence; journey credit rolls up into it.
**Business Rules.** Everything **without a click journey lives here** (marketplaces, offline, WhatsApp/lifecycle, influencer-coupon, trade shows). **Never add journey-credit and channel-contribution together.** **One closed sum:** all channel contributions (including the always-rendered unattributed residual) equal total realized revenue for the period. Phase 1 uses rule-based + direct inputs (capped at High); Phase 3 swaps in MMM/holdout with **no schema/API/dashboard/prompt change**. **Spend homing:** journey-bearing spend → cm2_attributed (residual to cm2_unattributed); **non-journey spend → cm2_unattributed (journey side) AND a `spend_minor` on the contribution row (strategic side), never forced onto a touch**; message cost split utility (CM1) vs marketing (CM2).
**Positive Scenarios.** "Meta contributed ₹1,000,000 ± ₹150,000 · method = MMM · confidence = Calibrated."
**Negative Scenarios.** A marketplace sale is recorded as contribution, never journey credit; if returned, its contribution falls via the ledger reversal, never a per-touch clawback.
**Edge Cases.** A journey-less channel's confidence comes from the width of its MMM range; a parity check asserts all marketing spend = journey-allocated + unattributed-spend.
**Permissions.** System; visible per role.
**Dependencies.** The ledger; channel-contribution schema (reserved Phase 1).
**Success Criteria.** The closed-sum holds; journey and contribution are never summed; spend is never double-counted or mis-homed.

### 7.5 The unattributed bucket
**Purpose.** State honestly what cannot be attributed.
**Business Rules.** Always present and rendered alongside attributed numbers; holds cookieless visitors, marketplace/offline revenue with no journey, view-through, and reversals too old to blame. It doubles as a **signal** — a big bucket mechanically lowers every campaign's confidence. As MMM lands it shrinks but never disappears.
**Positive/Negative/Edge.** A brand that can only explain 40% of its CM2 cannot claim a perfectly-attributed campaign. The bucket is never hidden or quietly spread across channels.
**Permissions.** System; visible per role.
**Dependencies.** §7.1–7.4.
**Success Criteria.** The bucket is always shown in the same frame as attributed-by-channel views.

---

## 8. Daily surfaces & the AI Decision Intelligence Platform

> Each surface is a rendering of a platform primitive (a registry metric, an identity-graph profile, or a Decision-Log entry) and the same data is equally available via the Analytics API and MCP.

### 8.1 Home / Command Center
**Purpose.** Answer "are we making high-quality money today, and what should I do?" in seconds.
**User Journey.** Open Home → scan the revenue/profit strip, revenue-quality panel, Top 3 Actions, queues, Decision ROI, and health.
**Business Rules.** Realized vs placed shown as **two numbers, never blended**; CM2/CM3 carry confidence. **At most three actions**, each rendering the recommendation contract (§8.11) with Approve/Reject/Edit/Ask-why; every response writes to the Decision Log. Nothing-to-do shows fewer than three, never padded.
**Positive Scenarios.** An operator approves the top action in one tap from their phone.
**Negative Scenarios.** Realized data still settling → labeled provisional with the placed number beside it; a disconnected-integration card says "connect X," never a false green.
**Edge Cases.** First-run brand → "collecting your data" + backfill progress, not zeros. Irreversible actions show reversibility and require confirmation. Reject is first-class (logged, not re-surfaced unless conditions change).
**Permissions.** Per role/brand; Analyst view-only (can comment).
**Dependencies.** Metric registry; recommendation engine; Decision Log.
**Success Criteria.** Never more than three actions; every action shows confidence + risk; every response is logged.

### 8.2 Navigation & per-category analytics
**Purpose.** Drill into each commerce area with honest, traceable numbers.
**User Journey.** The dynamic sidebar (only connected sources) opens per-category surfaces with standard filters and drill-to-source.
**Business Rules.** Every metric resolves to the registry and supports drill-to-source; both per-source and combined exist; combined views resolve double-counting against the realized-revenue ledger; the definition version is labeled.
**Positive Scenarios.** An operator drills a CM2 number down to the orders behind it.
**Negative Scenarios.** A below-grade source labels its reports "estimated."
**Edge Cases.** A one-source category shows per-source and combined as the same.
**Permissions.** Per role/brand.
**Dependencies.** Registry; serving layer.
**Success Criteria.** Every metric drills to source; monetary performance is expressible in CM2 terms.

### 8.3 Executive lenses
**Purpose.** Give each leader their view from one trusted dataset.
**Business Rules.** CEO/CMO/COO/CFO/CTO **views are lenses, not roles**; all computed from the same dataset, so a discrepancy is a data-quality flag, not a definitional fight; no view may redefine a shared metric.
**Positive/Negative/Edge.** A view depending on a not-yet-connected source says what to connect; an Analyst opening an executive view gets it read-only with no raw PII.
**Permissions.** Selectable within the four roles; role/brand scope enforced.
**Dependencies.** Registry.
**Success Criteria.** The CMO's and CFO's "revenue" reconcile by construction.

### 8.4 Global search
**Purpose.** Find a customer, order, connector, metric, or past decision quickly.
**Business Rules.** Results are brand-scoped and PII-minimized per role.
**Positive/Negative/Edge.** No results → a clear empty state. An Analyst's results never expose PII beyond minimization.
**Permissions.** Per role/brand.
**Dependencies.** Search index over governed read models.
**Success Criteria.** A user finds the entity they need without leaving the active brand's isolation.

### 8.5 Settings
**Purpose.** One place to configure everything, with clear ownership.
**Business Rules.** A single information architecture enumerating every configurable object and its owning role: brand profile (currency/timezone/revenue definition), cost setup, goals, attribution model, consent text, notification preferences, quiet hours, team & roles, billing & tax profile, MCP/tracking keys, data export.
**Positive/Negative/Edge.** A Manager cannot reach cost setup or billing; a changed setting is audit-logged.
**Permissions.** Per object's owning role.
**Dependencies.** Audit log.
**Success Criteria.** Every configurable object is discoverable in Settings with its correct permission.

### 8.6 The reporting rhythm (Morning Brief, Evening Pulse, Weekly, Month-End, Event Mode)
**Purpose.** Give the operator a daily/weekly/monthly cadence of decisions, not chart dumps.
**User Journey.** Morning Brief (≤3 actions) → Evening Pulse (on pace?) → Weekly Review → Month-End Compound Report → Sale/Event Mode during events.
**Business Rules.** The Morning Brief is delivered by **email (the primary channel)** and over **WhatsApp as a Scheduled Delivery Channel** (the same channel that later carries the Daily Summary, Weekly Summary, and future digests; **not** a real-time alert channel — §8.8); each action carries problem → evidence → recommended action → expected impact → risk → confidence → buttons; responses write to the Decision Log. The Weekly Review includes a Decision Log summary with 7-day outcome accuracy ("pending" until the window closes). Event Mode's defining alert: **CM2 falling below the event threshold even while revenue rises.**
**Positive Scenarios.** A quiet morning gets fewer than three actions or "nothing needs you."
**Negative Scenarios.** A lagging integration → the brief still goes out, the affected action labeled "based on data still catching up," and a high-risk-on-incomplete-data action held back.
**Edge Cases.** A first-run brand gets an onboarding brief; a down critical integration becomes the top item.
**Permissions.** Per role/brand.
**Dependencies.** Recommendation engine; Decision Log; delivery channels.
**Success Criteria.** Briefs never exceed three actions; every response is logged; a launch is never gated on WhatsApp delivery (email fallback).

### 8.7 Natural-language AI assistant (NLQ)
**Purpose.** Answer plain-language questions with computed numbers, never invented ones.
**User Journey.** Ask in English → get the answer + exact numbers/formula + filters/period + confidence/caveat + suggested next action + a link to the report.
**Business Rules.** Every figure resolves to a registered metric computed deterministically; the AI never writes its own query or does arithmetic. The same governed tools serve NLQ and MCP, so both return identical numbers. Predictive/action questions are out of scope in early phases (descriptive/diagnostic only). Lakehouse-derived text is treated as data, never instruction.
**Positive Scenarios.** "Which campaigns drive the most CM2?" → a precise, sourced answer.
**Negative Scenarios.** A question mapping to no metric or unconnected data → says so plainly, offers the closest answerable question. A below-grade/stale source → answers with the caveat. An ambiguous question → a clarifying prompt.
**Edge Cases.** A poisoned campaign name attempting to steer the answer → treated as data; the answer/eligibility is unaffected.
**Permissions.** Per role/brand; every query audited.
**Dependencies.** LiteLLM gateway; metric registry; the resolution eval gate + injection golden-set.
**Success Criteria.** All numbers from deterministic queries; resolve-to-a-metric-or-decline; a misresolution regression fails the eval gate before ship.

### 8.8 Notifications & the preference center
**Purpose.** Interrupt only for what is time-sensitive and material, on the user's terms.
**User Journey.** Receive Critical / Important / Informational notifications routed by role/brand; manage preferences in a preference center.
**Business Rules.** Critical = act now (interruptive, repeated until acknowledged); Important = act today (one notification + a queue place + the brief); Informational = be aware (no interruption). **Real-time alert channels (Phase 1): in-product, email (the primary alert channel), and mobile-web/push.** **WhatsApp is a Scheduled Delivery Channel, not a real-time alert channel (Phase 1)** — it carries scheduled, batched deliveries (Morning Brief, Daily Summary, Weekly Summary, and future digests) but never real-time alerts, because of BSP dependencies, template approval, delivery unpredictability, and operational burden (wording is deliberately "Scheduled Delivery Channel," not "Morning Brief only," so delivery scope can grow without re-writing the requirement). The preference center manages per-channel toggles, per-tier overrides, immediate-vs-digest, and quiet hours (**critical may override quiet hours; nothing below it may**). Noise control groups related issues and, when alerting too often on a theme, proposes a rule instead of continuing to interrupt.
**Positive Scenarios.** A Brand Admin hears about their brands only; org-wide/financial matters reach the Owner.
**Negative Scenarios.** An Analyst is never alerted about brands they don't manage; preferences can tune delivery but never weaken security/compliance/audit.
**Edge Cases.** A flapping source is grouped into one calm notification.
**Permissions.** Per role/brand; personal preferences per user.
**Dependencies.** Health monitoring; the recommendation engine.
**Success Criteria.** Interruptive alerts are reserved for the material; preferences never bypass critical-safety routing.

### 8.9 The Brand Readiness Score
**Purpose.** Show a brand what to do next to unlock full value.
**Business Rules.** A sub-scored, weighted checklist (sources connected, pixel healthy, cost data toward Trusted, identity match rate, consent configured); each sub-score links to the action that raises it and gates which honesty-dependent features are active. It is a **to-do list, not a verdict.**
**Positive/Negative/Edge.** A new brand starts low with a clear first action; a regressed sub-score (e.g. a connector failing) lowers the score and surfaces the fix.
**Permissions.** Per role/brand.
**Dependencies.** Connector health; cost-confidence; identity; consent.
**Success Criteria.** Every sub-score is defined and links to a concrete action.

### 8.10 Self-serve data export
**Purpose.** Let a brand get its data out on its own terms.
**User Journey.** Choose report export, full-brand export, or DSAR export → trigger → receive the file.
**Business Rules.** **Report export** (a single view, async for large exports, format and PII rules per role); **full-brand export** (raw + normalized + Decision Log in open formats — also the offboarding export); **DSAR export** (a data-subject access/portability export). Who can trigger each, where it lands, and rate limits are stated per path.
**Positive/Negative/Edge.** A large export runs async with a ready notification; an Analyst's export is PII-minimized.
**Permissions.** Report export per role; full-brand and DSAR export Owner/Brand Admin.
**Dependencies.** Lakehouse; compliance (§11).
**Success Criteria.** A brand can self-serve its data; PII rules hold per role; no hostage data.

### 8.11 MCP access (the brand pulls its own data)
**Purpose.** Expose the lakehouse read-only to the brand's own tooling, returning the same numbers Brain's screens show.
**User Journey.** Generate a brand-scoped, permission-scoped MCP key → point ChatGPT/Claude/Cursor/an agent at it → pull data through governed named tools.
**Business Rules.** Read-only, brand-scoped, permission-scoped, fully audited; bound to the same metric definitions as Brain's screens. MCP can never write, delete, run arbitrary SQL, reach another brand, or touch secrets. Keys shown once, expiring, instantly revocable; every request flows MCP → Analytics API → semantic layer → lakehouse (never physical tables).
**Positive Scenarios.** A brand's agent gets the identical realized-CM2 figure Brain's dashboard shows.
**Negative Scenarios.** A key hitting a limit (rows/rate/timeout/budget) gets a clear, machine-readable error, never a silent partial result; a revoked/expired key fails closed.
**Edge Cases.** Any attempt to reach another brain or run raw SQL is structurally impossible.
**Permissions.** Keys managed by Owner/Brand Admin only.
**Dependencies.** Analytics API; semantic layer; LiteLLM (for model-touched paths).
**Success Criteria.** Read-only and brand-scoped under any configuration; limit hits are explicit errors; numbers match the screens.

### 8.12 The Decision Log, AI provenance & compounding memory
**Purpose.** Make every decision permanent operating memory.
**Business Rules.** Append-only, immutable in operation, retained for workspace life; records recommendations, approvals/rejections/edits/deferrals, manual decisions, auto-executions, reversals, lifecycle sends, support resolutions, refunds/replacements, courier/budget changes, audience activations, attribution-model changes, guardrail blocks, and 7/30-day outcomes; references customers by **Brain ID, not PII**. **AI provenance** additionally records model id+version, prompt-template version, the resolved metric-binding, data snapshot/version pins, confidence inputs, and cost/latency. The **Brand Fingerprint** learns the brand's patterns (never leaks across brands). **If it isn't logged, it didn't officially happen.**
**Positive/Negative/Edge.** A reversal updates the outcome; a rejected action is logged as fully as an approved one; "why did Brain recommend this?" is reproducible months later.
**Permissions.** Per role/brand; immutable to all.
**Dependencies.** Control plane; the AI layer.
**Success Criteria.** 100% of Brain actions are logged; every AI response is reproducible from its provenance.

### 8.13 AI safety, the resolution eval gate & consent enforcement
**Purpose.** Make the AI trustworthy by construction.
**Business Rules.** Primary defense is architectural (numbers deterministic; the model can't issue queries or change a number/weight/eligibility). Lakehouse-derived text is untrusted/delimited, never in the instruction channel. Recommendation **eligibility is computed deterministically** (grade/confidence/reversibility); the model only explains. A **golden question→metric-binding eval** is a ship gate on every prompt/model/registry change (resolution accuracy + decline-correctly); any failover model must pass it. The `ai_processing` consent flag is checked at the Analytics-API boundary for per-profile use and declines (audited) when not granted. An **injection golden-set** is part of the gate.
**Positive/Negative/Edge.** A prompt change that would silently misresolve "revenue" to placed fails the eval before ship. A profiling request without `ai_processing` consent is declined and logged.
**Permissions.** System; governed by CI.
**Dependencies.** LiteLLM; metric registry; consent store.
**Success Criteria.** No misresolution regression ships; no profiling-without-consent occurs; injection cannot alter a number or an eligibility.

---

## 9. Pricing, metering & billing

### 9.1 The pricing principle
**Purpose.** Align Brain's price with the brand's realized profit.
**Business Rules.** A percentage of **realized GMV under management** by tier (Launch ~1.0% / Growth ~0.75% / Scale ~0.5% / Enterprise custom), with a **minimum monthly fee** and a **CM2 affordability cap**. **No per-seat pricing.**
**Positive/Negative/Edge.** Below-floor % → pays the floor; a thin-margin brand may have the cap pull the fee below the raw %; Enterprise goes onto a custom contract.
**Permissions.** Owner (billing actions).
**Dependencies.** The meter (§9.3); cost-confidence (§6.4).
**Success Criteria.** Billable base is always realized GMV; adding users never changes the fee.

### 9.2 The activation period
**Purpose.** Don't bill on a number Brain can't yet stand behind.
**Business Rules.** A time-boxed window aligned with Day 0–14 onboarding before the first GMV invoice (sources connected, history backfilled and quality-scanned, costs set up, Owner signs off cost assumptions + revenue definition, activation review). **Day 14 is a minimum gate, not a calendar default** — it extends per contract when DQ grade or backfill depth hasn't cleared the bar. Realized GMV during activation isn't retroactively billed.
**Positive/Negative/Edge.** A 24-month backfill across rate-limited APIs, or a COD brand whose first cohort hasn't realized → activation extends; affected reports stay "estimated."
**Permissions.** Owner sign-off.
**Dependencies.** DQ grades; cost setup; backfill.
**Success Criteria.** No GMV invoice issues before the accuracy bar is cleared.

### 9.3 The meter, the CM2 cap & the cost-confidence gate
**Purpose.** Compute a fair, inspectable fee on realized GMV.
**Business Rules.** Base = **realized/delivered GMV (finalized rows only)**, converted at the **realization-date FX** (frozen on close). Later refunds/RTO/chargebacks post as **adjustments in the period they happen**; a closed/invoiced period is never edited. **Fee = max(min(tier%×GMV, cap%×CM2), min fee)**, where the cap applies **only at Trusted cost-confidence** — otherwise bill the full %GMV and record a **flagged true-up** to reconcile when costs reach Trusted (a true-up credit posts forward, never edits a closed invoice). The reporting revenue definition never changes the bill.
**Positive Scenarios.** Healthy Growth, Trusted: GMV ₹50,00,000 ×0.75% = ₹37,500 (cap not binding). Thin-margin Launch, Trusted, cap binds: ₹40,00,000 ×1.0% = ₹40,000 vs CM2 ₹1,00,000 ×30% = ₹30,000 → ₹30,000.
**Negative Scenarios.** Same brand, costs only Estimated → cap can't apply → billed ₹40,000, true-up records the hypothetical ₹30,000; when costs reach Trusted, a ₹10,000 credit posts forward. A heavy-refund month with ~zero net realized GMV → the minimum fee still applies.
**Edge Cases.** A COD order not yet delivered is not billable; a true-up not signed off within its SLA (default 90 days) expires (default: no retroactive credit). Costs slipping Trusted→Estimated lose the cap prospectively.
**Permissions.** Owner.
**Dependencies.** The realized-revenue ledger; cost-confidence; FX.
**Success Criteria.** A brand can't shrink its bill by withholding cost data; Brain never bills against a margin it can't stand behind; closed periods are immutable.

### 9.4 The inspectable bill
**Purpose.** No invoice on a number the customer can't inspect and reconcile.
**Business Rules.** Before any invoice issues, the brand inspects the full computation (a preview after the period seals), drilling into the **same** numbers their dashboards show: GMV (→ the realized-revenue ledger + period boundaries in the brand timezone), the FX basis (per-currency rates dated at realization, declared source), the tier math, the cap with a cost-confidence badge (and any true-up note), the floor if it binds, adjustments (each linked to origin), and fee/tax/total. Every line ties to an immutable snapshot + the metric-definition version used.
**Positive/Negative/Edge.** A discrepancy spotted in preview is raised as a data dispute before the invoice issues; Brand Admins view but don't act.
**Permissions.** Owner acts; Brand Admin views.
**Dependencies.** Meter snapshot; metric registry.
**Success Criteria.** Every invoice line is self-explaining and traceable months later.

### 9.5 Invoicing, payment collection & dunning
**Purpose.** Bill compliantly per region and collect without holding data hostage.
**Business Rules.** India GST (GSTIN, SAC/HSN, place of supply, CGST+SGST vs IGST, gapless numbering per FY per GSTIN, e-invoicing/IRN where applicable); UAE VAT (TRN, 5%, AED); KSA ZATCA (15%, Arabic+English). Tax is on **Brain's fee**, separate from the brand's own sales tax. Regional rails (UPI/net-banking/cards India; cards GCC); only gateway tokens stored. On non-payment a dunning ladder runs; **continued non-payment degrades to read-only** (action/execution off) **but full read + export remain**; Brain **never deletes a delinquent brand's data** as a collection tactic.
**Positive/Negative/Edge.** A successful payment recovers the account; a delinquent-and-Owner-gone brand recovers via break-glass.
**Permissions.** Owner.
**Dependencies.** Payment gateways; entitlement layer; offboarding.
**Success Criteria.** Only gateway tokens stored; non-payment degrades, never deletes.

### 9.6 Plan lifecycle, disputes & value proof
**Purpose.** Handle plan changes, disagreements, and continuous return-proof honestly.
**Business Rules.** Activation→Active at the gate; upgrade/downgrade at next period start by default (a mid-month immediate upgrade splits the period by realization date; downgrades default to next-period-start, anti-gaming); pause halts metering; cancel produces a final invoice through the cancel instant + open adjustments + true-up resolution, then offboarding. A billing dispute is a **data dispute** resolved against the immutable snapshot + ledger; a confirmed DQ failure means the bill is **corrected, not defended** (credit note, never an in-place edit). **Value proof** continuously shows attributed placed/realized revenue, recovered/protected revenue and CM2, the fee, and the recovered/fee ratios — with **early-life honesty** (months 1–2 contextualized as "still compounding").
**Positive/Negative/Edge.** A thin-value period shows it honestly; recovered-CM2 carries the same cost-confidence honesty.
**Permissions.** Owner.
**Dependencies.** Meter; ledger; metric registry.
**Success Criteria.** Every transition is dated and logged; disputes resolve against data; every brand sees its fee next to the value delivered.

---

## 10. Lifecycle, support & safe automation (later phases)

> **Lifecycle & AI support = Phase 3; autonomous execution = Phase 4. Recommend-only is the default forever.** Specified now so the data foundation supports it.

### 10.1 Lifecycle as a revenue engine (Phase 3)
**Purpose.** Drive realized CM2 across channels from one decision layer.
**Business Rules.** One channel-agnostic audience layer; Brain recommends a channel mix ranked by expected realized CM2. **Margin-gating (hard rule):** never recommend a discount or paid send where expected CM2 is negative after message + offer + expected RTO/refund cost. The offer ladder starts no-discount-first. WhatsApp sends are consent-aware (no template to a non-consented number), template-approved, frequency-capped; cost tracked split utility (CM1) vs marketing (CM2). **WhatsApp commerce** (catalog→cart→pay-in-chat) is a distinct order source flowing to the realized ledger + a lifecycle contribution row.
**Positive/Negative/Edge.** A CM2-negative send is blocked by the ladder (override is explicit and logged); a customer with no consented reachable channel is "matched but unreachable," never counted as sent; a delivery that fails is "attempted, not delivered" (cost booked only on delivered).
**Permissions.** Owner/Brand Admin approve/execute.
**Dependencies.** Identity; consent; channel connectors; CM2.
**Success Criteria.** No non-consented send is possible; no CM2-negative send is recommended.

### 10.2 AI ticket management as revenue protection (Phase 3)
**Purpose.** Treat support tickets as commerce events and price each resolution in CM2.
**Business Rules.** Classify → enrich (order history, RFM, LTV, shipment status, policy eligibility, suggested resolution + its CM2 impact) → **auto-resolve if low-risk and high-confidence**, draft if medium, escalate if high-risk → log. AI safety: never invent delivery status/unverifiable facts, never promise outside policy, never reveal internal margins/scores, never continue after a human is requested, never send without consent, never make an irreversible financial decision above cap; always disclose it's automated and offer handoff.
**Positive/Negative/Edge.** A genuinely late delivery triggers delivery-recovery before RTO; a return is met first with exchange/replacement/credit over cash where CM2-positive; a refund above cap is **never** auto-resolved even at high confidence.
**Permissions.** Owner/Brand Admin configure; auto-resolution within guardrails.
**Dependencies.** Identity; order/shipment domains; policy engine.
**Success Criteria.** Every resolution is priced in CM2 and logged; human-request handoff is immediate.

### 10.3 Agents & safe autonomous execution (Phase 4)
**Purpose.** Let Brain act on the low-risk classes the Owner explicitly enabled.
**Business Rules.** Agents only recommend unless an action is inside an Owner-enabled auto-execute class (off by default, Owner-only to enable). Every recommendation carries the **recommendation contract** (§8.11/BRD §11.4.3). **Guardrails are conjunctive** (confidence ≥ class threshold; action + daily/weekly caps; freshness, consent, policy checks; reversible-or-explicitly-approved; permission granted) — fail any one → recommend-only. **Auto-revert** pulls a class back to recommend-only on a reversal/error-rate breach. **The 60-second kill switch** stops all autonomy (Owner org-wide; Brand Admin brand-level); pausing never stops analytics or recommendations.
**Positive/Negative/Edge.** Stale data → freshness check fails → that path pauses to recommend-only; rising reversal rate → auto-revert + Owner notified; kill switch mid-action → in-flight reversible actions halted/rolled back where safe, no new autonomous action starts.
**Permissions.** Owner enables auto-execute; Brand Admin holds a brand-level kill switch.
**Dependencies.** Guardrail engine; Decision Log; the metric/attribution platform.
**Success Criteria.** No class auto-executes without all guardrails; the kill switch stops autonomy within 60 seconds; the platform default remains recommend-only.

---

## 11. Trust, privacy, compliance & reliability

### 11.1 Absolute brand isolation
**Purpose.** Guarantee one brand can never see, reach, or affect another's data.
**Business Rules.** Structural, not a setting — enforced in the DB kernel (RLS + tenant context), a network boundary around the lakehouse, per-brand S3 prefixes, and per-brand KMS keys; the tenant key travels on every row, event, cache key, and log line. A cross-brand leak is always a **P0** → breach workflow. Internal Brain staff are subject to the same isolation.
**Positive/Negative/Edge.** An attempted cross-brand access (malformed query, tampered token, dropped filter) is blocked at the isolation layer, logged, and raised as P0 even if nothing escaped; the default on ambiguity is deny.
**Permissions.** All roles and internal staff.
**Dependencies.** Postgres RLS; S3 prefixes; KMS; StarRocks row policies.
**Success Criteria.** Continuous isolation fuzzing passes in CI at every layer including StarRocks and MCP; the leak target is zero.

### 11.2 Consent (collection & communication)
**Purpose.** Make non-consented contact impossible by construction.
**Business Rules.** Collection consent at capture (four categories); communication consent at send (each channel its own opt-in); the AI-processing flag respected by every AI surface. Channel rules: WhatsApp (Meta opt-in, approved templates, frequency caps, 24h service window); SMS/voice (DLT-registered headers/templates, NCPR/DND scrubbing, **9am–9pm recipient timezone**); AI voice (automated-caller disclosure + immediate handoff). Withdrawal suppresses from all outreach immediately and retroactively (incl. queued messages).
**Positive/Negative/Edge.** SMS attempted outside 9pm or to a DND number → blocked (held for the next lawful window or dropped, logged); missing consent → excluded from that channel.
**Permissions.** System; consent text by Brand Admin/Owner.
**Dependencies.** Consent store; channel connectors.
**Success Criteria.** Outreach to a non-consented/withdrawn customer is impossible; every suppression is logged with its consent state.

### 11.3 Data storage rules, residency & retention
**Purpose.** Store only what's lawful and necessary, in-region, with stated retention.
**Business Rules.** Stores PII-minimized data (identifiers hashed by default); **must never store** card numbers, CVVs, raw bank details, full UPI secrets, national IDs, special-category data, plaintext passwords, full addresses by default, or **PII in logs ever**. Lawful plain contact PII lives in an encrypted vault readable only by the send service. **Indian customer data in-region by default** (every brand); GCC per local rules; cross-border paths on the sub-processor registry under the DPA. Retention is stated per data class (raw 24 months; canonical/audit/Decision Log for workspace life; consent/erasure records as law requires).
**Positive/Negative/Edge.** A connector/upload trying to bring in a forbidden field is dropped/refused; a **DPDP/PDPL erasure request overrides retention** via Brain-ID pseudonymization (the person is forgotten; the math still reconciles).
**Permissions.** System; governed by compliance.
**Dependencies.** KMS vault; sub-processor registry; DPA.
**Success Criteria.** The "must never store" list is absolute across every ingestion path; erasure beats retention without destroying decision history.

### 11.4 Audit & explainability
**Purpose.** Make every sensitive action auditable and every number explainable.
**Business Rules.** An append-only, tamper-evident audit log of every sensitive action (incl. AI/MCP queries, auto-execute toggles, exports, deletions); every number is explainable (formula, filters, period, freshness). A log that can't be edited/selectively deleted from within the product (an attempt is itself a security event).
**Positive/Negative/Edge.** A sensitive action that isn't auditable shouldn't ship; a number that can't be explained shouldn't render as fact.
**Permissions.** Owner/Brand Admin view; immutable to all.
**Dependencies.** Append-only store.
**Success Criteria.** Every sensitive action is present and immutable; every rendered number is explainable.

### 11.5 Offboarding & data exit (no hostage data)
**Purpose.** Guarantee a brand can always leave with its data.
**Business Rules.** On cancellation: a complete export (raw + normalized + Decision Log in open formats); integration tokens/credentials revoked immediately; tracking/MCP keys deactivated; after a default 90-day window, data deleted, certified, and audit-logged. **No hostage data, ever.**
**Positive/Negative/Edge.** A delinquent brand degrades to read-only — its data is **not** deleted; a brand reactivating within 90 days keeps its data.
**Permissions.** Owner.
**Dependencies.** Export; deletion certification.
**Success Criteria.** Export first, deletion second (certified, logged); delinquency degrades access, never deletes data.

### 11.6 Security, reliability & honest behaviour under bad data
**Purpose.** Protect access, keep the platform available, and stay honest when data is bad.
**Business Rules.** MFA from day one; SSO for enterprise; immediate revocation; encryption in transit + at rest; KMS-backed secrets never in logs; internal staff work through a PII-minimized, access-grant-gated console (support views a workspace only via an explicit, customer-consented, time-boxed, audited grant — never silent impersonation). Availability: **ingestion endpoint 99.95%** (scoped to Brain's collector endpoint; the pixel buffer mitigates brief downtime), **product surfaces 99.9%**; RPO ≤15 min, RTO ≤4h → ≤1h; **no committed brand data is ever permanently lost**; maintenance avoids peak commerce windows; a measured public status surface with proactive incident comms. Three defaults under bad data: **show the data you trust, label the data you don't, never let automation run on a foundation Brain doesn't believe in.**
**Positive/Negative/Edge.** Outage during a sale → already-approved safe automation and scheduled comms proceed where possible, and the operator is told exactly what did and did not run; a confirmed/suspected cross-brand leak is always P0 → breach workflow.
**Permissions.** All roles; internal access consented/time-boxed/audited.
**Dependencies.** Observability stack; breach workflow; the entitlement layer.
**Success Criteria.** Revocation is immediate; the collection path carries the strictest bar; a confident-looking screen never hides a data problem.

---

*End of Product Functional Specification. Companion documents: `01_Brain_Business_Requirements_Document.md`, `03_Brain_Technology_Stack_and_Technical_Decisions.md`.*
