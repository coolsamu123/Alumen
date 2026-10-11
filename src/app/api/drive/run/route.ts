import { NextRequest, NextResponse } from 'next/server';
import {
  runAutoDiscoveryCycle,
  isAutoCycleRunning,
  type CycleMode,
} from '@/lib/auto-pipeline';
import { runDriveDownload, runDriveDownloadSingle, getDriveStatus } from '@/lib/drive-engine';

// Unified pipeline trigger.
//   { mode: 'full' }              → discover → download → goals → impact
//   { mode: 'goals-only' }        → discover → download → goals (skip impact)
//   { mode: 'download-only' }     → re-download all known links (legacy "Extract Everything")
//   { mode: 'project', projectId } → re-sync a single project's Drive links
//                                    (wait: true → answers with the result)
export async function POST(request: NextRequest) {
  let body: { mode?: string; projectId?: string; wait?: boolean } = {};
  try {
    body = await request.json();
  } catch { /* ignore */ }

  const mode = body.mode || 'full';

  if (mode === 'project') {
    if (!body.projectId) {
      return NextResponse.json({ error: 'Missing projectId' }, { status: 400 });
    }
    const drive = getDriveStatus();
    if (drive.isRunning || isAutoCycleRunning()) {
      return NextResponse.json({ error: 'Pipeline already running' }, { status: 409 });
    }
    if (body.wait) {
      // One project takes seconds to a few minutes; nginx allows 300 s+.
      const result = await runDriveDownloadSingle(body.projectId);
      return NextResponse.json({ success: true, mode, projectId: body.projectId, ...result });
    }
    runDriveDownloadSingle(body.projectId).catch(err =>
      console.error('[run] single project failed:', err)
    );
    return NextResponse.json({ success: true, mode, projectId: body.projectId });
  }

  if (mode === 'download-only') {
    const drive = getDriveStatus();
    if (drive.isRunning || isAutoCycleRunning()) {
      return NextResponse.json({ error: 'Pipeline already running' }, { status: 409 });
    }
    runDriveDownload().catch(err => console.error('[run] download-only failed:', err));
    return NextResponse.json({ success: true, mode });
  }

  if (mode !== 'full' && mode !== 'goals-only') {
    return NextResponse.json({ error: `Invalid mode "${mode}"` }, { status: 400 });
  }

  if (isAutoCycleRunning()) {
    return NextResponse.json({ error: 'Pipeline already running' }, { status: 409 });
  }

  const cycleMode: CycleMode = mode === 'goals-only' ? 'goals-only' : 'full';
  runAutoDiscoveryCycle('manual', cycleMode).catch(err =>
    console.error('[run] cycle failed:', err)
  );

  return NextResponse.json({ success: true, mode: cycleMode });
}
