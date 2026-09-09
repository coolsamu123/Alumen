// Session cookie: signed, stateless, verifiable from BOTH the Edge middleware
// and Node route handlers with the exact same code. See
// PLAN_USER_MANAGEMENT.md §2.2 — middleware.ts cannot import better-sqlite3
// (native, Node-only) or node:crypto (no Edge build), so this module is
// written against Web Crypto (`crypto.subtle`, `btoa`/`atob`), which both
// runtimes provide.
//
// This file verifies the cookie's signature, expiry and shape ONLY. It does
// NOT reread the user from the database — that authoritative recheck
// (is_active, token_version) happens in `src/lib/auth.ts`, which runs in Node
// route handlers. A payload that verifies here can still belong to a
// deactivated user; only auth.ts's getSession() is the source of truth.

export type Role = 'admin' | 'basic';

export interface SessionPayload {
  uid: number;
  role: Role;
  tv: number; // users.token_version at the moment this cookie was issued
  exp: number; // unix seconds
}

export const SESSION_COOKIE = 'alumen_session';
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function getSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      'SESSION_SECRET is not set. Add SESSION_SECRET=<random 32+ byte hex> to .env.local.'
    );
  }
  return secret;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let str = '';
  for (const b of arr) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(
    Math.ceil(b64url.length / 4) * 4,
    '='
  );
  const str = atob(b64);
  const arr = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) arr[i] = str.charCodeAt(i);
  return arr;
}

export async function signSession(payload: SessionPayload): Promise<string> {
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await hmacKey(getSecret());
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return `${body}.${toBase64Url(sig)}`;
}

/**
 * Verifies signature, shape and expiry. Returns null on anything wrong —
 * missing cookie, bad signature, malformed payload, or expired token.
 */
export async function verifySessionToken(
  token: string | undefined | null
): Promise<SessionPayload | null> {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!body || !sig) return null;

  try {
    const key = await hmacKey(getSecret());
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      fromBase64Url(sig) as BufferSource,
      encoder.encode(body)
    );
    if (!valid) return null;

    const payload = JSON.parse(decoder.decode(fromBase64Url(body))) as SessionPayload;
    if (typeof payload.uid !== 'number') return null;
    if (payload.role !== 'admin' && payload.role !== 'basic') return null;
    if (typeof payload.tv !== 'number') return null;
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}
