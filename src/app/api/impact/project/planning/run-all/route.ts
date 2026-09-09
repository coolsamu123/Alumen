import { NextRequest, NextResponse } from 'next/server';
import {
  runPlanAll,
  requestStopPlanAll,
  resetPlanAllState,
  isPlanAllRunning,
  getPlanAllState,
} from '@/lib/planning-run-all';

// POST { projectIds: string[] } → start a "Plan all" run over exactly the
// given projects (the client sends whatever is currently visible/filtered in
// the Details view). Fire-and-forget; the client polls GET for progress.
// DELETE          → request stop; the in-flight project finishes, the rest
//                    are marked 'skipped'.
// DELETE ?force=1 → hard reset, to unstick a crashed run.
// GET             → snapshot for polling.

export async function POST(request: NextRequest) {
  try {
    if (isPlanAllRunning()) {
      return NextResponse.json(
        { error: 'Plan all is already running', state: getPlanAllState() },
        { status: 409 },
      );
    }
    const body = await request.json() as { projectIds?: string[] };
    const projectIds = Array.isArray(body.projectIds) ? body.projectIds.filter(id => typeof id === 'string') : [];
    if (projectIds.length === 0) {
      return NextResponse.json({ error: 'Missing required field: projectIds (non-empty array)' }, { status: 400 });
    }

    runPlanAll(projectIds).catch(err => {
      console.error('[plan-all] runPlanAll threw:', err);
    });

    return NextResponse.json({ ok: true, state: getPlanAllState() });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const force = request.nextUrl.searchParams.get('force') === '1';
  if (force) {
    resetPlanAllState();
    return NextResponse.json({ ok: true, reset: true, state: getPlanAllState() });
  }
  const { stopped } = requestStopPlanAll();
  return NextResponse.json({ ok: true, stopped, state: getPlanAllState() });
}

export async function GET() {
  return NextResponse.json(getPlanAllState());
}
