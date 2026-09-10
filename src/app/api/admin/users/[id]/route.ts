import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, isSessionError } from '@/lib/auth';
import {
  findUserById,
  setUserActive,
  setUserRole,
  resetPassword,
  deleteUser,
  countActiveAdmins,
  type UserRecord,
  type Role,
} from '@/lib/users-repo';

interface PendingChange {
  role?: Role;
  isActive?: boolean;
}

/**
 * Guard 3 from PLAN_USER_MANAGEMENT.md §8.5: the last active admin can't be
 * demoted, deactivated, or deleted — the most banal lockout there is.
 * `changes` describes the state a PATCH or DELETE would leave the user in
 * (DELETE is modeled as "no longer admin, no longer active").
 */
function wouldRemoveLastAdmin(user: UserRecord, changes: PendingChange): boolean {
  const isCurrentlyActiveAdmin = user.role === 'admin' && user.is_active === 1;
  if (!isCurrentlyActiveAdmin) return false;

  const staysAdmin = (changes.role ?? user.role) === 'admin';
  const staysActive = changes.isActive ?? user.is_active === 1;
  if (staysAdmin && staysActive) return false;

  return countActiveAdmins() <= 1;
}

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireAdmin();
  if (isSessionError(session)) {
    return NextResponse.json({ error: session.error }, { status: session.status });
  }

  const id = Number(params.id);
  const user = findUserById(id);
  if (!user) return NextResponse.json({ error: 'User not found.' }, { status: 404 });

  const body = await request.json().catch(() => ({}));
  const changes: PendingChange = {};
  if (body.role === 'admin' || body.role === 'basic') changes.role = body.role;
  if (typeof body.isActive === 'boolean') changes.isActive = body.isActive;

  if (wouldRemoveLastAdmin(user, changes)) {
    return NextResponse.json(
      { error: 'Cannot remove the last active administrator.' },
      { status: 400 }
    );
  }

  if (changes.role && changes.role !== user.role) setUserRole(id, changes.role);
  if (changes.isActive !== undefined && changes.isActive !== (user.is_active === 1)) {
    setUserActive(id, changes.isActive);
  }

  if (typeof body.password === 'string' && body.password) {
    if (user.auth_provider !== 'local') {
      return NextResponse.json(
        { error: 'Okta accounts do not use a local password.' },
        { status: 400 }
      );
    }
    if (body.password.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters.' }, { status: 400 });
    }
    resetPassword(id, body.password);
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireAdmin();
  if (isSessionError(session)) {
    return NextResponse.json({ error: session.error }, { status: session.status });
  }

  const id = Number(params.id);
  const user = findUserById(id);
  if (!user) return NextResponse.json({ error: 'User not found.' }, { status: 404 });

  if (wouldRemoveLastAdmin(user, { role: 'basic', isActive: false })) {
    return NextResponse.json(
      { error: 'Cannot remove the last active administrator.' },
      { status: 400 }
    );
  }

  deleteUser(id);
  return NextResponse.json({ ok: true });
}
