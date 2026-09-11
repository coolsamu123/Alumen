import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

// Per-project breakdown across the 6 stages (PLAN_LIVE_DATAFLOW.md §1.3),
// for the "projetos" table in DataFlowLive.tsx. Deliberately NOT folded into
// DrivePanelState/the SSE tick: that state is pushed every 500ms–2s to every
// open tab, and this is a ~300-row join that only the "projetos" sub-view
// needs — it's fetched on demand with its own light polling instead.
//
// No admin gate here on purpose: this view lives under the 'strom' tab, which
// basic users can see (unlike Drive Sync). It's read-only and derives from
// data those users can already reach via Goals/Impact. Deliberately placed
// under /api/strom, not /api/drive — the latter is admin-only for every
// method (middleware.ts PROTECTED_PREFIXES), which would have wrongly locked
// this out for basic users.

// Reads mutable state (SQLite), so it must not be prerendered at build time.
// Without this the production build bakes one response into .next and serves it
// forever: the table showed the portfolio exactly as it stood at build time, and
// projects copied afterwards came back with copy/cleanup = NONE even though the
// mirror had them as DONE. Same trap already documented in
// api/drive/projects/route.ts — this route was the one that missed the fix.
export const dynamic = 'force-dynamic';

type StageStatus = 'DONE' | 'ERROR' | 'IN_PROGRESS' | 'PENDING' | 'NONE';

interface ProjectRow {
  projectId: string;
  name: string;
  stages: {
    copy: StageStatus;
    cleanup: StageStatus;
    discover: StageStatus;
    download: StageStatus;
    goals: StageStatus;
    impact: StageStatus;
  };
}

export async function GET() {
  const db = getDb();

  const projects = db
    .prepare('SELECT DISTINCT project_id, name FROM projects ORDER BY project_id')
    .all() as Array<{ project_id: string; name: string }>;

  const upstream = db
    .prepare('SELECT project_id, stage, status FROM upstream_status')
    .all() as Array<{ project_id: string; stage: 'copy' | 'cleanup'; status: string }>;
  const upstreamMap = new Map<string, { copy?: string; cleanup?: string }>();
  for (const u of upstream) {
    const entry = upstreamMap.get(u.project_id) ?? {};
    entry[u.stage] = u.status;
    upstreamMap.set(u.project_id, entry);
  }

  // documents_cache is per-file — collapse to one status per project: any
  // success -> DONE (even if some files errored, the project has content);
  // only errors and no successes -> ERROR; no rows at all -> NONE.
  const docRows = db
    .prepare(
      `SELECT project_id,
              SUM(CASE WHEN fetch_status = 'success' THEN 1 ELSE 0 END) AS ok,
              SUM(CASE WHEN fetch_status = 'error' THEN 1 ELSE 0 END) AS err
       FROM documents_cache
       GROUP BY project_id`
    )
    .all() as Array<{ project_id: string; ok: number; err: number }>;
  const downloadMap = new Map<string, StageStatus>();
  for (const d of docRows) {
    downloadMap.set(d.project_id, d.ok > 0 ? 'DONE' : d.err > 0 ? 'ERROR' : 'NONE');
  }

  // One project_goals row can exist per (project_id, output_language) — take
  // any 'success' as DONE regardless of language.
  const goalsRows = db
    .prepare('SELECT project_id, status FROM project_goals')
    .all() as Array<{ project_id: string; status: string }>;
  const goalsMap = new Map<string, StageStatus>();
  for (const g of goalsRows) {
    const current = goalsMap.get(g.project_id);
    if (current === 'DONE') continue; // success from any language wins
    goalsMap.set(g.project_id, mapGoalsStatus(g.status));
  }

  const impactRows = db
    .prepare(
      `SELECT source_project_id AS pid FROM projects_impact
       UNION
       SELECT target_project_id AS pid FROM projects_impact`
    )
    .all() as Array<{ pid: string }>;
  const impactSet = new Set(impactRows.map(r => r.pid));

  const rows: ProjectRow[] = projects.map(p => ({
    projectId: p.project_id,
    name: p.name,
    stages: {
      copy: mapUpstreamStatus(upstreamMap.get(p.project_id)?.copy),
      cleanup: mapUpstreamStatus(upstreamMap.get(p.project_id)?.cleanup),
      // Every row here is, by construction, already in the `projects` table —
      // discovery is what put it there. There's no "not yet discovered" state
      // to show in a table of already-discovered projects.
      discover: 'DONE',
      download: downloadMap.get(p.project_id) ?? 'NONE',
      goals: goalsMap.get(p.project_id) ?? 'NONE',
      impact: impactSet.has(p.project_id) ? 'DONE' : 'NONE',
    },
  }));

  return NextResponse.json({ projects: rows, generatedAt: new Date().toISOString() });
}

function mapUpstreamStatus(status: string | undefined): StageStatus {
  if (!status) return 'NONE';
  if (status === 'DONE') return 'DONE';
  if (status === 'ERROR') return 'ERROR';
  if (status === 'IN_PROGRESS') return 'IN_PROGRESS';
  if (status === 'QUEUED') return 'PENDING';
  return 'NONE'; // UNKNOWN upstream status — shown as absent rather than guessed
}

function mapGoalsStatus(status: string): StageStatus {
  if (status === 'success') return 'DONE';
  if (status === 'error') return 'ERROR';
  if (status === 'pending') return 'IN_PROGRESS';
  return 'NONE';
}
