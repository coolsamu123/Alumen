import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getVisibleProjectIds } from '@/lib/access';
import { generateProjectReport } from '@/lib/project-report';

export const dynamic = 'force-dynamic';

// Open to every logged-in user (middleware requires the session; /api/reports
// is not an admin prefix) — limited to the projects that user can see.
export async function POST(_req: Request, { params }: { params: { projectId: string } }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  // Not only PRJ numbers: Drive-discovered projects carry ids like "CA_9532".
  let projectId = params.projectId;
  try { projectId = decodeURIComponent(projectId); } catch { /* already decoded */ }
  projectId = projectId.trim();
  if (!projectId || projectId.length > 200) {
    return NextResponse.json({ error: 'Invalid project id' }, { status: 400 });
  }
  const visible = getVisibleProjectIds(session);
  if (visible !== 'ALL' && !visible.has(projectId)) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  try {
    return NextResponse.json(await generateProjectReport(projectId, visible));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[report]', projectId, message);
    const status = /^Project .* not found$/.test(message) ? 404 : /already being generated/.test(message) ? 409 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
