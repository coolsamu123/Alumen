// Authoritative session check for Node route handlers (as opposed to
// src/lib/session.ts, which only verifies the cookie's signature/shape and is
// shared with the Edge middleware). This is where PLAN_USER_MANAGEMENT.md
// §2.2's second layer lives: reread the user from SQLite so a deactivated
// account, a role change, or a password reset — all of which bump
// token_version — is rejected here even while the cookie itself is still
// validly signed and unexpired.

import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySessionToken, type Role } from './session';
import { findUserById } from './users-repo';

export interface AuthedUser {
  id: number;
  email: string;
  name: string;
  role: Role;
}

export async function getSession(): Promise<AuthedUser | null> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  const payload = await verifySessionToken(token);
  if (!payload) return null;

  const user = findUserById(payload.uid);
  if (!user || !user.is_active) return null;
  if (user.token_version !== payload.tv) return null;

  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

export type SessionOrError = AuthedUser | { error: string; status: 401 | 403 };

export function isSessionError(v: SessionOrError): v is { error: string; status: 401 | 403 } {
  return 'error' in v;
}

/** For route handlers: `const s = await requireAdmin(); if (isSessionError(s)) return NextResponse.json(s, {status: s.status});` */
export async function requireAdmin(): Promise<SessionOrError> {
  const session = await getSession();
  if (!session) return { error: 'Authentication required.', status: 401 };
  if (session.role !== 'admin') return { error: 'Admin role required.', status: 403 };
  return session;
}
