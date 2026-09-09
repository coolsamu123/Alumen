import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, isSessionError } from '@/lib/auth';
import { findUserById, replaceUserScopes } from '@/lib/users-repo';
import { resolveScopedProjectIds } from '@/lib/access';

// Replaces the user's entire scope set in one call — the admin UI always
// submits the full current selection (checked DDS + picked projects) rather
// than diffing individual grants.
export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireAdmin();
  if (isSessionError(session)) {
    return NextResponse.json({ error: session.error }, { status: session.status });
  }

  const id = Number(params.id);
  const user = findUserById(id);
  if (!user) return NextResponse.json({ error: 'Usuário não encontrado.' }, { status: 404 });

  const body = await request.json().catch(() => null);
  const dds: string[] = Array.isArray(body?.dds)
    ? body.dds.filter((v: unknown): v is string => typeof v === 'string')
    : [];
  const projects: string[] = Array.isArray(body?.projects)
    ? body.projects.filter((v: unknown): v is string => typeof v === 'string')
    : [];

  replaceUserScopes(id, [
    ...dds.map(value => ({ type: 'dds' as const, value })),
    ...projects.map(value => ({ type: 'project' as const, value })),
  ]);

  const visibleCount: number | 'ALL' =
    dds.length === 0 && projects.length === 0 ? 'ALL' : resolveScopedProjectIds(dds, projects).size;

  return NextResponse.json({ ok: true, visibleCount });
}
