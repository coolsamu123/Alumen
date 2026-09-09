import { NextResponse } from 'next/server';
import { buildDrivePanelState } from '@/lib/drive-panel-state';

// Narrow, open-to-any-session view onto buildDrivePanelState() for
// DataFlowLive.tsx's "Cadeia" view. Deliberately NOT /api/drive/state: that
// path (and /api/drive/stream) sits under middleware.ts's admin-only
// PROTECTED_PREFIXES, by design — Drive Sync's own management UI is
// admin-only per the original ask, and DrivePanelState's full shape carries
// Drive-Sync-specific operational detail (watchRoots, syncAll, recentRuns)
// that has nothing to do with what a basic user watching the pipeline chain
// needs. Reusing that stream here would have either broken this view for
// basic users (if left admin-gated) or leaked Drive Sync internals to them
// (if the whole prefix were opened). This endpoint calls the same builder —
// no duplicated logic — and returns only the fields DataFlowLive reads.
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const state = buildDrivePanelState();
    return NextResponse.json({
      upstream: state.upstream,
      counts: state.counts,
      pipelineRunning: {
        drive: state.pipeline.drive.isRunning,
        goals: state.pipeline.goals.isRunning,
        impact: state.pipeline.impact.isRunning,
      },
      generatedAt: state.generatedAt,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
