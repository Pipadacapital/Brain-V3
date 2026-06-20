/**
 * Auth layout — centered card, no navigation.
 * Routes: /login, /register, /forgot-password, /reset-password, /verify-email
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Brain</h1>
          <p className="text-sm text-muted-foreground mt-1">The commerce OS that earns your trust before it shows you answers</p>
        </div>
        {children}
      </div>
    </div>
  );
}
