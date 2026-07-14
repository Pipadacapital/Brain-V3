// prod go-live 2026-07-11: touch web so turbo --affected includes it in the CI image build (retry w/ TURBO_SCM_BASE fix).
// Next.js root layout. The web app talks ONLY to the `frontend-api` module in core
// (httpOnly cookie <-> short token; CSRF; view-model fan-out — ADR-011). Never the DB.
import type { Metadata } from 'next';
import './globals.css';
import { QueryProvider } from '@/components/providers/query-provider';
import { Toaster } from '@/components/ui/toaster';

export const metadata: Metadata = {
  title: 'Brain — Command Center',
  description: 'Brand intelligence platform',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      {/*
        suppressHydrationWarning: browser extensions (ColorZilla `cz-shortcut-listen`,
        Grammarly `data-gr-*`, etc.) inject attributes onto <body> before React
        hydrates, causing a benign attribute mismatch we cannot control. This flag
        suppresses the warning for THIS element's attributes only — real mismatches
        inside the tree still surface.
      */}
      <body suppressHydrationWarning>
        <QueryProvider>
          {children}
          <Toaster />
        </QueryProvider>
      </body>
    </html>
  );
}
