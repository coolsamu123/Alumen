/**
 * One row per project with the state of every stage of the chain — the single
 * table of Drive Sync.
 *
 *   request  → _alumen_queue.json (Drive)          Alumen asked Apps Script
 *   copy     → upstream_status stage 'copy'        Apps Script
 *   cleanup  → upstream_status stage 'cleanup'     Apps Script
 *   discover → projects.link_folder                Alumen found the PRJ folder
 *   download → documents_cache                     Alumen fetched the files
 *   goals    → project_goals                       Gemini
 *   impact   → projects_impact                     Gemini
 *
 * This used to be two tables in two screens (Drive Sync's explorer and the
 * Data Flow "Projetos" tab) that each knew half of the chain.
 *
 * Built from SQLite only; the queue is passed in by the caller, which reads it
 * from Drive.
 */
import { isProjectId } from './project-id';
import { getDb } from './db';
import { pendingRedos } from './project-redo';
import { isAutoCycleRunning, getAutoCycleStage, BASE_FOLDER_SCANNED_SETTING } from './auto-pipeline';
import type { ProjectSource } from './types';

// 'empty': download ran but the Drive folder has no usable document — not an error.
export type StageState = 'done' | 'running' | 'error' | 'waiting' | 'none' | 'na' | 'empty';

const NO_FILES_MSG = 'No files found or not accessible';

export const STAGES = ['request', 'copy', 'cleanup', 'discover', 'download', 'goals', 'impact'] as const;
export type StageKey = typeof STAGES[number];

export interface PipelineRow {
  projectId: string;
  name: string;
  source: ProjectSource;
  cdioMissingSince: string | null;
  dds: string;
  gate: string;
  /** "YYYY-MM" from the CDIO period / review date, '' when unknown. */
  period: string;
  stages: Record<StageKey, StageState>;
  /** Human-readable error per stage, only for stages in 'error'. */
  errors: Partial<Record<StageKey, string>>;
  filesDownloaded: number;
  impactCount: number;
  linkFolder: string;
  /** Not requested and nothing downstream: the row offers "Carregar". */
  loadable: boolean;
  /** "Redo all" was asked and is not finished: every stage shows waiting. */
  redoSince: string | null;
}

function upstreamState(status: string | undefined): StageState {
  switch (status) {
    case 'DONE': return 'done';
    case 'ERROR': return 'error';
    case 'IN_PROGRESS': return 'running';
    case 'QUEUED': return 'waiting';
    default: return 'none';
  }
}

function detailText(detailJson: string | undefined): string {
  if (!detailJson) return '';
  try {
    const d = JSON.parse(detailJson) as Record<string, unknown>;
    const msg = d.error ?? d.message ?? d.detail ?? d.status;
    return msg ? String(msg) : JSON.stringify(d).slice(0, 300);
  } catch {
    return detailJson.slice(0, 300);
  }
}

function safeAll<T>(sql: string): T[] {
  try {
    return getDb().prepare(sql).all() as T[];
  } catch {
    return []; // table may not exist yet on a fresh install
  }
}

export function buildPipelineRows(queued: Set<string>): PipelineRow[] {
  const projects = safeAll<{
    project_id: string; name: string; source: string | null; cdio_missing_since: string | null;
    dds: string | null; gate: string | null; year: number | null; month: number | null;
    link_folder: string | null;
  }>(`
    SELECT p.project_id, p.name, p.source, p.cdio_missing_since, p.dds, p.gate,
           p.year, p.month, p.link_folder
    FROM projects p
    WHERE p.id = (SELECT MAX(p2.id) FROM projects p2 WHERE p2.project_id = p.project_id)
      AND COALESCE(p.source, 'excel') <> 'initiative'
    ORDER BY p.project_id
  `);

  const upstream = new Map<string, { status: string; detail_json: string; sheet_at: string | null }>();
  for (const u of safeAll<{ project_id: string; stage: string; status: string; detail_json: string; sheet_at: string | null }>(
    'SELECT project_id, stage, status, detail_json, sheet_at FROM upstream_status',
  )) {
    upstream.set(`${u.project_id}|${u.stage}`, u);
  }

  // `real` counts actual failures; "No files found…" (empty folder) and
  // skipped files are not failures, they mean there is nothing to read.
  const docs = new Map<string, { ok: number; bad: number; real: number; err: string }>();
  for (const d of safeAll<{ project_id: string; ok: number; bad: number; real: number; err: string | null }>(`
    SELECT project_id,
           SUM(CASE WHEN fetch_status = 'success' THEN 1 ELSE 0 END) ok,
           SUM(CASE WHEN fetch_status <> 'success' THEN 1 ELSE 0 END) bad,
           SUM(CASE WHEN fetch_status = 'error'
                     AND COALESCE(error_message, '') <> '${NO_FILES_MSG}' THEN 1 ELSE 0 END) real,
           MAX(CASE WHEN fetch_status = 'error'
                     AND COALESCE(error_message, '') <> '${NO_FILES_MSG}' THEN NULLIF(error_message, '') END) err
    FROM documents_cache GROUP BY project_id
  `)) {
    docs.set(d.project_id, { ok: d.ok, bad: d.bad, real: d.real, err: d.err ?? '' });
  }

  const goals = new Map<string, { status: string; err: string }>();
  for (const g of safeAll<{ project_id: string; status: string; error_message: string | null }>(`
    SELECT project_id, status, error_message FROM project_goals
    WHERE id IN (SELECT MAX(id) FROM project_goals GROUP BY project_id)
  `)) {
    goals.set(g.project_id, { status: g.status, err: g.error_message ?? '' });
  }
  const goalsOk = new Set(safeAll<{ project_id: string }>(
    "SELECT DISTINCT project_id FROM project_goals WHERE status = 'success'",
  ).map(r => r.project_id));

  const impacts = new Map<string, number>();
  for (const r of safeAll<{ pid: string; c: number }>(`
    SELECT pid, COUNT(*) c FROM (
      SELECT source_project_id pid FROM projects_impact
      UNION ALL SELECT target_project_id pid FROM projects_impact
    ) GROUP BY pid
  `)) impacts.set(r.pid, r.c);

  const cycle = isAutoCycleRunning() ? getAutoCycleStage().stage : 'idle';
  const redos = pendingRedos();

  // For "discover was tried and found nothing". Both normalised to SQLite's
  // datetime() text so they compare as strings.
  const cleanupDoneAt = new Map<string, string>();
  for (const e of safeAll<{ project_id: string; at: string }>(`
    SELECT project_id, datetime(MAX(observed_at)) at FROM upstream_events
    WHERE stage = 'cleanup' AND to_status = 'DONE' GROUP BY project_id
  `)) cleanupDoneAt.set(e.project_id, e.at);
  const lastCycleStart = safeAll<{ at: string | null }>(
    `SELECT datetime(value) at FROM app_settings WHERE key = '${BASE_FOLDER_SCANNED_SETTING}'`,
  )[0]?.at ?? null;

  return projects.map(p => {
    const id = p.project_id;
    const errors: Partial<Record<StageKey, string>> = {};
    const copyRow = upstream.get(`${id}|copy`);
    const cleanRow = upstream.get(`${id}|cleanup`);
    const copy = upstreamState(copyRow?.status);
    const cleanup = upstreamState(cleanRow?.status);
    if (copy === 'error') errors.copy = detailText(copyRow?.detail_json);
    if (cleanup === 'error') errors.cleanup = detailText(cleanRow?.detail_json);

    const isQueued = queued.has(id.toUpperCase());
    const linked = !!(p.link_folder && p.link_folder.trim());
    const request: StageState = isQueued ? 'waiting' : (copyRow || cleanRow || linked) ? 'done' : 'none';

    let discover: StageState = linked ? 'done'
      : cleanup === 'done' ? (cycle === 'discover' ? 'running' : 'waiting')
      : 'none';
    // Same rule as pendingWork(): a completed base-folder scan already looked for the
    // folder after cleanup finished and did not find it. Waiting longer will
    // not change that.
    const cleanedAt = cleanupDoneAt.get(id);
    if (discover === 'waiting' && cleanedAt && lastCycleStart && lastCycleStart > cleanedAt) {
      discover = 'error';
      errors.discover = 'Project folder not found in the base folder. Apps Script finished, but there is no '
        + 'folder with this number (wrong number, or the copy found no documents).';
    }

    const d = docs.get(id);
    let download: StageState = 'none';
    if (d && d.ok > 0) download = 'done';
    else if (d && d.real > 0) { download = 'error'; errors.download = d.err || NO_FILES_MSG; }
    else if (d && d.bad > 0) download = 'empty';
    else if (linked) download = cycle === 'download' ? 'running' : 'waiting';

    const g = goals.get(id);
    let goalsState: StageState = 'none';
    if (goalsOk.has(id)) goalsState = 'done';
    else if (g?.status === 'error') { goalsState = 'error'; errors.goals = g.err || 'Goals extraction failed'; }
    else if (download === 'done') goalsState = cycle === 'goals' ? 'running' : 'waiting';

    const impactCount = impacts.get(id) ?? 0;
    const impact: StageState = impactCount > 0 ? 'done'
      : goalsState === 'done' ? (cycle === 'impact' ? 'running' : 'waiting')
      : 'none';

    const stages: Record<StageKey, StageState> = { request, copy, cleanup, discover, download, goals: goalsState, impact };

    // Redo pending: a stage counts as done only if redone after the request.
    const redo = redos.get(id.toUpperCase());
    if (redo) {
      // Until Apps Script rewrites the row, its state is the old run's.
      const redone = (row: typeof copyRow, before: string | null, st: StageState): StageState =>
        row?.sheet_at && row.sheet_at !== before && st !== 'none' ? st : 'waiting';
      stages.copy = redone(copyRow, redo.copy_sheet_at, copy);
      stages.cleanup = redone(cleanRow, redo.cleanup_sheet_at, cleanup);
      stages.request = copyRow?.sheet_at && copyRow.sheet_at !== redo.copy_sheet_at ? 'done' : 'waiting';
      stages.discover = stages.cleanup === 'done' ? discover : 'waiting';
      stages.download = 'waiting';
      stages.goals = 'waiting';
      stages.impact = 'waiting';
      for (const k of Object.keys(errors) as StageKey[]) if (stages[k] !== 'error') delete errors[k];
    }

    const period = p.year && p.month ? `${p.year}-${String(p.month).padStart(2, '0')}` : '';
    const source = (['excel', 'drive', 'manual'].includes(p.source ?? '') ? p.source : 'excel') as ProjectSource;

    return {
      projectId: id,
      name: p.name,
      source,
      cdioMissingSince: p.cdio_missing_since,
      dds: p.dds ?? '',
      gate: p.gate ?? '',
      period,
      stages,
      errors,
      filesDownloaded: d?.ok ?? 0,
      impactCount,
      linkFolder: p.link_folder ?? '',
      loadable: request === 'none' && !linked && !redo,
      redoSince: redo?.requested_at ?? null,
    };
  });
}

/** CDIO projects nobody asked for yet — what "Carregar novos do CDIO" loads. */
export function newCdioProjects(rows: PipelineRow[]): string[] {
  return rows
    // isProjectId rejects template rows such as "PRJ00XXXXX", which /^PRJ\d+/ let through.
    .filter(r => r.source === 'excel' && !r.cdioMissingSince && r.loadable &&
      /^PRJ/.test(r.projectId) && isProjectId(r.projectId))
    .map(r => r.projectId);
}
