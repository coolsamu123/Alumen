// Session gate. Login is required for everything (PLAN_USER_MANAGEMENT.md
// Fase 5) — there is no anonymous mode and no host-based exemption.
//
// The host-based bypass this replaces was an actual auth bypass, not just a
// convenience: it exempted any request whose Host header didn't match
// PUBLIC_HOSTS, and the Host header is chosen by the caller. nginx listens as
// `default_server` with `server_name _` and forwards `Host: $host` verbatim,
// so `curl -H 'Host: anything' http://<public-ip>/api/admin/config` reached
// every admin route unauthenticated, from the internet. Visiting the app by
// its raw IP did the same thing accidentally. Measured and confirmed against
// production on 2026-09-09 before removing it.
//
// Flow:
//   - Path in PUBLIC_PATHS (the login screen and its endpoint) → next().
//   - No valid session cookie → redirect to /login (page) or 401 JSON (API).
//   - Valid session, protected path, role != admin → 403.
//   - Otherwise → next().
//
// This file runs on the Edge runtime — no better-sqlite3, no node:crypto.
// verifySessionToken() (src/lib/session.ts) only checks the cookie's
// signature/shape/expiry; it does NOT reread token_version/is_active from
// SQLite. That authoritative recheck happens in src/lib/auth.ts, used by
// route handlers, so a deactivated user is rejected there immediately rather
// than only once their cookie naturally expires.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/session';

// Reachable without a session — otherwise nobody could ever log in. Kept as
// tight as possible: the login screen and the login/logout endpoints, nothing
// else. (Static assets never reach middleware; see `config.matcher` below.)
const PUBLIC_PATHS = ['/login', '/api/auth/login', '/api/auth/logout'];

// Match-all-methods prefixes. Beyond requiring a session, these require the
// session to be an admin.
const PROTECTED_PREFIXES = [
  '/admin',
  '/api/admin',
  '/api/drive',
  '/api/auto-discovery',
  '/api/analyze',
  '/api/prompts',
  '/api/projects/upload',
];

// Mixed-method endpoints: GETs are public-safe (used by the read-only views
// served from external hosts), but writes/expensive POSTs require auth.
//
// /api/goals moved here from PROTECTED_PREFIXES (Fase 4, PLAN_USER_MANAGEMENT.md
// §4.2): it used to block every method, which meant a logged-in basic user
// couldn't even load the Goals Extractor's read-only list — GoalsView.tsx
// disables its Run/Erase buttons for non-admins, but that's moot if the GET
// that populates the view 401s first. Matches the existing /api/impact
// pattern: read is open, POST (run analysis / erase) requires admin.
const PROTECTED_BY_METHOD: Array<{ prefix: string; methods: string[] }> = [
  { prefix: '/api/impact', methods: ['POST', 'PUT', 'PATCH', 'DELETE'] },
  { prefix: '/api/projects', methods: ['POST', 'PUT', 'PATCH', 'DELETE'] },
  { prefix: '/api/services/mapping', methods: ['POST', 'PUT', 'PATCH', 'DELETE'] },
  { prefix: '/api/goals', methods: ['POST', 'PUT', 'PATCH', 'DELETE'] },
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
  const { pathname } = request.nextUrl;
  const method = request.method;
  const isApi = pathname.startsWith('/api/');

  if (PUBLIC_PATHS.some(p => pathStartsWith(pathname, p))) {
    return NextResponse.next();
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySessionToken(token);

  if (!session) {
    if (isApi) return unauthorizedJson();
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('next', pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (isProtected(pathname, method) && session.role !== 'admin') {
    return isApi ? forbiddenJson() : forbiddenPage();
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
