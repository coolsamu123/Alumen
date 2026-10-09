import { NextResponse } from 'next/server';
import { requireAdmin, isSessionError } from '@/lib/auth';
import { getCdioStatus, syncCdio, autoLoadNewCdio, setAutoLoad } from '@/lib/cdio-sync';

// Under /api/drive: admin-only (middleware.ts), like everything that loads data.
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await requireAdmin();
  if (isSessionError(session)) {
    return NextResponse.json({ error: session.error }, { status: session.status });
  }
  try {
    return NextResponse.json({ ok: true, status: getCdioStatus() });
  } catch (err: unknown) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

/** "Ler CDIO agora": merges the sheet even if Drive reports no change. */
export async function POST() {
  const session = await requireAdmin();
  if (isSessionError(session)) {
    return NextResponse.json({ error: session.error }, { status: session.status });
  }
  const outcome = await syncCdio({ force: true });
  const auto = outcome.error ? { added: [] as string[], error: null } : await autoLoadNewCdio(session.email);
  return NextResponse.json({
    ok: !outcome.error,
    error: outcome.error,
    autoLoaded: auto.added.length,
    autoLoadError: auto.error,
    result: outcome.result && {
      added: outcome.result.added,
      updated: outcome.result.updated,
      promoted: outcome.result.promoted,
      missing: outcome.result.missing,
      warnings: outcome.result.errors.slice(0, 20),
    },
    status: getCdioStatus(),
  });
}

/** { autoLoad: boolean } — pause or resume automatic loading of CDIO projects. */
export async function PATCH(request: Request) {
  const session = await requireAdmin();
  if (isSessionError(session)) {
    return NextResponse.json({ error: session.error }, { status: session.status });
  }
  let body: { autoLoad?: unknown };
  try { body = await request.json(); } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }
  if (typeof body.autoLoad !== 'boolean') {
    return NextResponse.json({ ok: false, error: 'autoLoad must be a boolean' }, { status: 400 });
  }
  setAutoLoad(body.autoLoad);
  return NextResponse.json({ ok: true, status: getCdioStatus() });
}
