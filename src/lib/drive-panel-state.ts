import { getDb } from '@/lib/db';
import { getDriveStatus, getDownloadedFilesByProject } from '@/lib/drive-engine';
import { getGoalsStatus } from '@/lib/goals-analyzer';
import { getImpactStatus } from '@/lib/impact-engine';
import {
  listWatchRoots,
  getLastAutoRun,
  isAutoCycleRunning,
  getAutoCycleStage,
} from '@/lib/auto-pipeline';
import { getTodayLLMStats } from '@/lib/llm';
import { getSyncAllState, isSyncAllRunning } from '@/lib/drive-sync-all';
import { getUpstreamSnapshot, type UpstreamSnapshot } from '@/lib/upstream-sync';

export interface DrivePanelState {
  pipeline: {
    isRunning: boolean;
    stage: string;
    root: string;
    drive: ReturnType<typeof getDriveStatus>;
    goals: ReturnType<typeof getGoalsStatus>;
    impact: ReturnType<typeof getImpactStatus>;
    elapsedSec: number;       // seconds since this run's startedAt
    etaSec: number | null;    // null when no estimate is possible yet
  };
  counts: {
    totalProjects: number;
    withFiles: number;
    withGoals: number;
    withImpacts: number;
  };
  todayLLM: ReturnType<typeof getTodayLLMStats>;
  watchRoots: ReturnType<typeof listWatchRoots>;
  lastRun: ReturnType<typeof getLastAutoRun>;
  syncAll: ReturnType<typeof getSyncAllState>;
  recentRuns: Array<{
    id: number;
    startedAt: string;
    finishedAt: string | null;
    trigger: string;
    status: string;
    newProjects: number;
    goalsAdded: number;
    impactsAdded: number;
    errorCount: number;
  }>;
  /** Stages 0–1 of the chain: the two Apps Script control spreadsheets,
   *  mirrored by upstream-sync.ts on its own cadence. */
  upstream: UpstreamSnapshot;
  generatedAt: string;
}

export function buildDrivePanelState(): DrivePanelState {
  const db = getDb();

  // Lazy heal: if a previous process was killed mid-cycle (no scheduler now,
  // but Sync All / manual triggers still write to auto_runs), the row stays
  // 'running' forever. Mark anything still running with no finished_at and
  // started > 30 min ago as aborted so the UI doesn't show a phantom.
  try {
    db.prepare(`
      UPDATE auto_runs
      SET finished_at = datetime('now'),
          status = 'aborted',
          errors_json = json_insert(COALESCE(NULLIF(errors_json,''),'[]'),'$[#]','Aborted: stale running row healed by panel-state')
      WHERE status = 'running'
        AND (julianday('now') - julianday(started_at)) * 24 * 60 > 30
    `).run();
  } catch { /* ignore */ }

  const distinctProjectIds = db.prepare(
    'SELECT DISTINCT project_id FROM projects'
  ).all() as { project_id: string }[];
  const totalProjects = distinctProjectIds.length;

  const filesByProject = getDownloadedFilesByProject();
  let withFiles = 0;
  for (const { project_id } of distinctProjectIds) {
    if ((filesByProject.get(project_id) || 0) > 0) withFiles++;
  }

  let withGoals = 0;
  try {
    const r = db.prepare(
      "SELECT COUNT(DISTINCT project_id) c FROM project_goals WHERE status = 'success'"
    ).get() as { c: number };
    withGoals = r.c;
  } catch { /* table may not exist yet */ }

  const impactRow = db.prepare(`
    SELECT COUNT(*) c FROM (
      SELECT source_project_id AS pid FROM projects_impact
      UNION
      SELECT target_project_id AS pid FROM projects_impact
    )
  `).get() as { c: number };
  const withImpacts = impactRow?.c || 0;

  const { stage, rootLabel } = getAutoCycleStage();
  const drive = getDriveStatus();
  const goals = getGoalsStatus();
  const impact = getImpactStatus();
  const syncAll = getSyncAllState();
  const isRunning =
    isAutoCycleRunning() || drive.isRunning || goals.isRunning || impact.isRunning || isSyncAllRunning();

  const recentRunsRaw = db.prepare(`
    SELECT id, started_at, finished_at, trigger, status, new_projects, goals_added, impacts_added, errors_json
    FROM auto_runs
    ORDER BY id DESC
    LIMIT 10
  `).all() as Array<{
    id: number; started_at: string; finished_at: string | null; trigger: string;
    status: string; new_projects: number; goals_added: number; impacts_added: number; errors_json: string;
  }>;

  // Elapsed + ETA derived from drive status. ETA is meaningful only during the
  // Download stage; for Goals/Impact we'd need per-stage timing which we don't
  // track yet. nullable so the UI can decide whether to show.
  let elapsedSec = 0;
  let etaSec: number | null = null;
  if (drive.startedAt) {
    elapsedSec = Math.max(0, (Date.now() - new Date(drive.startedAt).getTime()) / 1000);
    if (drive.isRunning) {
      const done = drive.downloadedFiles + drive.skippedFiles;
      const remaining = Math.max(0, drive.totalFiles - done);
      if (done > 0 && elapsedSec > 1) {
        const rate = done / elapsedSec; // files per second
        if (rate > 0) etaSec = Math.round(remaining / rate);
      }
    }
  }

  return {
    pipeline: {
      isRunning,
      stage,
      root: rootLabel,
      drive,
      goals,
      impact,
      elapsedSec: Math.round(elapsedSec),
      etaSec,
    },
    counts: { totalProjects, withFiles, withGoals, withImpacts },
    todayLLM: getTodayLLMStats(),
    watchRoots: listWatchRoots(),
    lastRun: getLastAutoRun(),
    syncAll,
    recentRuns: recentRunsRaw.map(r => ({
      id: r.id,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      trigger: r.trigger,
      status: r.status,
      newProjects: r.new_projects,
      goalsAdded: r.goals_added,
      impactsAdded: r.impacts_added,
      errorCount: (() => { try { return JSON.parse(r.errors_json).length; } catch { return 0; } })(),
    })),
    // Cache read only — getUpstreamSnapshot() never touches Google on this
    // path (PLAN_LIVE_DATAFLOW.md §3.3: the SSE ticks up to 120×/min per open
    // tab). Its own timer does the fetching; a failure there surfaces as
    // upstream.error and leaves the last good rows in place.
    upstream: getUpstreamSnapshot(),
    generatedAt: new Date().toISOString(),
  };
}
