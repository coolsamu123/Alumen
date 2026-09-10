import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, isSessionError } from '@/lib/auth';
import { listUsersWithScopes, createLocalUser, findUserByEmail } from '@/lib/users-repo';
import { resolveScopedProjectIds } from '@/lib/access';

// Never send password_hash to the client.
function toPublicUser<T extends { password_hash: string | null }>(
  u: T
): Omit<T, 'password_hash'> {
  const copy: Partial<T> = { ...u };
  delete copy.password_hash;
  return copy as Omit<T, 'password_hash'>;
}

export async function GET() {
  const session = await requireAdmin();
  if (isSessionError(session)) {
    return NextResponse.json({ error: session.error }, { status: session.status });
  }

  const users = listUsersWithScopes().map(u => {
    const ddsValues = u.scopes.filter(s => s.scope_type === 'dds').map(s => s.scope_value);
    const projectIds = u.scopes.filter(s => s.scope_type === 'project').map(s => s.scope_value);
    const visibleCount: number | 'ALL' =
      u.role === 'admin' || u.scopes.length === 0
        ? 'ALL'
        : resolveScopedProjectIds(ddsValues, projectIds).size;

    return { ...toPublicUser(u), visibleCount };
  });

  return NextResponse.json({ users });
}

export async function POST(request: NextRequest) {
  const session = await requireAdmin();
  if (isSessionError(session)) {
    return NextResponse.json({ error: session.error }, { status: session.status });
  }

  const body = await request.json().catch(() => null);
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  const role = body?.role === 'admin' ? 'admin' : 'basic';

  if (!email || !email.includes('@')) {
    return NextResponse.json({ error: 'Work email is required.' }, { status: 400 });
  }
  if (!name) {
    return NextResponse.json({ error: 'Name is required.' }, { status: 400 });
  }
  if (!password || password.length < 8) {
    return NextResponse.json({ error: 'Senha deve ter ao menos 8 caracteres.' }, { status: 400 });
  }
  if (findUserByEmail(email)) {
    return NextResponse.json({ error: 'A user with that email already exists.' }, { status: 409 });
  }

  const user = createLocalUser({ email, name, password, role });
  return NextResponse.json(toPublicUser(user), { status: 201 });
}
