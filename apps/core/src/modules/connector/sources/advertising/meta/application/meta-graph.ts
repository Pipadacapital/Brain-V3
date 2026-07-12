/**
 * meta-graph.ts — shared Meta Graph API read helpers for the connect commands.
 *
 * Extracted from HandleMetaOAuthCallbackCommand so the system-user-token connect path
 * (ConnectMetaWithSystemUserTokenCommand) reuses the EXACT same ad-account resolution the
 * OAuth callback uses — one place decides what an "accessible ad account" is.
 *
 * SEC-AD-M1: the access token ALWAYS rides the Authorization header, never a URL query
 * string (URLs land in reverse-proxy/ALB/CDN access logs). I-S09: tokens never logged.
 */
import { META_GRAPH_API_VERSION } from './commands/InitiateMetaOAuthCommand.js';

/** One resolved Meta ad account: `act_<id>` + the human name (null when Meta omits it). */
export interface MetaAdAccount {
  id: string;
  name: string | null;
}

/**
 * Resolve ALL accessible ad accounts via /me/adaccounts (Gap B), each with its human name.
 * Returns e.g. [{ id: 'act_123', name: 'Acme Store' }, …]. `name` is null when Meta omits it.
 * Returns empty array on any failure — callers fall back to a single __default__ instance.
 */
export async function resolveAllMetaAdAccounts(accessToken: string): Promise<MetaAdAccount[]> {
  try {
    // `name` is requested so the UI can label each account sub-card (not just act_<id>).
    const response = await fetch(
      `https://graph.facebook.com/${META_GRAPH_API_VERSION}/me/adaccounts?fields=account_id,name`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) return [];
    const data = (await response.json()) as {
      data?: Array<{ account_id?: string; id?: string; name?: string }>;
    };
    return (data.data ?? [])
      .map((entry) => {
        const id = entry.id ?? (entry.account_id ? `act_${entry.account_id}` : null);
        return id ? { id, name: entry.name ?? null } : null;
      })
      .filter((e): e is MetaAdAccount => e !== null);
  } catch {
    return [];
  }
}

/**
 * Validate a Meta access token by fetching /me (the cheapest authenticated Graph read).
 * Returns true iff Meta accepts the token. Used by the system-user-token connect path —
 * a pasted token has no OAuth handshake to prove it, so this call IS the validation.
 */
export async function validateMetaAccessToken(accessToken: string): Promise<boolean> {
  try {
    const response = await fetch(
      `https://graph.facebook.com/${META_GRAPH_API_VERSION}/me?fields=id`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) return false;
    const data = (await response.json()) as { id?: string };
    return typeof data.id === 'string' && data.id.length > 0;
  } catch {
    return false;
  }
}

/**
 * Fetch ONE ad account by id (accepts `act_123` or bare digits) to prove the token can
 * reach it. Returns the normalized account (+ name) or null when inaccessible/unknown.
 */
export async function fetchMetaAdAccount(
  accessToken: string,
  adAccountId: string,
): Promise<MetaAdAccount | null> {
  const normalized = adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`;
  try {
    const response = await fetch(
      `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${normalized}?fields=account_id,name`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) return null;
    const data = (await response.json()) as { account_id?: string; id?: string; name?: string };
    const id = data.id ?? (data.account_id ? `act_${data.account_id}` : normalized);
    return { id, name: data.name ?? null };
  } catch {
    return null;
  }
}
