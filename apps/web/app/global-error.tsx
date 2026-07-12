'use client';

/**
 * Global error boundary (AUD-IMPL-001) — the LAST-RESORT catch for a crash in the root layout
 * itself. It replaces the entire document, so it must render its own <html>/<body> and cannot
 * assume the app's CSS pipeline survived — styles are inline on purpose. Everything below the
 * root layout is handled by the styled route-group error.tsx boundaries instead.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          background: '#fafafa',
          color: '#18181b',
        }}
      >
        <div
          role="alert"
          style={{
            maxWidth: 420,
            padding: 24,
            border: '1px solid #e4e4e7',
            borderRadius: 8,
            background: '#ffffff',
          }}
        >
          <p style={{ margin: 0, fontWeight: 600 }}>Something went wrong.</p>
          <p style={{ marginTop: 8, fontSize: 14, color: '#52525b' }}>
            Your data is safe — this is a display problem, not a data problem. Try again, and if it
            keeps happening, contact support.
          </p>
          {error.digest && (
            <p style={{ marginTop: 8, fontSize: 12, color: '#71717a' }}>
              Support reference: <span style={{ fontFamily: 'monospace' }}>{error.digest}</span>
            </p>
          )}
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: 16,
              padding: '6px 14px',
              fontSize: 14,
              border: '1px solid #d4d4d8',
              borderRadius: 6,
              background: '#ffffff',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
