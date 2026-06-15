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
      <body>
        <QueryProvider>
          {children}
          <Toaster />
        </QueryProvider>
      </body>
    </html>
  );
}
