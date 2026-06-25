/**
 * Auth layout — centered card, no navigation.
 * Routes: /login, /register, /forgot-password, /reset-password, /verify-email
 *
 * Calm, premium framing: a soft tinted canvas, a single brand mark, the trust
 * line, and the form card. One accent only; restrained type hierarchy.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-muted/30 px-4 py-12">
      {/* Subtle, calm backdrop wash — single accent at very low opacity, never decorative noise. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-72 bg-gradient-to-b from-primary/[0.06] to-transparent"
      />
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <span
            className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-primary text-lg font-bold text-primary-foreground shadow-sm"
            aria-hidden="true"
          >
            B
          </span>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">Brain</h1>
          <p className="mt-1.5 max-w-xs text-sm text-muted-foreground">
            The commerce OS that earns your trust before it shows you answers.
          </p>
        </div>
        {children}
      </div>
    </div>
  );
}
