import Link from 'next/link';
import { Plug, Zap, Users, ShieldCheck } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

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
];

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Settings</h1>
        <p className="text-muted-foreground mt-1">
          Manage your workspace configuration.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {settingsItems.map(({ href, title, description, icon: Icon }) => (
          <Link key={href} href={href} className="group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg">
            <Card className="h-full hover:border-primary/50 transition-colors">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Icon className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" aria-hidden="true" />
                  {title}
                </CardTitle>
                <CardDescription>{description}</CardDescription>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
