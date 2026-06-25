import Link from 'next/link';
import { Plug, Zap, Users, ShieldCheck, Archive, ChevronRight } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';

export const metadata = { title: 'Settings — Brain' };

const settingsItems = [
  {
    href: '/settings/connectors',
    title: 'Data Connectors',
    description: 'Connect Shopify and other data sources.',
    icon: Plug,
  },
  {
    href: '/settings/pixel',
    title: 'Brain Pixel',
    description: 'Install and verify the Brain tracking pixel.',
    icon: Zap,
  },
  {
    href: '/settings/members',
    title: 'Team Members',
    description: 'Invite and manage your team.',
    icon: Users,
  },
  {
    href: '/settings/consent',
    title: 'Consent & Compliance',
    description: 'Consent coverage, the marketing suppression count, the 9–9 IST send window, and the can_contact() gate.',
    icon: ShieldCheck,
  },
  {
    href: '/settings/archived-brands',
    title: 'Archived Brands',
    description: 'View archived brands and restore one to bring it back to the switcher.',
    icon: Archive,
  },
];

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Manage your workspace configuration — data sources, tracking, your team, and compliance."
      />
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {settingsItems.map(({ href, title, description, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className="group rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Card className="h-full transition-colors hover:border-primary/50">
              <CardContent className="flex items-start gap-3 p-5">
                <span className="flex size-9 flex-shrink-0 items-center justify-center rounded-md border border-border bg-muted/60 text-muted-foreground transition-colors group-hover:border-primary/40 group-hover:text-primary">
                  <Icon className="size-4" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="text-base font-semibold tracking-tight text-foreground">{title}</h2>
                    <ChevronRight
                      className="size-4 flex-shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5 group-hover:text-primary"
                      aria-hidden="true"
                    />
                  </div>
                  <p className="text-sm text-muted-foreground">{description}</p>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
