/**
 * "Redo": run every stage of one project again — copy, cleanup, discover,
 * download, goals, impact.
 *
 * 1. requestRedo() remembers the copy/cleanup sheet rows as they are now and
 *    queues the project with `redo: true`. Apps Script (alumenMergeQueue, v4)
 *    resets both rows, so the project goes through copy and cleanup again.
 * 2. pruneQueue() drops the request once the copy row changed (Apps Script
 *    took it).
 * 3. settleRedos(), on every upstream read: once copy and cleanup are DONE
 *    with rows newer than the remembered ones, it wipes the project's
 *    downloaded files and goals. The scheduler then downloads them again and
 *    re-runs goals, and new goals trigger a full impact run.
 */
import fs from 'fs';
import path from 'path';
import { getDb } from './db';
import { DRIVE_LOCAL_ROOT } from './drive-engine';
import { enqueueRedo } from './alumen-queue';

export interface PendingRedo {
  project_id: string;
  requested_at: string;
  copy_sheet_at: string | null;
  cleanup_sheet_at: string | null;
}

function sheetAt(projectId: string, stage: 'copy' | 'cleanup'): string | null {
  const r = getDb()
    .prepare('SELECT sheet_at FROM upstream_status WHERE project_id = ? AND stage = ?')
    .get(projectId, stage) as { sheet_at: string | null } | undefined;
  return r?.sheet_at ?? null;
}

export async function requestRedo(projectId: string, requestedBy: string): Promise<void> {
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM projects WHERE project_id = ?').get(projectId)) {
    throw new Error(`Project ${projectId} not found`);
  }
  const requestedAt = new Date().toISOString();
  // Queue first: if Drive refuses, nothing local changes.
  await enqueueRedo(projectId, requestedBy, requestedAt);
  db.prepare(`
    INSERT OR REPLACE INTO project_redo (project_id, requested_at, requested_by, copy_sheet_at, cleanup_sheet_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(projectId, requestedAt, requestedBy, sheetAt(projectId, 'copy'), sheetAt(projectId, 'cleanup'));
}

export function pendingRedos(): Map<string, PendingRedo> {
  try {
    const rows = getDb().prepare('SELECT * FROM project_redo').all() as PendingRedo[];
    return new Map(rows.map(r => [r.project_id.toUpperCase(), r]));
  } catch {
    return new Map(); // table not created yet
  }
}

/** True once Apps Script has touched the copy row since the request. */
export function copyTaken(r: PendingRedo): boolean {
  const now = sheetAt(r.project_id, 'copy');
  return now !== null && now !== r.copy_sheet_at;
}

function wipeLocal(projectId: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM documents_cache WHERE project_id = ?').run(projectId);
    db.prepare('DELETE FROM project_goals WHERE project_id = ?').run(projectId);
    db.prepare('DELETE FROM project_redo WHERE project_id = ?').run(projectId);
  })();
  // Local copies too, or the download would reuse the old text.
  try {
    for (const d of fs.readdirSync(DRIVE_LOCAL_ROOT)) {
      if (d.toUpperCase().startsWith(`${projectId.toUpperCase()}_`)) {
        fs.rmSync(path.join(DRIVE_LOCAL_ROOT, d), { recursive: true, force: true });
      }
    }
  } catch { /* no local folder */ }
}

/** Called after every upstream read. Returns the projects it reset. */
export function settleRedos(): string[] {
  const done: string[] = [];
  const db = getDb();
  for (const r of pendingRedos().values()) {
    const rows = db.prepare(
      'SELECT stage, status, sheet_at FROM upstream_status WHERE project_id = ?'
    ).all(r.project_id) as { stage: string; status: string; sheet_at: string | null }[];
    const copy = rows.find(x => x.stage === 'copy');
    const clean = rows.find(x => x.stage === 'cleanup');
    const fresh = (x: typeof copy, before: string | null) =>
      !!x && x.status === 'DONE' && x.sheet_at !== null && x.sheet_at !== before;
    if (fresh(copy, r.copy_sheet_at) && fresh(clean, r.cleanup_sheet_at)) {
      wipeLocal(r.project_id);
      done.push(r.project_id);
    }
  }
  return done;
}
