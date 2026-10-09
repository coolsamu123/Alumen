import { NextResponse } from 'next/server';
import { requireAdmin, isSessionError } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { normalizeProjectId } from '@/lib/project-id';
import { enqueue } from '@/lib/alumen-queue';
import { splitByBaseFolder } from '@/lib/base-folder';

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
      { ok: false, error: 'Invalid project number (e.g. PRJ0023456)' },
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
        { ok: false, needsName: true, error: `${projectId} is not in CDIO: enter the project name` },
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
    const { alreadyThere } = await splitByBaseFolder([projectId]);
    if (alreadyThere.length) {
      return NextResponse.json({
        ok: true, projectId, created, source: existing?.source ?? 'manual',
        queued: false, queueNote: 'already in the base folder',
      });
    }
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
      error: `Project ${created ? 'created' : 'found'}, but the copy request failed: ` +
        (err instanceof Error ? err.message : String(err)),
    });
  }
}

/**
 * Removes a project added by hand, with everything computed for it. Only
 * 'manual' rows: a CDIO project is governed by the sheet and leaves it through
 * the merge (marked "fora do CDIO"), never through this button.
 */
export async function DELETE(request: Request) {
  const session = await requireAdmin();
  if (isSessionError(session)) {
    return NextResponse.json({ error: session.error }, { status: session.status });
  }
  const projectId = normalizeProjectId(new URL(request.url).searchParams.get('projectId') ?? '');
  if (!projectId) {
    return NextResponse.json({ ok: false, error: 'Invalid projectId' }, { status: 400 });
  }
  const db = getDb();
  const row = db.prepare('SELECT source FROM projects WHERE project_id = ? LIMIT 1')
    .get(projectId) as { source: string } | undefined;
  if (!row) return NextResponse.json({ ok: false, error: `${projectId} does not exist` }, { status: 404 });
  if (row.source !== 'manual') {
    return NextResponse.json({ ok: false, error: `${projectId} is not ad hoc and cannot be removed` }, { status: 409 });
  }
  db.transaction(() => {
    const run = (sql: string) => { try { db.prepare(sql).run(projectId, projectId); } catch { /* table may not exist */ } };
    run('DELETE FROM projects_impact WHERE source_project_id = ? OR target_project_id = ?');
    run('DELETE FROM project_goals WHERE project_id = ? OR project_id = ?');
    run('DELETE FROM documents_cache WHERE project_id = ? OR project_id = ?');
    run('DELETE FROM projects WHERE project_id = ? OR project_id = ?');
  })();
  return NextResponse.json({ ok: true, projectId });
}
