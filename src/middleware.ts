// External-host Basic Auth gate.
//
// Goal: on any host that matches PUBLIC_HOSTS (currently the EC2 hostname),
// protect admin pages, write endpoints, and the heavier batch APIs behind a
// Basic Auth challenge. Local requests (no PUBLIC_HOSTS match) bypass this
// middleware entirely — same UX as before.
//
// Flow:
//   - Local host                       → next() (no challenge).
//   - External host, public path       → next() (graph / timeline / detail /
//                                                 impact-read still work).
//   - External host, protected path:
//       - No ADMIN_BASIC_AUTH set      → 503 (server misconfigured).
//       - Missing / wrong creds        → 401 + WWW-Authenticate → browser
//                                                                  shows native dialog.
//       - Valid creds                  → next(), injecting `x-strom-authed: 1`
//                                        on the request so the layout knows to
//                                        unlock the full UI.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isPublicHost, AUTHED_HEADER } from '@/lib/public-host';

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

function parseBasicAuth(header: string | null): { user: string; pass: string } | null {
  if (!header || !header.toLowerCase().startsWith('basic ')) return null;
  try {
    // atob is available in the edge runtime that powers Next middleware.
    const decoded = atob(header.slice(6).trim());
    const idx = decoded.indexOf(':');
    if (idx < 0) return null;
    return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

function expectedCreds(): { user: string; pass: string } | null {
  const raw = process.env.ADMIN_BASIC_AUTH;
  if (!raw) return null;
  const idx = raw.indexOf(':');
  if (idx < 0) return null;
  return { user: raw.slice(0, idx), pass: raw.slice(idx + 1) };
}

function timingSafeEqual(a: string, b: string): boolean {
  // Edge runtime has no node:crypto — emulate constant-time compare.
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function unauthorized(): NextResponse {
  return new NextResponse('Authentication required.\n', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Alumen - restricted area", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function misconfigured(): NextResponse {
  return new NextResponse(
    'Admin access disabled. Set ADMIN_BASIC_AUTH=user:password in .env.local and restart.\n',
    {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    },
  );
}

export function middleware(request: NextRequest) {
  const host = request.headers.get('host');
  if (!isPublicHost(host)) return NextResponse.next();

  const { pathname } = request.nextUrl;
  const method = request.method;

  const expected = expectedCreds();
  const got = parseBasicAuth(request.headers.get('authorization'));
  const authed = !!(
    expected &&
    got &&
    timingSafeEqual(got.user, expected.user) &&
    timingSafeEqual(got.pass, expected.pass)
  );

  if (isProtected(pathname, method)) {
    if (!expected) return misconfigured();
    if (!authed) return unauthorized();
  }

  if (authed) {
    // Stamp a hint on the downstream request so the root layout / admin layout
    // can flip the UI into "full access" mode for this external session.
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
