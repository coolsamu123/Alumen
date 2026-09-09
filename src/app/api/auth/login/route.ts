import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { findUserByEmail, touchLastLogin } from '@/lib/users-repo';
import { verifyPassword } from '@/lib/password';
import { signSession, SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from '@/lib/session';

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body?.password === 'string' ? body.password : '';

  if (!email || !password) {
    return NextResponse.json({ error: 'Email e senha são obrigatórios.' }, { status: 400 });
  }

  const user = findUserByEmail(email);
  // Same message for "no such user", "wrong password" and "Okta-only
  // account" — a 401 here shouldn't tell an attacker which case they hit.
  const invalid = () =>
    NextResponse.json({ error: 'Email ou senha inválidos.' }, { status: 401 });

  if (!user || !user.is_active || user.auth_provider !== 'local' || !user.password_hash) {
    return invalid();
  }
  if (!verifyPassword(password, user.password_hash)) {
    return invalid();
  }

  touchLastLogin(user.id);

  const exp = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS;
  const token = await signSession({ uid: user.id, role: user.role, tv: user.token_version, exp });

  cookies().set(SESSION_COOKIE, token, {
    httpOnly: true,
    // The Alumen prod host is plain HTTP today (see PLAN_USER_MANAGEMENT.md
    // §8.4) — a Secure cookie would silently never be sent by the browser.
    // Flip this on once HTTPS lands.
    secure: process.env.SESSION_COOKIE_SECURE === '1',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });

  return NextResponse.json({ id: user.id, email: user.email, name: user.name, role: user.role });
}
