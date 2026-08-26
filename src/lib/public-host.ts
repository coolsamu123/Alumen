// Single source of truth for "is this request coming from an external host?"
// and "did the middleware accept the external client's Basic Auth?".
// Used by the root layout, the admin layout, and API route guards so the
// rule stays in sync.
//
// Default matches Cloudflare quick-tunnel domains. Override with
// PUBLIC_HOSTS=foo.com,bar.com (comma-separated substring match).

export function isPublicHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const patterns = (process.env.PUBLIC_HOSTS || 'trycloudflare.com')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  const h = host.toLowerCase();
  return patterns.some(p => h.includes(p));
}

// Stamped onto the request headers by `src/middleware.ts` after a successful
// Basic Auth check. Layout/route handlers read it to decide whether an
// external client has earned full-UI / write-API access.
export const AUTHED_HEADER = 'x-strom-authed';

interface ReadableHeaders {
  get(name: string): string | null;
}

/**
 * True iff the request is from an external host AND the middleware accepted
 * its credentials. Local requests are NEVER "external authed" (they don't
 * need auth in the first place — use !isPublicHost for that case).
 */
export function isAuthedExternal(headers: ReadableHeaders): boolean {
  if (!isPublicHost(headers.get('host'))) return false;
  return headers.get(AUTHED_HEADER) === '1';
}

/**
 * True iff the request is from an external host without valid auth. This is
 * the "treat as anonymous public visitor" case — hide write features, redirect
 * away from protected views, restrict heavy API actions.
 */
export function isAnonymousExternal(headers: ReadableHeaders): boolean {
  if (!isPublicHost(headers.get('host'))) return false;
  return headers.get(AUTHED_HEADER) !== '1';
}
