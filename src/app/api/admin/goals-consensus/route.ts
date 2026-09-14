import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, isSessionError } from '@/lib/auth';
import { consensusGoals } from '@/lib/goals-analyzer';

// Consensus re-analysis of one project: runs the extraction N times and shows
// what repeated. Writes nothing — it is supporting reading for someone about to
// look closely at a project (PLAN_PROMPTS_CATALOG_REVIEW.md §0.5).
//
// N LLM calls per request, hence admin-only and capped at 5.
export const dynamic = 'force-dynamic';
export const maxDuration = 600;

export async function POST(request: NextRequest) {
  const session = await requireAdmin();
  if (isSessionError(session)) {
    return NextResponse.json({ error: session.error }, { status: session.status });
  }
  const projectId = request.nextUrl.searchParams.get('projectId');
  if (!projectId) {
    return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
  }
  const runs = parseInt(request.nextUrl.searchParams.get('runs') ?? '3', 10);
  try {
    return NextResponse.json(await consensusGoals(projectId, runs));
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
