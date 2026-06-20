# CONTENT.md — Brain house style for all user-facing copy

The single reference for writing strings in Brain — onboarding, dashboards, empty/error states,
labels, tooltips, toasts, emails, docs. If you're writing or reviewing copy, follow this. It exists
so every string stays consistent without re-deriving the rules.

> **Brain's promise:** Capture Truth → Build Trust → Enable Decisions.
> Brain is an **AI-native commerce OS** — *not* a dashboard, BI tool, CDP, or attribution tool.
> It builds trust before it shows insight, unlocks features progressively by data readiness, and
> never shows an empty or misleading experience.

---

## The one rule above all

**Copy must match actual product behaviour — always.** Never instruct an action the UI can't perform,
never imply a gate that doesn't exist, never show a status/icon/colour that overstates certainty.
If the code does X, the copy says X. Honesty *is* the product.

---

## Voice principles

1. **Position as a commerce truth/trust OS** — never a dashboard, BI, CDP, or analytics tool. Lead
   with the differentiated promise (trust before insight, readiness-gated unlock) at every first
   impression. **Banned as product descriptors:** "intelligence platform", "command center",
   "Analytics".
2. **Match copy to actual behaviour.** (The rule above — it's worth repeating.)
3. **Keep the machine out of the words.** Internal nouns — pipeline stages (ingestion, bronze,
   ledger, detectors, metric-engine, binding), function names (`can_contact()`), vendor/event names
   (`checkout_abandoned` webhook), formulas (`min(cost, attribution)`), unexpanded acronyms (MMM, DLT,
   TCCCPR, SAC) — belong in tooltips, `aria-label`s, and code comments, **never** in headings,
   subtitles, KPI labels, or body copy. Every raw backend enum passes through `humanize()` before it
   reaches the DOM.
4. **Lead with the consequence, then the mechanism.** Say what a number/state *means for the user*
   ("reliable enough to bill against") before *how it works* ("the billing cap applies"). Expand
   every acronym on first use, per surface.
5. **Make empty and locked states useful and directional** — never dead ends. Name the real status
   (not a generic "No Data Yet"), name the concrete next benefit, and surface the single unblocking
   action inline as a button wherever one action (usually "connect a source") unblocks the state.
   Reuse no string across two different meanings.
6. **Frame low-trust and locked states as temporary and fixable**, not verdicts. Prefer "not yet
   ready", "still firming up", "unlocks automatically once…" over "not trustworthy" or a bare
   punitive "Locked". Progressive unlock should read as momentum the user grows into.
7. **Earn trust through accuracy, not enthusiasm.** Reserve celebration words and exclamation marks
   for moments the product can actually deliver value. At a necessarily-empty first dashboard, set
   honest expectations ("Brain will build your revenue truth as your data comes in") — never
   "You're all set!".
8. **Tone:** professional, confident, calm, premium, human. Clarity first; simple, direct language;
   reduce friction and cognitive load; never overpromise; no vague marketing fluff.

---

## Errors

- **Title = what failed**, specific: "Couldn't update the role", "Couldn't connect Shopify". Never
  the bare title "Error", never the log-word "Failed".
- **Body = what to do next.** For our-side faults (5xx): add a one-clause data-is-safe reassurance —
  "Brain had a brief problem on our side. Your data is safe — please try again in a moment." For
  unreachable network: "Can't reach Brain right now. Check your connection and try again."
- **Never** show an HTTP status code or a raw backend string. Label any `request_id` as a support
  reference.
- Failure toasts use `variant: 'destructive'`.

## Empty & locked states

- Name the real status, not a recycled generic label. ✅ "Not connected yet" / "No brand yet" /
  "No connectors to show yet" — ❌ one "No Data Yet" reused everywhere.
- Chart empties use the business subject: "No revenue yet" / "No orders yet" / "No ad spend yet".
- Add the single unblocking CTA ("Connect a source") wherever one action unblocks the state.
- Locked-by-readiness: label "Unlocks soon" (button) / "Locks until ready" (pill), with the unlock
  reason as **visible** text — not hover-only.

## Casing & naming

- **Sentence case** for every button and label ("Skip for now", "Go to your dashboard").
- One product name: **Brain**. Never "Brain Analytics" or "Brain Intelligence Platform".

---

## Brain glossary (term → use / avoid)

| Term (internal) | Use | Avoid |
|---|---|---|
| **data foundation** | "your data" / "your connected sources" / "enough order data"; in hints: "Connect your data sources — this unlocks automatically once Brain has enough data." | "Build your data foundation to unlock" or any bare "data foundation" in a user-facing hint — it names no action. |
| **progressive unlock / locked center** | "Unlocks soon" (button), "Locks until ready" (pill), unlock reason as visible text ("unlocks automatically once…"). Frame as temporary + data-driven. | a bare "Locked"; hiding the what-unlocks-it reason in a hover-only tooltip. |
| **confidence / trust tiers** | Trusted = "reliable enough to bill against, feed your marketing-mix model, and power recommendations"; Estimated = "an estimate, not verified totals"; Untrusted = "Not yet reliable — not enough verified data to rely on these yet." Icon must match tier: ShieldCheck only for Trusted, ShieldAlert below. | "not trustworthy"; a green ShieldCheck on a non-Trusted item; "flow into MMM / billing cap applies / unrestricted". |
| **held recommendation** | Heading "Held until your data is ready"; "Brain spotted these but won't recommend acting until your data is trusted enough to rely on"; CTA "See what to fix →". | heading + CTA both phrased as "data confidence" (circular); "signals" as the noun. |
| **realized vs provisional revenue** | Provisional = "Provisional revenue / placed, not yet confirmed"; Realized = "Realized revenue / confirmed". | "Provisional / not yet settled" (finance jargon, no benefit, no noun). |
| **MMM** | "marketing-mix model" — expanded on first use, every surface. | the bare "MMM" or "billing/MMM". |
| **ingestion / bronze / ledger / detectors** | ingestion → "events received"; bronze events → "events received"; ledger data → "connect your store and payments so Brain can recognize revenue"; run detectors → "Check for new actions" / "Checking…". | any of these pipeline/lakehouse/engine terms in headings, subtitles, KPI labels, or buttons. |
| **backfill** | "Import History" / "Import your order history" — and use the same wording in toasts as on the button. | "run a backfill" in a toast when the button says "Import History". |
| **RTO** | label "RTO rate", sublabel "orders returned undelivered". | sublabel "return to origin" alone (expands the acronym without explaining what it measures). |
| **sync vs ingest** | Last sync = "we reached the source"; Last ingest / "events received" = data actually arrived. `waiting_for_data` → "Connected — waiting for your first orders to arrive". | "Connector handshake"; "No sync yet…" on a state that *is* connected. |
| **consent gate** (`can_contact()`, DLT, TCCCPR, "subject") | "Every marketing message is checked before it sends. By default the answer is no…"; "customer" not "subject"; "India's DPDP and DLT (carrier-registered template) requirements" with DLT expanded. | the function name `can_contact()`, the legal noun "subject", unexpanded "DLT"/"TCCCPR". |
| **billing seal** (seal / immutable / meter) | "Seal a month to lock in what Brain bills you for that period — your share of realized GMV. Once sealed, the figure can't change, so there are no surprise adjustments." | "meter", "sealed", "immutable" without an inline plain-language anchor. |
| **Brain Pixel** | "paste the snippet before the `</head>` tag"; for verification-unlock reuse: "connecting a store, inviting your team, and billing". | "activate your account" (the account is already active under the soft-gate model). |
| **product name** | "Brain", and a trust-first tagline ("The commerce OS that earns your trust before it shows you answers"). | "Brain Analytics", "Brand Intelligence Platform", "brand intelligence command center". |

---

## Implementation hooks

- **Raw enums → `humanize()`** (`apps/web/lib/format/humanize.ts`): route every operator-facing enum
  (`trigger_reason`, `lifecycle_state`, `identifier_type`, channel, …) through it. Add a curated
  label for new enums; unknown values fall back to Title Case.
- **Honest-empty pattern**: `EmptyState` (`apps/web/components/ui/empty-state.tsx`) — title + helpful
  description + the unblocking CTA. Never render a fabricated zero as success.

## What to protect (don't "improve" these)

Brain's copy is at its best where the engine refuses to fabricate. Keep these verbatim:
- **Held recommendations** — surfaced, not hidden, with the reason and a path to fix.
- **Attribution "not computed"** — "We don't show a 0%/100% figure, because that would be a guess,
  not a measurement."
- **Never-faked "Live"** — the liveness indicator reflects the real last fetch.
- **Retained-data disconnect banner** — "Showing last-synced data… your historical data is preserved."
- **Default-closed consent** — the fail-closed posture stated plainly.
- **Enumeration-safe auth** — "If an account exists, we've sent a reset link."

These are the Capture-Truth → Build-Trust promise, written down. Don't trade them for polish.
