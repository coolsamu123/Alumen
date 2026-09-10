import { NextResponse } from 'next/server';
import { requireAdmin, isSessionError } from '@/lib/auth';
import { readQueue, readHeartbeat, enqueue, pruneQueue } from '@/lib/alumen-queue';

// Under /api/drive on purpose: middleware.ts treats that prefix as admin-only,
// and queueing a copy is an action, not a read. The Data Flow view a basic user
// sees stays on /api/strom/dataflow-state, which is read-only.
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await requireAdmin();
  if (isSessionError(session)) {
    return NextResponse.json({ error: session.error }, { status: session.status });
  }
  try {
    // Reconcile before answering: by design it is Alumen, not Apps Script, that
    // removes an item — once the project shows up in the control sheet. Leaving
    // that to the manual button would let the queue lie until someone clicks.
    // pruneQueue() only writes when there is drift, so the normal case stays a
    // pure read.
    await pruneQueue().catch(() => 0);
    const [queue, heartbeat] = await Promise.all([readQueue(), readHeartbeat()]);
    return NextResponse.json({ ok: true, queue, heartbeat });
  } catch (err: unknown) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 200 }
    );
  }
}

export async function POST(request: Request) {
  const session = await requireAdmin();
  if (isSessionError(session)) {
    return NextResponse.json({ error: session.error }, { status: session.status });
  }

  let projectId = '';
  try {
    const body = (await request.json()) as { projectId?: string };
    projectId = String(body.projectId ?? '').trim();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }
  if (!projectId) {
    return NextResponse.json({ ok: false, error: 'projectId is required' }, { status: 400 });
  }

  try {
    const result = await enqueue(projectId, session.email);
    return NextResponse.json({ ok: true, ...result });
  } catch (err: unknown) {
    // The raw Google error matters: a 403 here names the service account that
    // needs write access to the Copy Utility folder.
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 200 }
    );
  }
}

/** Drops from the queue whatever already reached the control sheet. */
export async function DELETE() {
  const session = await requireAdmin();
  if (isSessionError(session)) {
    return NextResponse.json({ error: session.error }, { status: session.status });
  }
  try {
    const removed = await pruneQueue();
    return NextResponse.json({ ok: true, removed });
  } catch (err: unknown) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 200 }
    );
  }
}
