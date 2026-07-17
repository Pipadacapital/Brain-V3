/**
 * Dashboard shell layout — sidebar navigation + main content area.
 *
 * IA: a GROUPED sidebar organised into labelled sections (Overview, Customers, Marketing,
 * Behaviour & Journeys, Revenue & Orders, Data & Ops, Settings). Every important center is
 * surfaced here — the deep tools previously linked only from within tabs (insights, ask,
 * recommendations, ml, attribution, revenue/orders/finance & fulfilment analytics, data
 * health/quality, connectors, pixel, consent, members, billing) now appear under their
 * natural section. Detail/drill-down routes (customers/[id], products/[id]) stay sub-routes.
 *
 * feat-multi-brand (B4): BrandSwitcher is mounted in the sidebar below the logo,
 * above the nav links. It is always rendered even for single-brand users (MA-15).
 *
 * A11y: nav landmark with aria-label; section headers use aria-hidden (decorative
 * labels — the nav has the accessible name). Links have visible focus rings.
 * Disabled/coming-soon items use aria-disabled="true" + cursor-not-allowed.
 */
'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Users,
  Megaphone,
  Target,
  Compass,
  MousePointerClick,
  Search,
  Footprints,
  SlidersHorizontal,
  Database,
  Repeat,
  HeartCrack,
  Fingerprint,
  Package,
  Activity,
  Settings,
  ShoppingCart,
  ShoppingBag,
  Lock,
  Lightbulb,
  Sparkles,
  Wand2,
  GitMerge,
  Split,
  TrendingUp,
  Filter,
  Heart,
  MessageSquare,
  IndianRupee,
  Receipt,
  Percent,
  Landmark,
  Truck,
  PackageCheck,
  MapPin,
  HeartPulse,
  ShieldCheck,
  Boxes,
  Plug,
  ScanLine,
  FileCheck,
  UserCog,
  CreditCard,
  Route,
  Coins,
  Ruler,
} from 'lucide-react';
import { UserMenu } from '@/components/dashboard/user-menu';
import { RequireSession } from '@/components/dashboard/require-session';
import { BrandSwitcher } from '@/components/dashboard/brand-switcher';
import { VerifyEmailBanner } from '@/components/dashboard/verify-email-banner';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useEntitlements, centerEntitlement } from '@/lib/hooks/use-entitlements';

interface NavItem {
  href?: string;
  label: string;
  icon: React.ElementType;
  comingSoon?: boolean;
  disabled?: boolean;
  /**
   * Progressive unlock (P2): the entitlement center key this item gates on. When the brand's data
   * foundation can't support it yet, the item locks (disabled + the unlock hint) so the user never
   * navigates into an empty/not-ready center. Absent → always available.
   */
  centerKey?: string;
}

interface NavSection {
  /** Section header (a decorative, aria-hidden label). null → no header (the top/Overview group). */
  title: string | null;
  items: NavItem[];
}

/**
 * Grouped IA — every important center is reachable from the sidebar, organised into labelled
 * sections so the (now ~40-item) nav stays scannable. Previously-hidden deep tools (insights, ask,
 * recommendations, ml, attribution, revenue/orders/finance & fulfilment analytics, data
 * health/quality, connectors, pixel, consent, members, billing) are surfaced here under their
 * natural section instead of only being linked from within tabs.
 *
 * Progressive-unlock gating is PRESERVED via item.centerKey: a gated item locks (never navigates
 * into an empty/not-ready center) until the brand's data foundation supports it.
 */
const NAV_SECTIONS: NavSection[] = [
  {
    title: null,
    items: [
      { href: '/home', label: 'Home', icon: LayoutDashboard },
      { href: '/insights', label: 'Insights', icon: Lightbulb },
      { href: '/ask', label: 'Ask Brain', icon: Sparkles },
      { href: '/recommendations', label: 'Recommendations', icon: Wand2 },
    ],
  },
  {
    title: 'Customers',
    items: [
      { href: '/customers', label: 'Customers', icon: Users, centerKey: 'identity' },
      { href: '/segments', label: 'Segments', icon: SlidersHorizontal, centerKey: 'identity' },
      { href: '/identity', label: 'Identity', icon: Fingerprint, centerKey: 'identity' },
      { href: '/identity/merge-review', label: 'Merge Review', icon: GitMerge, centerKey: 'identity' },
      { href: '/retention', label: 'Retention', icon: Repeat },
      { href: '/retention/churn', label: 'Churn Risk', icon: HeartCrack, centerKey: 'identity' },
    ],
  },
  {
    title: 'Marketing',
    items: [
      { href: '/marketing', label: 'Marketing', icon: Megaphone, centerKey: 'attribution' },
      { href: '/marketing/campaigns', label: 'Campaigns', icon: Target, centerKey: 'attribution' },
      { href: '/marketing/utm', label: 'UTM Sources', icon: Compass, centerKey: 'attribution' },
      { href: '/analytics/attribution', label: 'Attribution', icon: Split, centerKey: 'attribution' },
      { href: '/analytics/spend', label: 'Ad Spend & ROAS', icon: TrendingUp, centerKey: 'attribution' },
    ],
  },
  {
    title: 'Behaviour & Journeys',
    items: [
      { href: '/behaviour', label: 'Behaviour', icon: MousePointerClick },
      { href: '/journeys', label: 'Journeys', icon: Footprints, centerKey: 'journey' },
      { href: '/journeys/explorer', label: 'Journey Explorer', icon: Route, centerKey: 'journey' },
      { href: '/analytics/products', label: 'Products', icon: Package },
      { href: '/analytics/search', label: 'Search & Forms', icon: Search },
      { href: '/analytics/checkout', label: 'Checkout', icon: ShoppingCart },
      { href: '/cart-abandonment', label: 'Cart Abandonment', icon: ShoppingBag },
      { href: '/analytics/funnel', label: 'Funnel', icon: Filter },
      { href: '/analytics/engagement', label: 'Engagement', icon: Heart },
      { href: '/analytics/conversion-feedback', label: 'Conversion Feedback', icon: MessageSquare },
    ],
  },
  {
    title: 'Revenue & Orders',
    items: [
      { href: '/analytics/revenue', label: 'Revenue', icon: IndianRupee },
      { href: '/analytics/orders', label: 'Orders', icon: Receipt },
      { href: '/analytics/margin', label: 'Margin & Costs', icon: Percent },
      { href: '/analytics/profit', label: 'Profit & Margin', icon: Coins },
      { href: '/analytics/settlements', label: 'Settlements', icon: Landmark },
      { href: '/analytics/cod-rto', label: 'CoD / RTO', icon: Truck },
      { href: '/analytics/order-status', label: 'Order Status', icon: PackageCheck },
      { href: '/analytics/logistics', label: 'Logistics', icon: MapPin },
    ],
  },
  {
    title: 'Data & Ops',
    items: [
      { href: '/data', label: 'Data', icon: Database },
      { href: '/data/health', label: 'Data Health', icon: HeartPulse },
      { href: '/data/quality', label: 'Data Quality', icon: ShieldCheck },
      { href: '/operations', label: 'Operations', icon: Activity },
      { href: '/ml', label: 'Models', icon: Boxes },
      { href: '/metrics', label: 'Metrics Catalog', icon: Ruler },
    ],
  },
  {
    title: 'Settings',
    items: [
      { href: '/settings', label: 'Settings', icon: Settings },
      { href: '/settings/connectors', label: 'Integrations', icon: Plug },
      { href: '/settings/pixel', label: 'Brain Pixel', icon: ScanLine },
      { href: '/settings/consent', label: 'Consent', icon: FileCheck },
      { href: '/settings/members', label: 'Members', icon: UserCog },
      { href: '/billing', label: 'Billing', icon: CreditCard },
    ],
  },
];

const NAV_LINK_BASE =
  'group flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

function NavLink({ item }: { item: NavItem }) {
  const pathname = usePathname();
  const { data: entitlements } = useEntitlements();

  // Progressive unlock (P2): a gated center locks until its data foundation supports it.
  const ent = item.centerKey ? centerEntitlement(entitlements?.centers, item.centerKey) : null;
  const locked = ent !== null && !ent.eligible;

  const isActive = item.href
    ? pathname === item.href || pathname.startsWith(`${item.href}/`)
    : false;

  // Locked-by-readiness: render disabled with a lock + the unlock hint (never navigate into an
  // empty/not-ready center — "the user should never reach empty or misleading experiences").
  if (locked) {
    return (
      <div
        className={cn(NAV_LINK_BASE, 'text-muted-foreground/45 cursor-not-allowed select-none hover:bg-transparent')}
        aria-disabled="true"
        role="link"
        tabIndex={-1}
        title={ent?.unlock_hint ?? undefined}
        aria-label={`${item.label} — locked. ${ent?.unlock_hint ?? 'Connect your data sources — this unlocks automatically once Brain has enough data.'}`}
      >
        <item.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="truncate">{item.label}</span>
        <Lock className="ml-auto h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      </div>
    );
  }

  if (item.disabled || !item.href) {
    return (
      <div
        className={cn(NAV_LINK_BASE, 'text-muted-foreground/45 cursor-not-allowed select-none hover:bg-transparent')}
        aria-disabled="true"
        role="link"
        tabIndex={-1}
        aria-label={`${item.label} — coming soon`}
      >
        <item.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="truncate">{item.label}</span>
        {item.comingSoon && (
          <Badge
            variant="secondary"
            className="ml-auto text-[10px] px-1.5 py-0 h-4"
            aria-label="Coming soon"
          >
            Soon
          </Badge>
        )}
      </div>
    );
  }

  return (
    <Link
      href={item.href}
      className={cn(
        NAV_LINK_BASE,
        isActive
          ? 'bg-primary/10 text-primary'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
      aria-current={isActive ? 'page' : undefined}
    >
      <item.icon
        className={cn('h-4 w-4 shrink-0 transition-colors', isActive ? 'text-primary' : 'text-muted-foreground/70 group-hover:text-foreground')}
        aria-hidden="true"
      />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-background">
      {/* Sidebar */}
      <aside
        className="sticky top-0 h-screen w-60 shrink-0 border-r border-border bg-surface flex flex-col"
        aria-label="Main navigation"
      >
        <div className="flex h-14 items-center gap-2 px-5">
          <span
            className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-sm font-bold text-primary-foreground"
            aria-hidden="true"
          >
            B
          </span>
          <span className="text-base font-semibold tracking-tight text-foreground">Brain</span>
        </div>

        {/* B4: Brand switcher — always rendered (MA-15), org-scoped via brand-summary (MA-14) */}
        <BrandSwitcher />

        <nav className="flex-1 overflow-y-auto px-3 py-4" aria-label="Navigation links">
          {NAV_SECTIONS.map((section, i) => (
            <div key={section.title ?? 'overview'} className={cn(i > 0 && 'mt-4')}>
              {section.title && (
                // Full text-muted-foreground (4.83:1 on white): the previous /60 opacity landed at
                // 2.32:1, a serious WCAG AA color-contrast violation flagged by the e2e axe gate.
                <p
                  className="px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
                  aria-hidden="true"
                >
                  {section.title}
                </p>
              )}
              <ul className="space-y-0.5" role="list">
                {section.items.map((item) => (
                  <li key={item.label}>
                    <NavLink item={item} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <UserMenu />
      </aside>

      {/* Main content */}
      <div className="flex flex-1 flex-col min-w-0">
        {/* Soft-gate UX (feat-onboarding-ux): dismissible verify-email banner. The actual
            block on sensitive actions is enforced server-side — this is guidance only. */}
        <VerifyEmailBanner />
        <main className="flex-1 overflow-auto">
          <div className="mx-auto w-full max-w-7xl px-6 py-8 lg:px-8">
            <RequireSession>{children}</RequireSession>
          </div>
        </main>
      </div>
    </div>
  );
}
