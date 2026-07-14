import Link from 'next/link';
import { cookies } from 'next/headers';
import {
  ArrowRight,
  Fingerprint,
  Route,
  Coins,
  Target,
  ShieldCheck,
  Sparkles,
  Database,
  GitBranch,
  Gauge,
  Lock,
} from 'lucide-react';
import { Button } from '@/components/ui/button';

export const metadata = {
  title: 'Brain — The AI-native Commerce OS',
  description:
    'Brain captures the truth of every customer, order, and touchpoint — then builds the trust and confidence brands need to make revenue decisions.',
};

// Public marketing home. Always renders the landing page; the CTA adapts to
// whether the visitor already has a session (cookie present → "Go to app").
export default async function Home() {
  const hasSession = Boolean((await cookies()).get('brain_session')?.value);

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <SiteHeader hasSession={hasSession} />
      <main className="flex-1">
        <Hero />
        <Ethos />
        <Capabilities />
        <Pipeline />
        <Principles />
        <ClosingCta />
      </main>
      <SiteFooter />
    </div>
  );
}

/* ------------------------------------------------------------------ header */

function SiteHeader({ hasSession }: { hasSession: boolean }) {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur">
      <div className="container flex h-14 items-center justify-between">
        <Wordmark />
        <nav className="hidden items-center gap-6 text-sm text-muted-foreground md:flex">
          <a href="#capabilities" className="transition-colors hover:text-foreground">
            Capabilities
          </a>
          <a href="#pipeline" className="transition-colors hover:text-foreground">
            How it works
          </a>
          <a href="#principles" className="transition-colors hover:text-foreground">
            Principles
          </a>
        </nav>
        <div className="flex items-center gap-2">
          {hasSession ? (
            <Button asChild size="sm">
              <Link href="/select-org">
                Go to app
                <ArrowRight />
              </Link>
            </Button>
          ) : (
            <>
              <Button asChild variant="ghost" size="sm">
                <Link href="/login">Sign in</Link>
              </Button>
              <Button asChild size="sm">
                <Link href="/register">
                  Get started
                  <ArrowRight />
                </Link>
              </Button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

function Wordmark() {
  return (
    <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
      <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <Sparkles className="size-4" />
      </span>
      Brain
    </Link>
  );
}

/* -------------------------------------------------------------------- hero */

function Hero() {
  return (
    <section className="relative overflow-hidden border-b border-border">
      {/* decorative background layers — purely presentational */}
      <div className="pointer-events-none absolute inset-0 bg-hero-glow" aria-hidden />
      <div className="pointer-events-none absolute inset-0 bg-grid" aria-hidden />

      <div className="container relative flex flex-col items-center gap-7 pt-20 text-center md:pt-28">
        <Link
          href="/register"
          className="animate-sheen group relative inline-flex items-center gap-2 overflow-hidden rounded-full border border-border bg-surface/80 px-3.5 py-1.5 text-xs font-medium text-muted-foreground shadow-xs backdrop-blur transition-colors hover:text-foreground"
        >
          <span className="flex size-1.5 rounded-full bg-success" aria-hidden />
          Now with data-driven Markov attribution
          <ArrowRight className="size-3 transition-transform group-hover:translate-x-0.5" />
        </Link>

        <h1 className="max-w-4xl text-4xl font-semibold leading-[1.05] tracking-tight text-balance sm:text-6xl md:text-7xl">
          The commerce truth layer that{' '}
          <span className="text-gradient-brand">powers every decision</span>
        </h1>

        <p className="max-w-xl text-md text-muted-foreground sm:text-lg">
          Brain unifies every event, order, and touchpoint into one trustworthy foundation —
          so your team stops arguing about the numbers and starts acting on them.
        </p>

        <div className="flex flex-col items-center gap-3 sm:flex-row">
          <Button asChild size="lg" className="shadow-sm">
            <Link href="/register">
              Start free
              <ArrowRight />
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline" className="backdrop-blur">
            <Link href="/login">Sign in</Link>
          </Button>
        </div>

        <p className="text-xs text-muted-foreground">
          No event loss. No empty charts. Data foundation before dashboards.
        </p>

        <HeroPreview />
      </div>
    </section>
  );
}

/* Framed product preview — a faithful, on-brand dashboard mock that makes the
   promise concrete (the signature move competitors lead with) while doubling
   as proof of the trust primitives: freshness + confidence on every number. */
function HeroPreview() {
  return (
    <div className="relative mt-6 w-full max-w-4xl">
      {/* glow puddle under the panel */}
      <div
        className="pointer-events-none absolute -inset-x-8 -bottom-6 top-8 rounded-[2rem] bg-primary/20 blur-3xl"
        aria-hidden
      />
      <div className="animate-float relative rounded-xl border border-border bg-card/90 shadow-lg backdrop-blur">
        {/* browser chrome */}
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <span className="size-2.5 rounded-full bg-destructive/60" aria-hidden />
          <span className="size-2.5 rounded-full bg-warning/60" aria-hidden />
          <span className="size-2.5 rounded-full bg-success/60" aria-hidden />
          <div className="mx-auto flex items-center gap-1.5 rounded-md bg-muted px-3 py-1 text-2xs text-muted-foreground">
            <Lock className="size-3" aria-hidden />
            app.brain.pipadacapital.com
          </div>
        </div>

        {/* dashboard body */}
        <div className="p-4 text-left sm:p-5">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold tracking-tight">Revenue truth</p>
              <p className="text-2xs text-muted-foreground">Last 30 days · reconciled ledger</p>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-success-subtle px-2 py-0.5 text-2xs font-medium text-success-subtle-foreground">
              <span className="size-1.5 rounded-full bg-success" aria-hidden />
              Fresh · 2m ago
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <MockMetric label="Net revenue" value="₹1.74Cr" delta="+12.4%" confidence="High" />
            <MockMetric label="Identified visitors" value="48,209" delta="+8.1%" confidence="High" />
            <MockMetric
              label="Attribution confidence"
              value="B+"
              delta="Deterministic"
              confidence="Modelled"
            />
          </div>

          {/* mini chart */}
          <div className="mt-4 rounded-lg border border-border bg-surface/60 p-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-xs font-medium text-muted-foreground">Revenue by channel</p>
              <p className="text-2xs text-muted-foreground">tabular · minor units</p>
            </div>
            <MockChart />
          </div>
        </div>
      </div>
    </div>
  );
}

function MockMetric({
  label,
  value,
  delta,
  confidence,
}: {
  label: string;
  value: string;
  delta: string;
  confidence: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface/60 p-3">
      <p className="text-2xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums tracking-tight">{value}</p>
      <div className="mt-1.5 flex items-center gap-1.5">
        <span className="text-2xs font-medium text-success">{delta}</span>
        <span className="text-2xs text-muted-foreground">· {confidence}</span>
      </div>
    </div>
  );
}

// Static, deterministic bar heights — decorative, no data fabrication implied.
const MOCK_BARS = [
  { h: 62, c: 'bg-chart-1' },
  { h: 88, c: 'bg-chart-2' },
  { h: 44, c: 'bg-chart-3' },
  { h: 74, c: 'bg-chart-6' },
  { h: 36, c: 'bg-chart-5' },
  { h: 58, c: 'bg-chart-4' },
  { h: 80, c: 'bg-chart-1' },
  { h: 50, c: 'bg-chart-2' },
];

function MockChart() {
  return (
    <div className="flex h-24 items-end gap-2">
      {MOCK_BARS.map((b, i) => (
        <div
          key={i}
          className={`${b.c} flex-1 rounded-sm opacity-80`}
          style={{ height: `${b.h}%` }}
          aria-hidden
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------- ethos */

const ETHOS = [
  {
    step: '01',
    title: 'Capture Truth',
    body: 'Every pixel event, connector payload, and order lands in an append-only Bronze layer — the single source of truth. Nothing is dropped, everything is replayable.',
  },
  {
    step: '02',
    title: 'Build Trust',
    body: 'Identity is resolved, journeys reconstructed, and revenue reconciled deterministically. Every number carries its freshness and confidence.',
  },
  {
    step: '03',
    title: 'Enable Decisions',
    body: 'With a foundation you can audit, Brain surfaces attribution, retention, and recommendations you can actually stake a budget on.',
  },
];

function Ethos() {
  return (
    <section className="border-b border-border bg-surface">
      <div className="container grid gap-6 py-20 md:grid-cols-3">
        {ETHOS.map((e) => (
          <div key={e.step} className="flex flex-col gap-3">
            <span className="text-xs font-semibold tabular-nums text-primary">{e.step}</span>
            <h2 className="text-lg font-semibold tracking-tight">{e.title}</h2>
            <p className="text-sm text-muted-foreground">{e.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------ capabilities */

const CAPABILITIES = [
  {
    icon: Fingerprint,
    title: 'Identity resolution',
    body: 'Stitch anonymous visitors to known customers across devices and sessions — deterministic first, probabilistic only under review.',
  },
  {
    icon: Route,
    title: 'Journey reconstruction',
    body: 'Rebuild the full path from first touch to conversion, so attribution rests on real journeys — not last-click guesses.',
  },
  {
    icon: Coins,
    title: 'Revenue truth',
    body: 'Reconcile orders, refunds, COD, and shipping into one ledger. Money is exact minor units — never a blended float.',
  },
  {
    icon: Target,
    title: 'Attribution',
    body: 'Multiple models — from position-based to data-driven Markov — that learn channel weights from your own corpus.',
  },
  {
    icon: Gauge,
    title: 'Data quality',
    body: 'Freshness and confidence surfaced on every panel. When data is missing, Brain tells you why — never a fabricated zero.',
  },
  {
    icon: Sparkles,
    title: 'Decision intelligence',
    body: 'Segments, retention signals, and recommendations that unlock progressively as your data foundation matures.',
  },
];

function Capabilities() {
  return (
    <section id="capabilities" className="scroll-mt-16 border-b border-border">
      <div className="container py-20">
        <div className="max-w-2xl">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            One foundation, every commerce question
          </h2>
          <p className="mt-3 text-md text-muted-foreground">
            Brain covers the full stack — from the pixel on your storefront to the decision on
            your desk — so insight always traces back to auditable truth.
          </p>
        </div>

        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {CAPABILITIES.map((c) => (
            <div
              key={c.title}
              className="rounded-lg border border-border bg-card p-5 shadow-sm transition-colors hover:border-primary/30"
            >
              <span className="flex size-9 items-center justify-center rounded-md bg-secondary text-primary">
                <c.icon className="size-5" />
              </span>
              <h3 className="mt-4 text-base font-semibold tracking-tight">{c.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{c.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- pipeline */

const PIPELINE = [
  {
    icon: Database,
    label: 'Bronze — Capture',
    body: 'Append-only landing for every raw event and connector payload. The immutable source of truth.',
  },
  {
    icon: GitBranch,
    label: 'Silver — Canonicalize',
    body: 'Dedup, validate, and resolve entities into a clean spine of customers, orders, and journeys.',
  },
  {
    icon: ShieldCheck,
    label: 'Gold — Serve',
    body: 'Reconciled marts for revenue, attribution, and retention — served fast, with confidence attached.',
  },
];

function Pipeline() {
  return (
    <section id="pipeline" className="scroll-mt-16 border-b border-border bg-surface">
      <div className="container py-20">
        <div className="max-w-2xl">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            A medallion you can audit
          </h2>
          <p className="mt-3 text-md text-muted-foreground">
            Data flows through three layers of increasing trust. Every metric can be replayed,
            backfilled, and traced back to the raw event that produced it.
          </p>
        </div>

        <div className="mt-12 grid gap-4 md:grid-cols-3">
          {PIPELINE.map((p, i) => (
            <div
              key={p.label}
              className="relative rounded-lg border border-border bg-card p-5 shadow-sm"
            >
              <span className="flex size-9 items-center justify-center rounded-md bg-primary/10 text-primary">
                <p.icon className="size-5" />
              </span>
              <h3 className="mt-4 text-base font-semibold tracking-tight">{p.label}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{p.body}</p>
              {i < PIPELINE.length - 1 && (
                <ArrowRight
                  className="absolute -right-3 top-1/2 hidden size-5 -translate-y-1/2 text-muted-foreground md:block"
                  aria-hidden
                />
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- principles */

const PRINCIPLES = [
  'Data foundation comes before dashboards',
  'No empty charts as a success state',
  'No event loss, ever',
  'Deterministic first, probabilistic under review',
  'Revenue truth over platform truth',
  'Confidence before decisions',
];

function Principles() {
  return (
    <section id="principles" className="scroll-mt-16 border-b border-border">
      <div className="container py-20">
        <div className="max-w-2xl">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Trust is the product
          </h2>
          <p className="mt-3 text-md text-muted-foreground">
            These aren&apos;t taglines — they&apos;re the rules the system is built to enforce.
          </p>
        </div>

        <ul className="mt-10 grid gap-x-8 gap-y-4 sm:grid-cols-2">
          {PRINCIPLES.map((p) => (
            <li key={p} className="flex items-start gap-3 text-sm">
              <Lock className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
              <span>{p}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------- closing cta */

function ClosingCta() {
  return (
    <section className="border-b border-border bg-surface">
      <div className="container flex flex-col items-center gap-6 py-24 text-center">
        <h2 className="max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">
          Stop guessing. Start deciding.
        </h2>
        <p className="max-w-md text-md text-muted-foreground">
          Connect your storefront in minutes and watch a trustworthy data foundation build
          itself — one truthful event at a time.
        </p>
        <Button asChild size="lg">
          <Link href="/register">
            Get started
            <ArrowRight />
          </Link>
        </Button>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ footer */

function SiteFooter() {
  return (
    <footer className="border-t border-border">
      <div className="container flex flex-col items-center justify-between gap-4 py-8 text-xs text-muted-foreground sm:flex-row">
        <div className="flex items-center gap-2">
          <span className="flex size-5 items-center justify-center rounded bg-primary text-primary-foreground">
            <Sparkles className="size-3" />
          </span>
          <span>Brain — the AI-native commerce OS</span>
        </div>
        <div className="flex items-center gap-5">
          <Link href="/login" className="transition-colors hover:text-foreground">
            Sign in
          </Link>
          <Link href="/register" className="transition-colors hover:text-foreground">
            Get started
          </Link>
        </div>
      </div>
    </footer>
  );
}
