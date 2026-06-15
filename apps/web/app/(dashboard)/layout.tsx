/**
 * Dashboard shell layout — sidebar navigation + main content area.
 * Routes: /dashboard, /settings/*
 */
import Link from 'next/link';
import { LayoutDashboard, Plug, Zap, Users, Settings } from 'lucide-react';

const navItems = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/settings/connectors', label: 'Connectors', icon: Plug },
  { href: '/settings/pixel', label: 'Brain Pixel', icon: Zap },
  { href: '/settings/members', label: 'Members', icon: Users },
  { href: '/settings', label: 'Settings', icon: Settings },
];

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
        <nav className="flex-1 py-4 px-3" aria-label="Navigation links">
          <ul className="space-y-1" role="list">
            {navItems.map(({ href, label, icon: Icon }) => (
              <li key={href}>
                <Link
                  href={href}
                  className="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  {label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        <main className="flex-1 p-8 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
