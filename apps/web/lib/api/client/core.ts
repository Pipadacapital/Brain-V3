/**
 * BFF API client — the web app talks ONLY to the frontend-api BFF.
 * Never the DB, never StarRocks, never Postgres directly.
 *
 * All calls go to /api/bff/* which maps to the frontend-api module in apps/core.
 * The BFF exchanges the httpOnly cookie for a short-lived access token on every call.
 *
 * Correlation ID (X-Request-Id) is forwarded on every request so the backend
 * can include it in the error response for UI display.
 */
// AUD-IMPL-006: extracted VERBATIM from the former 2,640-line apps/web/lib/api/client.ts
// (per-domain decomposition mirroring the backend CQ-1 split). Import from '@/lib/api/client'
// — the index re-exports this module's public surface unchanged.
import { z } from 'zod';

/** All BFF routes proxied through Next.js API routes → frontend-api module */
/** The { request_id, data } envelope the BFF wraps every read payload in (hoisted here by the
 *  AUD-IMPL-006 split — it was a file-local interface every domain section leaned on). */
export interface BffEnvelope<T> {
  request_id: string;
  data: T;
}

export const BFF_BASE = '/api/bff';

const CSRF_COOKIE = 'brain_csrf';
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function generateRequestId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

/** Read a non-httpOnly cookie value by name (browser only). */
function readCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]!) : undefined;
}

/**
 * Double-submit CSRF token. The server (GET /api/v1/bff/csrf) sets a JS-readable
 * `brain_csrf` cookie; we echo its value in the `x-csrf-token` header on every
 * state-changing request. Bootstraps the cookie on first use.
 */
export async function ensureCsrfToken(): Promise<string | undefined> {
  if (typeof document === 'undefined') return undefined; // SSR — no cookie jar
  let token = readCookie(CSRF_COOKIE);
  if (!token) {
    await fetch(`${BFF_BASE}/v1/bff/csrf`, { credentials: 'include' });
    token = readCookie(CSRF_COOKIE);
  }
  return token;
}

/**
 * Core fetch wrapper — adds correlation headers, handles error envelope,
 * surfaces request_id on errors for UI display.
 */
export async function bffFetch<T>(
  path: string,
  options: RequestInit & { idempotencyKey?: string } = {},
): Promise<T> {
  const requestId = generateRequestId();
  const method = (options.method ?? 'GET').toUpperCase();
  const isMutation = MUTATING.has(method);

  const buildHeaders = (csrfToken: string | undefined): Record<string, string> => ({
    // Only declare a JSON content-type when there is actually a body. A POST with
    // `Content-Type: application/json` and an empty body is rejected by Fastify's
    // body parser with a 400 (e.g. logout, session/refresh — no-body mutations).
    ...(options.body != null ? { 'Content-Type': 'application/json' } : {}),
    'X-Request-Id': requestId,
    ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
    ...(options.idempotencyKey
      ? { 'Idempotency-Key': options.idempotencyKey }
      : {}),
    ...(options.headers as Record<string, string> | undefined),
  });

  // Double-submit CSRF token on state-changing requests (server enforces it for
  // cookie-authenticated mutations). Exempt routes (login/register) ignore it.
  const csrfToken = isMutation ? await ensureCsrfToken() : undefined;

  let response = await fetch(`${BFF_BASE}${path}`, {
    ...options,
    headers: buildHeaders(csrfToken),
    credentials: 'include', // send httpOnly cookie
  });

  // The CSRF token is bound to the session (server-side). A token issued before
  // login (or before a session rotation) won't match — force-refresh a fresh,
  // session-bound token and retry the mutation ONCE.
  if (response.status === 403 && isMutation) {
    const peeked = await response
      .clone()
      .json()
      .catch(() => ({}) as { error?: { code?: string } });
    if (peeked?.error?.code === 'CSRF_MISMATCH') {
      await fetch(`${BFF_BASE}/v1/bff/csrf`, { credentials: 'include' });
      const fresh = readCookie(CSRF_COOKIE);
      response = await fetch(`${BFF_BASE}${path}`, {
        ...options,
        headers: buildHeaders(fresh),
        credentials: 'include',
      });
    }
  }

  if (!response.ok) {
    let errorBody: { request_id?: string; error?: { code?: string; message?: string } } = {};
    try {
      errorBody = await response.json();
    } catch {
      // non-JSON error body
    }
    // Session expired or invalid → log out and redirect to /login. The browser holds
    // only the (httpOnly) access cookie and no refresh token, so an expired access
    // token cannot be refreshed — the only correct outcome is to send the user back to
    // login. Excludes the login route's own bad-credentials 401 (INVALID_CREDENTIALS),
    // which must surface its error instead of redirecting.
    if (
      response.status === 401 &&
      errorBody?.error?.code !== 'INVALID_CREDENTIALS' &&
      typeof window !== 'undefined' &&
      window.location.pathname !== '/login'
    ) {
      window.location.href = '/login';
    }
    // Friendly fallback when the server sent no message — never surface a raw HTTP code.
    const message =
      errorBody?.error?.message ??
      (response.status >= 500
        ? 'Brain had a brief problem on our side. Your data is safe — please try again in a moment.'
        : 'Something went wrong. Please try again.');
    const reqId = errorBody?.request_id ?? requestId;
    const err = new BffApiError(message, response.status, reqId, errorBody?.error?.code);
    throw err;
  }

  if (response.status === 204) {
    return undefined as unknown as T;
  }

  return response.json() as Promise<T>;
}

export class BffApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly requestId: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'BffApiError';
  }

  /** True for server-side (5xx) failures — the user can't fix these; they should just retry/contact support. */
  get isServerError(): boolean {
    return this.status >= 500;
  }
}

/**
 * userFacingMessage — the ONE place that turns any thrown error into a clean, customer-safe string.
 *
 * Goals (don't leak internals, don't show request IDs in the message, never a raw "Internal server
 * error"): 4xx → the server's specific, actionable message (e.g. "Verify your email…"). 5xx / unknown
 * → a friendly, reassuring generic line. The request_id is NOT appended here — it is support context,
 * surfaced subtly by ErrorCard only for true server errors (see getSupportReference).
 */
export function userFacingMessage(error: unknown): string {
  if (error instanceof BffApiError) {
    if (error.isServerError || !error.message) {
      return 'Something went wrong on our end. Please try again in a moment.';
    }
    return error.message;
  }
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong. Please try again.';
}

/** The request id to cite in support — ONLY for server errors (4xx are self-explanatory; no id shown). */
export function getSupportReference(error: unknown): string | undefined {
  return error instanceof BffApiError && error.isServerError ? error.requestId : undefined;
}

/**
 * parseData — validate an unwrapped BFF envelope body against its Zod contract at the seam.
 *
 * On success returns the SAME data (no transform) → identical rendering + money formatting.
 * On drift (a renamed/removed/wrong-typed money or discriminant field) throws a CLEAR,
 * field-named BffApiError(code:'CONTRACT_DRIFT') HERE — never a deep `BigInt(undefined)`
 * white-screen inside a component. This is the runtime half of the single-source-of-truth
 * contract (the compile-time half is core's `satisfies z.infer<Schema>` in bff.routes.ts).
 */
export function parseData<S extends z.ZodTypeAny>(
  schema: S,
  env: { request_id: string; data: unknown },
): z.infer<S> {
  const r = schema.safeParse(env.data);
  if (!r.success) {
    const issue = r.error.issues[0];
    const path = issue?.path.join('.') || '<root>';
    throw new BffApiError(
      `BFF contract drift at ${path}: ${issue?.message ?? 'invalid response shape'}`,
      200,
      env.request_id,
      'CONTRACT_DRIFT',
    );
  }
  return r.data as z.infer<S>;
}
