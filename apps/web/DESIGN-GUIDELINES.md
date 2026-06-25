# Brain Design Guidelines

The contract every build agent composes against. Ethos: **Capture Truth → Build Trust → Enable Decisions.** Calm, restrained, data-forward. Linear / Vercel / Stripe calibre. When in doubt: fewer borders, more whitespace, one accent.

Primitives live in `apps/web/components/ui/*` and are imported via `@/components/ui/<name>`. **Compose primitives — do not re-style raw HTML or hard-code colour.**

## Tokens (never hard-code hex)

All colour is HSL CSS variables in `app/globals.css`, exposed as Tailwind classes. Light + dark (`.dark` class) ship.

- **Surfaces:** `background` (canvas), `surface` (panels/inputs), `card`, `popover`, `muted`.
- **Ink:** `foreground` (primary), `muted-foreground` (secondary/labels).
- **Brand:** `primary` (indigo) — the ONLY accent hue. Use sparingly: primary action, active state, focus.
- **Semantic (each has `DEFAULT`, `-foreground`, `-subtle`, `-subtle-foreground`):** `success`, `warning`, `destructive`, `info`. Prefer the `*-subtle` pair for chips/banners; solid only for primary emphasis.
- **Lines:** `border`, `input`, `ring` (focus).
- **Charts:** `chart-1`…`chart-6`.

## Scale

- **Spacing:** Tailwind 4px scale. Card padding `p-5`. Page gutter via `container`. Section gaps `gap-4`/`gap-6`. Vertical page rhythm `space-y-6`.
- **Radius:** `rounded-sm | md | lg | xl` derive from `--radius` (10px). Cards/inputs `rounded-lg`/`rounded-md`; chips `rounded-full`.
- **Shadow:** `shadow-xs` (controls), `shadow-sm` (cards — default), `shadow-md` (popovers/menus), `shadow-lg` (modals). Shadows are soft and low-contrast — never heavy.
- **Type:** system sans. `text-2xl font-semibold tracking-tight` = page H1; `text-base font-semibold` = section/card title; `text-sm` = body; `text-xs text-muted-foreground` = meta/labels. **All numbers/money use `tabular-nums`** (built into MetricCard/Table numeric cells).

## States (every interactive element)

- **Focus:** keyboard focus is always visible — `focus-visible:ring-2 ring-ring`. Never remove it.
- **Hover:** subtle bg shift only. **Disabled:** `opacity-50` + no pointer. **Loading:** `Button loading`, `Skeleton`/`SkeletonText` — reserve layout, never flash 0.
- **Reduced motion** is honoured globally; keep animations ≤160ms and optional.

## Trust rules (non-negotiable — this is the product)

1. **No empty charts as success.** No data → render `EmptyState` explaining *why* it's empty and *how* to get data flowing. Never fabricate or zero-fill.
2. **Show freshness.** Every data panel surfaces `FreshnessIndicator` (tone `stale` past SLA) near the value.
3. **Show confidence.** Any computed/estimated/modelled number carries `ConfidenceMeter` (or an "Estimated" `Badge`). Confidence before decisions.
4. **Status is never colour-only.** `StatusBadge` always pairs the dot with a text label.
5. **Money is locale-agnostic.** Primitives never format numbers — pass pre-formatted strings from the app's money/number formatter.

## Components

- **Page:** wrap routes in `PageHeader` (one `<h1>`; use `meta` for freshness/confidence/status). Group content in `SectionCard`.
- **KPIs:** `MetricCard` (label, pre-formatted value, optional delta + freshness + confidence). Use `loading` while fetching.
- **Tables:** `Table*` primitives inside a `SectionCard` (`flush`). Numeric cells use `numeric`.
- **Tabs:** `Tabs/TabsList/TabsTrigger/TabsContent` (keyboard-navigable, no extra dep).
- **Feedback:** inline → `Alert`; transient → `toast()`; failed fetch → `ErrorCard`; help → `Tooltip`.
- **Forms:** `Input` (`invalid` for errors) + `Label` + `Select`.

## Do / Don't

- Do reuse primitives; extend via `className`. Don't fork or inline-style.
- Do lead with neutrals; let one accent + semantic colour carry meaning. Don't use multiple bright hues or decorative gradients.
- Do keep density calm — generous whitespace, clear hierarchy. Don't crowd, box-in-box, or add noise.
- Need a new shared primitive? Build it **locally** in your page dir and flag it for consolidation — don't silently diverge.
