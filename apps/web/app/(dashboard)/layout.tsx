/**
 * Dashboard shell layout — sidebar navigation + main content area.
 * Routes: /dashboard, /analytics/*, /settings/*
 *
 * Sidebar sections (Phase 1):
 *   OVERVIEW  → Dashboard
 *   ANALYTICS → Revenue, Orders (soon), Settlements (soon)
 *   DATA      → Connectors
 *   SETTINGS  → Brain Pixel, Members, Settings
 *
 * feat-multi-brand (B4): BrandSwitcher is mounted in the sidebar below the logo,
 * above the nav links. It is always rendered even for single-brand users (MA-15).
 *
 * A11y: nav landmark with aria-label; section headers use aria-hidden (decorative
 * labels — the nav has the accessible name). Links have visible focus rings.
 * Disabled/coming-soon items use aria-disabled="true" + cursor-not-allowed.
 */
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  TrendingUp,
  ShoppingCart,
  Megaphone,
  Receipt,
  Truck,
  Layers,
  Footprints,
  Target,
  Send,
  Plug,
  Activity,
  Zap,
  Users,
  Settings,
  ShieldCheck,
  Gauge,
  BrainCircuit,
  Fingerprint,
  Lock,
} from 'lucide-react';
import { UserMenu } from '@/components/dashboard/user-menu';
import { RequireSession } from '@/components/dashboard/require-session';
import { BrandSwitcher } from '@/components/dashboard/brand-switcher';
import { VerifyEmailBanner } from '@/components/dashboard/verify-email-banner';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface NavItem {
  href?: string;
  label: string;
  icon: React.ElementType;
  comingSoon?: boolean;
  disabled?: boolean;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

const NAV_SECTIONS: NavSection[] = [
  {
    title: 'OVERVIEW',
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { href: '/ask', label: 'Ask Brain', icon: BrainCircuit },
    ],
  },
  {
    title: 'ANALYTICS',
    items: [
      { href: '/analytics/revenue', label: 'Revenue', icon: TrendingUp },
      { href: '/analytics/orders', label: 'Orders', icon: ShoppingCart },
      { href: '/analytics/spend', label: 'Ad Spend', icon: Megaphone },
      { href: '/analytics/settlements', label: 'Settlements', icon: Receipt },
      { href: '/analytics/cod-rto', label: 'CoD / RTO', icon: Truck },
      { href: '/analytics/order-status', label: 'Order Status', icon: Layers },
      { href: '/analytics/journey', label: 'Journey', icon: Footprints },
      { href: '/analytics/attribution', label: 'Attribution', icon: Target },
      { href: '/analytics/conversion-feedback', label: 'Conversion Feedback', icon: Send },
    ],
  },
  {
    title: 'IDENTITY',
    items: [
      { href: '/identity/customer-360', label: 'Customer 360', icon: Fingerprint },
      { href: '/identity/pii-vault', label: 'PII Vault', icon: Lock },
    ],
  },
  {
    title: 'DATA',
    items: [
      { href: '/settings/connectors', label: 'Connectors', icon: Plug },
      { href: '/data/health', label: 'Data Health', icon: Activity },
      { href: '/data/quality', label: 'Data Quality', icon: Gauge },
    ],
  },
  {
    title: 'SETTINGS',
    items: [
      { href: '/settings/pixel', label: 'Brain Pixel', icon: Zap },
      { href: '/settings/members', label: 'Members', icon: Users },
      { href: '/settings/consent', label: 'Consent & Compliance', icon: ShieldCheck },
      { href: '/settings', label: 'Settings', icon: Settings },
    ],
  },
];

function NavLink({ item }: { item: NavItem }) {
  const pathname = usePathname();

  const isActive = item.href ? (
    item.href === '/dashboard'
      ? pathname === '/dashboard'
      : pathname.startsWith(item.href)
  ) : false;

  if (item.disabled || !item.href) {
    return (
      <div
        className="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground/50 cursor-not-allowed select-none"
        aria-disabled="true"
        role="link"
        tabIndex={-1}
        aria-label={`${item.label} — coming soon`}
      >
        <item.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>{item.label}</span>
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
        'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
        isActive
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
      )}
      aria-current={isActive ? 'page' : undefined}
    >
      <item.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{item.label}</span>
    </Link>
  );
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-background">
      {/* Sidebar */}
      <aside
        className="w-60 shrink-0 border-r bg-card flex flex-col"
        aria-label="Main navigation"
      >
        <div className="px-6 py-5 border-b">
          <span className="text-lg font-bold text-foreground">Brain</span>
        </div>

        {/* B4: Brand switcher — always rendered (MA-15), org-scoped via brand-summary (MA-14) */}
        <BrandSwitcher />

        <nav className="flex-1 py-4 px-3 overflow-y-auto" aria-label="Navigation links">
          <ul className="space-y-5" role="list">
            {NAV_SECTIONS.map((section) => (
              <li key={section.title}>
                {/* Section header — decorative, aria-hidden */}
                <p
                  className="px-3 mb-1 text-[10px] font-semibold tracking-widest text-muted-foreground uppercase select-none"
                  aria-hidden="true"
                >
                  {section.title}
                </p>
                <ul className="space-y-0.5" role="list">
                  {section.items.map((item) => (
                    <li key={item.label}>
                      <NavLink item={item} />
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </nav>

        <UserMenu />
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Soft-gate UX (feat-onboarding-ux): dismissible verify-email banner. The actual
            block on sensitive actions is enforced server-side — this is guidance only. */}
        <VerifyEmailBanner />
        <main className="flex-1 p-8 overflow-auto">
          <RequireSession>{children}</RequireSession>
        </main>
      </div>
    </div>
  );
}
