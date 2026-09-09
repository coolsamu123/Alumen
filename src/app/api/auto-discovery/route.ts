import { NextRequest, NextResponse } from 'next/server';
import {
  listWatchRoots,
  addWatchRoot,
  deleteWatchRoot,
  getLastAutoRun,
  isAutoCycleRunning,
  getAutoCycleStage,
} from '@/lib/auto-pipeline';
import type { RootKind } from '@/lib/auto-pipeline';
import { getDriveStatus } from '@/lib/drive-engine';
import { getGoalsStatus } from '@/lib/goals-analyzer';
import { getImpactStatus } from '@/lib/impact-engine';

export async function GET() {
  const { stage, rootLabel } = getAutoCycleStage();
  return NextResponse.json({
    roots: listWatchRoots(),
    lastRun: getLastAutoRun(),
    isRunning: isAutoCycleRunning(),
    progress: {
      currentStage: stage,
      currentRoot: rootLabel,
      drive: getDriveStatus(),
      goals: getGoalsStatus(),
      impact: getImpactStatus(),
    },
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { url?: string; label?: string; kind?: string };
    if (!body.url || typeof body.url !== 'string') {
      return NextResponse.json({ error: 'Missing url' }, { status: 400 });
    }
    // Unrecognised values fall back to 'portfolio', which is what every root
    // added before initiatives existed is.
    const kind: RootKind = body.kind === 'initiatives' ? 'initiatives' : 'portfolio';
    const { id } = addWatchRoot(body.url.trim(), body.label?.trim(), kind);
    return NextResponse.json({ success: true, id, roots: listWatchRoots() });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest) {
  const idParam = request.nextUrl.searchParams.get('id');
  const id = idParam ? parseInt(idParam, 10) : NaN;
  if (!id || isNaN(id)) {
    return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  }
  deleteWatchRoot(id);
  return NextResponse.json({ success: true, roots: listWatchRoots() });
}
