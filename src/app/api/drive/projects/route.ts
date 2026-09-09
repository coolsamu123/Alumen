import { NextResponse } from 'next/server';
import path from 'path';
import { getDb } from '@/lib/db';
import { getDownloadedFilesByProject, getProjectLocalPath } from '@/lib/drive-engine';
import type { ProjectSource } from '@/lib/types';

interface ExplorerRow {
  projectId: string;
  name: string;
  source: ProjectSource;
  /** ISO timestamp since when an initiative's folder is gone from Drive. */
  missingSince: string | null;
  dds: string;
  gate: string;
  filesDownloaded: number;
  hasGoals: boolean;
  impactCount: number;
  linkFolder: string;
  linkPositions: string;
  linkCIOO: string;
  localPath: string;
}

// Every one of these routes reads mutable state (SQLite, the filesystem, live
// run status). A GET handler that takes no `request` argument is statically
// prerendered at build time by the production build — the response gets baked
// into .next and served forever, so a project added after the build is
// invisible until the next one. That never showed under `next dev`, which
// prerenders nothing.
export const dynamic = 'force-dynamic';

// One row per project (deduped across review batches), with download/goal/impact
// counts joined in. Used by the Drive Sync project explorer.
export async function GET() {
  try {
    const db = getDb();

    // One row per project_id, keeping the most recent insert (highest auto-increment id).
    // Using MAX(uploaded_at) here was unreliable because Excel uploads insert all
    // duplicates in a single transaction, so their uploaded_at is identical.
    const rows = db.prepare(`
      SELECT p.project_id, p.name, p.dds, p.gate, p.source,
             p.link_folder, p.link_positions, p.link_cioo
      FROM projects p
      WHERE p.id = (
        SELECT MAX(p2.id) FROM projects p2 WHERE p2.project_id = p.project_id
      )
      ORDER BY p.project_id ASC
    `).all() as Array<{
      project_id: string; name: string; dds: string; gate: string; source: string | null;
      link_folder: string | null; link_positions: string | null; link_cioo: string | null;
    }>;

    // Initiatives whose Drive folder has disappeared. They are kept — the goals
    // and impact edges already computed stay valid — but the table has to say
    // so, otherwise a stale row is indistinguishable from a live one.
    const missingMap = new Map<string, string>();
    try {
      const rowsMissing = db.prepare(
        'SELECT project_id, missing_since FROM initiatives WHERE missing_since IS NOT NULL'
      ).all() as { project_id: string; missing_since: string }[];
      for (const r of rowsMissing) missingMap.set(r.project_id, r.missing_since);
    } catch { /* table not migrated yet */ }

    // Goals: which projects have a successful goals row.
    const goalRows = (() => {
      try {
        return db.prepare(
          "SELECT DISTINCT project_id FROM project_goals WHERE status = 'success'"
        ).all() as { project_id: string }[];
      } catch { return []; }
    })();
    const goalsSet = new Set(goalRows.map(r => r.project_id));

    // Impact count per project (counts edges where the project appears as source or target).
    const impactRows = db.prepare(`
      SELECT pid, COUNT(*) c FROM (
        SELECT source_project_id AS pid FROM projects_impact
        UNION ALL
        SELECT target_project_id AS pid FROM projects_impact
      )
      GROUP BY pid
    `).all() as { pid: string; c: number }[];
    const impactMap = new Map(impactRows.map(r => [r.pid, r.c]));

    const filesMap = getDownloadedFilesByProject();
    const cwd = process.cwd();

    const out: ExplorerRow[] = rows.map(r => {
      const absPath = getProjectLocalPath(r.project_id);
      // Show as repo-relative path when possible so the column stays compact.
      const localPath = absPath
        ? (absPath.startsWith(cwd) ? path.relative(cwd, absPath) : absPath)
        : '';
      return {
        projectId: r.project_id,
        name: r.name,
        source: (r.source === 'initiative' || r.source === 'drive' ? r.source : 'excel'),
        missingSince: missingMap.get(r.project_id) ?? null,
        dds: r.dds || '',
        gate: r.gate || '',
        filesDownloaded: filesMap.get(r.project_id) || 0,
        hasGoals: goalsSet.has(r.project_id),
        impactCount: impactMap.get(r.project_id) || 0,
        linkFolder: r.link_folder || '',
        linkPositions: r.link_positions || '',
        linkCIOO: r.link_cioo || '',
        localPath,
      };
    });

    return NextResponse.json({ rows: out, generatedAt: new Date().toISOString() });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
