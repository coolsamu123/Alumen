import { NextResponse } from 'next/server';
import { requireAdmin, isSessionError } from '@/lib/auth';
import { readQueue, readHeartbeat, pruneQueue, enqueueMany } from '@/lib/alumen-queue';
import { buildPipelineRows, newCdioProjects } from '@/lib/pipeline-view';
import { splitByBaseFolder } from '@/lib/base-folder';
import { baseFolderUrl, isAutoCycleRunning, getAutoCycleStage } from '@/lib/auto-pipeline';

// The single table of Drive Sync: every project with the state of each stage.
// Under /api/drive: admin-only (middleware.ts).
export const dynamic = 'force-dynamic';

async function queuedIds(): Promise<{ ids: Set<string>; error: string | null }> {
  try {
    // Reconcile first: a request leaves the queue once the control sheet shows
    // the project (alumen-queue.ts). Only writes when there is drift.
    await pruneQueue().catch(() => 0);
    const q = await readQueue();
    return { ids: new Set(q.map(it => it.projectId.trim().toUpperCase())), error: null };
  } catch (err: unknown) {
    return { ids: new Set(), error: err instanceof Error ? err.message : String(err) };
  }
}

export async function GET() {
  const session = await requireAdmin();
  if (isSessionError(session)) {
    return NextResponse.json({ error: session.error }, { status: session.status });
  }
  try {
    const [{ ids, error: queueError }, heartbeat] = await Promise.all([
      queuedIds(),
      readHeartbeat().catch(() => null),
    ]);
    const rows = buildPipelineRows(ids);
    return NextResponse.json({
      ok: true,
      rows,
      newFromCdio: newCdioProjects(rows).length,
      queueSize: ids.size,
      queueError,
      heartbeat,
      cycle: isAutoCycleRunning() ? getAutoCycleStage().stage : 'idle',
      baseFolderUrl: baseFolderUrl(),
      generatedAt: new Date().toISOString(),
    });
  } catch (err: unknown) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

/**
 *   { action: 'load', projectIds: [...] }  → queue the copy for these projects
 *   { action: 'load-new-cdio' }            → queue every CDIO project not requested yet
 */
export async function POST(request: Request) {
  const session = await requireAdmin();
  if (isSessionError(session)) {
    return NextResponse.json({ error: session.error }, { status: session.status });
  }
  let body: { action?: string; projectIds?: string[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  let ids: string[];
  if (body.action === 'load') {
    ids = Array.isArray(body.projectIds) ? body.projectIds.map(String) : [];
  } else if (body.action === 'load-new-cdio') {
    const { ids: queued } = await queuedIds();
    ids = newCdioProjects(buildPipelineRows(queued));
  } else {
    return NextResponse.json({ ok: false, error: 'Unknown action' }, { status: 400 });
  }
  if (!ids.length) return NextResponse.json({ ok: true, added: [], skipped: [], alreadyInBase: [] });

  try {
    // A project already in the base folder is not copied again: it is linked
    // and goes straight to download → goals → impact.
    const { toQueue, alreadyThere } = await splitByBaseFolder(ids);
    const r = toQueue.length ? await enqueueMany(toQueue, session.email) : { added: [], skipped: [] };
    return NextResponse.json({ ok: true, added: r.added, skipped: r.skipped, alreadyInBase: alreadyThere });
  } catch (err: unknown) {
    // The raw Google error matters: a 403 names the service account that needs
    // write access to the Copy Utility folder.
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
