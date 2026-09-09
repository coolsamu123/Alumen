import { NextResponse } from 'next/server';
import { requireAdmin, isSessionError } from '@/lib/auth';
import { testUpstream } from '@/lib/upstream-sync';

// Bypasses the cache and returns the raw Google error on failure — the 403
// from the Drive export names the service account address that needs to be
// added to the CopyUtility folder, which is the whole point of the button.
export async function POST() {
  const session = await requireAdmin();
  if (isSessionError(session)) {
    return NextResponse.json({ error: session.error }, { status: session.status });
  }

  const result = await testUpstream();
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 200 });
  }

  const byStage = { copy: 0, cleanup: 0 };
  for (const r of result.rows) byStage[r.stage]++;

  return NextResponse.json({
    ok: true,
    total: result.rows.length,
    byStage,
    sample: result.rows.slice(0, 5),
  });
}
