import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

/**
 * Web-side session clear (resilience fallback).
 *
 * The BFF (core) owns real session revocation, and it is the BFF's logout response
 * that normally clears the httpOnly `brain_session` cookie. But that cookie is
 * httpOnly — client JS cannot delete it — so when the BFF is unreachable (or the
 * revoke errors) the cookie survives and the app still looks logged-in ("Go to
 * app" on the home page, protected routes still gated open).
 *
 * This handler runs on the web app's own origin, so it CAN expire those cookies.
 * The logout flow calls the BFF revoke first (best-effort) and then always hits
 * this route, guaranteeing the local session is dropped regardless of BFF health.
 * Attributes mirror how core sets them (path '/').
 */
export async function POST() {
  const jar = await cookies();
  jar.delete({ name: 'brain_session', path: '/' });
  jar.delete({ name: 'brain_csrf', path: '/' });
  return NextResponse.json({ ok: true });
}
