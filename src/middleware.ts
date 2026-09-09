// External-host session gate.
//
// Goal: on any host that matches PUBLIC_HOSTS (currently the EC2 hostname),
// protect admin pages, write endpoints, and the heavier batch APIs behind a
// real login (PLAN_USER_MANAGEMENT.md Fase 1) instead of the one shared
// Basic Auth password this replaces. Local requests (no PUBLIC_HOSTS match)
// bypass this middleware entirely — same UX as before, and still an open
// question for a later fase (§2.4).
//
// Flow:
//   - Local host                       → next() (no challenge).
//   - External host, public path       → next() (graph / timeline / detail /
//                                                 impact-read still work,
//                                                 login or not — public mode
//                                                 dies last, Fase 5).
//   - External host, protected path:
//       - No session cookie, or it fails signature/expiry verification
//                                       → redirect to /login (page) or 401
//                                         JSON (API).
//       - Valid session, role != admin → 403 (Admin/Drive Sync are
//                                         admin-only per the original ask).
//       - Valid admin session          → next(), injecting `x-strom-authed: 1`
//                                        so the layout unlocks the full UI —
//                                        same signal isAnonymousExternal reads
//                                        as before, just driven by a session
//                                        now instead of a Basic Auth header.
//
// This file runs on the Edge runtime — no better-sqlite3, no node:crypto.
// verifySessionToken() (src/lib/session.ts) only checks the cookie's
// signature/shape/expiry; it does NOT reread token_version/is_active from
// SQLite. That authoritative recheck happens in src/lib/auth.ts, used by
// route handlers that need to know a deactivated user is rejected
// immediately rather than only once its cookie naturally expires.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isPublicHost, AUTHED_HEADER } from '@/lib/public-host';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/session';

// Match-all-methods prefixes. Anything starting with these requires auth from
// an external client.
const PROTECTED_PREFIXES = [
  '/admin',
  '/api/admin',
  '/api/drive',
  '/api/goals',
  '/api/auto-discovery',
  '/api/analyze',
  '/api/prompts',
  '/api/projects/upload',
];

// Mixed-method endpoints: GETs are public-safe (used by the read-only views
// served from external hosts), but writes/expensive POSTs require auth.
const PROTECTED_BY_METHOD: Array<{ prefix: string; methods: string[] }> = [
  { prefix: '/api/impact', methods: ['POST', 'PUT', 'PATCH', 'DELETE'] },
  { prefix: '/api/projects', methods: ['POST', 'PUT', 'PATCH', 'DELETE'] },
  { prefix: '/api/services/mapping', methods: ['POST', 'PUT', 'PATCH', 'DELETE'] },
];

function pathStartsWith(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix + '/');
}

function isProtected(pathname: string, method: string): boolean {
  if (PROTECTED_PREFIXES.some(p => pathStartsWith(pathname, p))) return true;
  const m = method.toUpperCase();
  return PROTECTED_BY_METHOD.some(r => pathStartsWith(pathname, r.prefix) && r.methods.includes(m));
}

function unauthorizedJson(): NextResponse {
  return NextResponse.json(
    { error: 'Authentication required.' },
    { status: 401, headers: { 'Cache-Control': 'no-store' } }
  );
}

function forbiddenJson(): NextResponse {
  return NextResponse.json(
    { error: 'Admin role required.' },
    { status: 403, headers: { 'Cache-Control': 'no-store' } }
  );
}

function forbiddenPage(): NextResponse {
  return new NextResponse('Admin access required.\n', {
    status: 403,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function middleware(request: NextRequest) {
  const host = request.headers.get('host');
  if (!isPublicHost(host)) return NextResponse.next();

  const { pathname } = request.nextUrl;
  const method = request.method;
  const isApi = pathname.startsWith('/api/');

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionToken(token);
  const isAdmin = session?.role === 'admin';

  if (isProtected(pathname, method)) {
    if (!session) {
      if (isApi) return unauthorizedJson();
      const loginUrl = new URL('/login', request.url);
      loginUrl.searchParams.set('next', pathname);
      return NextResponse.redirect(loginUrl);
    }
    if (!isAdmin) {
      return isApi ? forbiddenJson() : forbiddenPage();
    }
  }

  if (session) {
    // Stamp a hint on the downstream request so the root layout / admin layout
    // can flip the UI into "full access" mode for this external session —
    // same signal as before, now driven by a verified session instead of a
    // Basic Auth header. Any authenticated role counts here: the protected-
    // path admin check above is the one that actually gates by role.
    const reqHeaders = new Headers(request.headers);
    reqHeaders.set(AUTHED_HEADER, '1');
    return NextResponse.next({ request: { headers: reqHeaders } });
  }

  return NextResponse.next();
}

// Skip static assets and Next internals — middleware shouldn't run for every
// CSS/font/image request.
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|fonts/|icon-|favicon\\.ico|.*\\.(?:png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf|css|js|map|txt)$).*)',
  ],
};
