// Next.js root layout. The web app talks ONLY to the `frontend-api` module in core
// (httpOnly cookie ↔ short token; CSRF; view-model fan-out — ADR-011). Never the DB.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (<html lang="en"><body>{children}</body></html>);
}
