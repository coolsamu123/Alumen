import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getVisibleProjectIds } from '@/lib/access';
import { generateProjectReport, getProjectReport } from '@/lib/project-report';

export const dynamic = 'force-dynamic';

// Open to every logged-in user (middleware requires the session; /api/reports
// is not an admin prefix) — limited to the projects that user can see.
async function resolve(raw: string) {
  const session = await getSession();
  if (!session) return { error: NextResponse.json({ error: 'Not signed in' }, { status: 401 }) };

  // Not only PRJ numbers: Drive-discovered projects carry ids like "CA_9532".
  let projectId = raw;
  try { projectId = decodeURIComponent(projectId); } catch { /* already decoded */ }
  projectId = projectId.trim();
  if (!projectId || projectId.length > 200) {
    return { error: NextResponse.json({ error: 'Invalid project id' }, { status: 400 }) };
  }
  const visible = getVisibleProjectIds(session);
  if (visible !== 'ALL' && !visible.has(projectId)) {
    return { error: NextResponse.json({ error: 'Project not found' }, { status: 404 }) };
  }
  return { session, projectId, visible };
}

/** The last report generated for the project, or `{ report: null }`. */
export async function GET(_req: Request, { params }: { params: { projectId: string } }) {
  const r = await resolve(params.projectId);
  if ('error' in r) return r.error;
  return NextResponse.json({ report: getProjectReport(r.projectId) });
}

export async function POST(_req: Request, { params }: { params: { projectId: string } }) {
  const r = await resolve(params.projectId);
  if ('error' in r) return r.error;
  const { session, projectId, visible } = r;

  try {
    return NextResponse.json(await generateProjectReport(projectId, visible, session.name || session.email));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[report]', projectId, message);
    const status = /^Project .* not found$/.test(message) ? 404 : /already being generated/.test(message) ? 409 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
