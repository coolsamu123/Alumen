import { NextResponse } from 'next/server';
import { requireAdmin, isSessionError } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { normalizeProjectId } from '@/lib/project-id';
import { enqueue } from '@/lib/alumen-queue';

// Adds a project by number ("avulso") and asks Apps Script to copy its folder.
//
// The project may or may not be in the CDIO sheet:
//   - already in `projects` (from the sheet, or added before) → nothing is
//     created; the request only queues the copy, i.e. it means "load this one";
//   - unknown → a row with source 'manual' is created from the form. The next
//     CDIO read promotes it to 'excel' if the sheet starts listing it, and never
//     touches it otherwise (excel-parser.ts mergeCdioRows).
//
// Under /api/drive: admin-only (middleware.ts).
export const dynamic = 'force-dynamic';

interface Body {
  projectId?: string;
  name?: string;
  dds?: string;
  gate?: string;
  description?: string;
}

export async function POST(request: Request) {
  const session = await requireAdmin();
  if (isSessionError(session)) {
    return NextResponse.json({ error: session.error }, { status: session.status });
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const projectId = normalizeProjectId(String(body.projectId ?? ''));
  if (!projectId) {
    return NextResponse.json(
      { ok: false, error: 'Número de projeto inválido (ex.: PRJ0023456)' },
      { status: 400 },
    );
  }

  const db = getDb();
  const existing = db.prepare('SELECT source FROM projects WHERE project_id = ? LIMIT 1')
    .get(projectId) as { source: string } | undefined;

  let created = false;
  if (!existing) {
    const name = String(body.name ?? '').trim();
    if (!name) {
      return NextResponse.json(
        { ok: false, needsName: true, error: `${projectId} não está no CDIO: informe o nome do projeto` },
        { status: 400 },
      );
    }
    db.prepare(`
      INSERT INTO projects (project_id, name, dds, gate, description, source)
      VALUES (?, ?, ?, ?, ?, 'manual')
    `).run(
      projectId,
      name,
      String(body.dds ?? '').trim(),
      String(body.gate ?? '').trim(),
      String(body.description ?? '').trim(),
    );
    created = true;
  }

  // The row is kept even if queueing fails: the copy can be requested again,
  // and a Drive error should not throw away what the user typed.
  try {
    const q = await enqueue(projectId, session.email);
    return NextResponse.json({
      ok: true,
      projectId,
      created,
      source: existing?.source ?? 'manual',
      queued: q.added,
      queueNote: q.reason ?? null,
    });
  } catch (err: unknown) {
    return NextResponse.json({
      ok: false,
      projectId,
      created,
      error: `Projeto ${created ? 'criado' : 'encontrado'}, mas o pedido de cópia falhou: ` +
        (err instanceof Error ? err.message : String(err)),
    });
  }
}
