import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Edge auth guard. Protected route groups (dashboard, settings, onboarding) require
 * the httpOnly `brain_session` cookie. Without it, the request is bounced to /login
 * BEFORE the shell renders — so an unauthenticated visit never fires the dashboard
 * API calls that would otherwise 401 and flood the console.
 *
 * Cookie *presence* is a cheap gate (covers "not logged in"). A present-but-expired
 * cookie still reaches the page; the client-side RequireSession guard handles that
 * case by redirecting to /login when /me returns 401.
 *
 * Onboarding routing is status-driven (onboarding_status enum from BFF), not
 * localStorage. Resume-after-crash lands on the correct step via server-side status.
 *
 * The ghost /invite step has been REMOVED (MA-10). Onboarding now has 4 steps:
 *   Step 1: /workspace/new
 *   Step 2: /brand/new
 *   Step 3: /onboarding/integrations
 *   Step 4: /onboarding/done
 */
const SESSION_COOKIE = 'brain_session';

const PROTECTED_PREFIXES = [
  '/dashboard',
  '/settings',
  '/workspace',
  '/brand',
  '/onboarding',
  '/select-org',
];

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  const isProtected = PROTECTED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
  if (!isProtected) return NextResponse.next();

  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE)?.value);
  if (hasSession) return NextResponse.next();

  const loginUrl = new URL('/login', request.url);
  loginUrl.searchParams.set('next', pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Run on everything except Next internals and static assets.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
};
