import { getDb } from './db';
import {
  discoverAndAddProjectFromDrive,
  discoverInitiativesFromDrive,
  runDriveDownload,
  getDriveStatus,
  extractDriveId,
} from './drive-engine';
import { runGoalsAnalysis, getGoalsStatus } from './goals-analyzer';
import { runFullImpactAnalysis } from './impact-engine';
import { LLMCapExceededError } from './llm';
import { isSyncAllRunning } from './drive-sync-all';

export type CycleTrigger = 'manual' | 'scheduled';
export type CycleMode = 'full' | 'goals-only';

export interface CycleReport {
  runId: number;
  newProjects: string[];
  goalsAddedCount: number;
  impactsAddedCount: number;
  errors: string[];
  status: 'success' | 'error' | 'partial';
  capExceeded: boolean;
}

export type RootKind = 'portfolio' | 'initiatives';

interface WatchRoot {
  id: number;
  url: string;
  drive_id: string;
  label: string;
  enabled: number;
  kind: RootKind;
}

let cycleRunning = false;
export type CycleStage = 'idle' | 'discover' | 'download' | 'goals' | 'impact' | 'finishing';
let currentStage: CycleStage = 'idle';
let currentRootLabel = '';

export function isAutoCycleRunning(): boolean {
  return cycleRunning;
}

export function getAutoCycleStage(): { stage: CycleStage; rootLabel: string } {
  return { stage: currentStage, rootLabel: currentRootLabel };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function snapshotProjectIds(): Set<string> {
  const db = getDb();
  const rows = db.prepare('SELECT project_id FROM projects').all() as { project_id: string }[];
  return new Set(rows.map(r => r.project_id));
}

function snapshotGoalsSuccessCount(): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) c FROM project_goals WHERE status = 'success'").get() as { c: number };
  return row.c;
}

function snapshotImpactsCount(): number {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) c FROM projects_impact').get() as { c: number };
  return row.c;
}

function startRun(trigger: CycleTrigger): number {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO auto_runs (started_at, trigger, status)
    VALUES (datetime('now'), ?, 'running')
  `).run(trigger);
  return Number(result.lastInsertRowid);
}

function finishRun(
  runId: number,
  report: { newProjects: number; goalsAdded: number; impactsAdded: number; errors: string[]; status: CycleReport['status'] },
) {
  const db = getDb();
  db.prepare(`
    UPDATE auto_runs
    SET finished_at = datetime('now'),
        new_projects = ?,
        goals_added = ?,
        impacts_added = ?,
        errors_json = ?,
        status = ?
    WHERE id = ?
  `).run(
    report.newProjects,
    report.goalsAdded,
    report.impactsAdded,
    JSON.stringify(report.errors),
    report.status,
    runId,
  );
}

function updateRootRunResult(
  rootId: number,
  status: 'success' | 'error',
  errorMsg: string,
  addedDelta: number,
) {
  const db = getDb();
  db.prepare(`
    UPDATE drive_watch_roots
    SET last_run_at = datetime('now'),
        last_run_status = ?,
        last_run_error = ?,
        added_count = added_count + ?
    WHERE id = ?
  `).run(status, errorMsg, addedDelta, rootId);
}

// ─── Main cycle ─────────────────────────────────────────────────────────────

export async function runAutoDiscoveryCycle(
  trigger: CycleTrigger = 'manual',
  mode: CycleMode = 'full',
): Promise<CycleReport> {
  if (cycleRunning) {
    throw new Error('An auto-discovery cycle is already running');
  }

  // Bail early if any of the underlying pipelines is already busy.
  if (getDriveStatus().isRunning) {
    throw new Error('Drive download is already running — try again later');
  }
  if (getGoalsStatus().isRunning) {
    throw new Error('Goals analysis is already running — try again later');
  }
  if (isSyncAllRunning()) {
    throw new Error('A manual Sync-all is in progress — skipping cycle');
  }

  cycleRunning = true;
  const runId = startRun(trigger);
  const errors: string[] = [];
  const newProjects = new Set<string>();
  let capExceeded = false;
  const handleStageError = (stage: string, err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`${stage}: ${msg}`);
    if (err instanceof LLMCapExceededError) capExceeded = true;
  };

  try {
    const db = getDb();
    const roots = db.prepare(
      'SELECT id, url, drive_id, label, enabled, kind FROM drive_watch_roots WHERE enabled = 1'
    ).all() as WatchRoot[];

    // ─── Stage 1: Discover ────────────────────────────────────────────────────
    currentStage = 'discover';
    for (const root of roots) {
      currentRootLabel = root.label || root.url;
      const before = snapshotProjectIds();
      try {
        // A portfolio root is scanned recursively for PRJ-named folders; an
        // initiatives root turns each of its direct subfolders into one
        // initiative. Both end up writing projects rows with a link_folder, so
        // every stage below this one is identical for the two.
        if (root.kind === 'initiatives') {
          await discoverInitiativesFromDrive(root.url, { rootId: root.id });
        } else {
          await discoverAndAddProjectFromDrive(root.url);
        }
        const after = snapshotProjectIds();
        let delta = 0;
        for (const id of after) {
          if (!before.has(id)) {
            newProjects.add(id);
            delta++;
          }
        }
        updateRootRunResult(root.id, 'success', '', delta);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        handleStageError(`Discover [${root.label || root.url}]`, err);
        updateRootRunResult(root.id, 'error', msg, 0);
      }
    }

    // ─── Stage 2: Download ────────────────────────────────────────────────────
    // runDriveDownload internally targets every project that has a Drive link
    // and isn't already locally present. Run it whenever we have at least one
    // root configured — discovery may have refreshed link_folder for existing rows too.
    if (roots.length > 0) {
      currentStage = 'download';
      currentRootLabel = '';
      try {
        await runDriveDownload();
      } catch (err: unknown) {
        handleStageError('Download', err);
      }
    }

    // ─── Stage 3: Goals Extractor ─────────────────────────────────────────────
    const goalsBefore = snapshotGoalsSuccessCount();
    if (!capExceeded) {
      currentStage = 'goals';
      try {
        await runGoalsAnalysis();
      } catch (err: unknown) {
        handleStageError('Goals', err);
      }
    }
    const goalsAdded = Math.max(0, snapshotGoalsSuccessCount() - goalsBefore);

    // ─── Stage 4: Impact ──────────────────────────────────────────────────────
    // Only spend Impact LLM budget if at least one new goal analysis was produced
    // AND the daily cap hasn't been hit AND we're not in 'goals-only' mode.
    let impactsAdded = 0;
    if (goalsAdded > 0 && !capExceeded && mode === 'full') {
      currentStage = 'impact';
      const impactsBefore = snapshotImpactsCount();
      try {
        await runFullImpactAnalysis();
      } catch (err: unknown) {
        handleStageError('Impact', err);
      }
      impactsAdded = Math.max(0, snapshotImpactsCount() - impactsBefore);
    }
    currentStage = 'finishing';

    const hasProgress = newProjects.size > 0 || goalsAdded > 0 || impactsAdded > 0;
    const status: CycleReport['status'] =
      errors.length === 0 ? 'success'
      : hasProgress || capExceeded ? 'partial'
      : 'error';

    finishRun(runId, {
      newProjects: newProjects.size,
      goalsAdded,
      impactsAdded,
      errors,
      status,
    });

    return {
      runId,
      newProjects: Array.from(newProjects),
      goalsAddedCount: goalsAdded,
      impactsAddedCount: impactsAdded,
      errors,
      status,
      capExceeded,
    };
  } finally {
    cycleRunning = false;
    currentStage = 'idle';
    currentRootLabel = '';
  }
}

// ─── CRUD on watch roots ────────────────────────────────────────────────────

export function listWatchRoots(): Array<{
  id: number;
  url: string;
  driveId: string;
  label: string;
  enabled: boolean;
  addedAt: string;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunError: string;
  addedCount: number;
  kind: RootKind;
}> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, url, drive_id, label, enabled, added_at, last_run_at, last_run_status, last_run_error, added_count, kind
    FROM drive_watch_roots
    ORDER BY added_at DESC
  `).all() as Array<{
    id: number; url: string; drive_id: string; label: string; enabled: number;
    added_at: string; last_run_at: string | null; last_run_status: string | null;
    last_run_error: string; added_count: number; kind: RootKind;
  }>;
  return rows.map(r => ({
    id: r.id,
    url: r.url,
    driveId: r.drive_id,
    label: r.label,
    enabled: r.enabled === 1,
    addedAt: r.added_at,
    lastRunAt: r.last_run_at,
    lastRunStatus: r.last_run_status,
    lastRunError: r.last_run_error,
    addedCount: r.added_count,
    kind: r.kind === 'initiatives' ? 'initiatives' : 'portfolio',
  }));
}

export function addWatchRoot(
  url: string,
  label?: string,
  kind: RootKind = 'portfolio',
): { id: number } {
  const driveId = extractDriveId(url);
  if (!driveId) throw new Error('Invalid Google Drive URL');
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO drive_watch_roots (url, drive_id, label, kind)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(url) DO UPDATE SET label = excluded.label, kind = excluded.kind
  `).run(url, driveId, label || '', kind);
  const id = Number(result.lastInsertRowid)
    || (db.prepare('SELECT id FROM drive_watch_roots WHERE url = ?').get(url) as { id: number }).id;
  return { id };
}

export function deleteWatchRoot(id: number): void {
  const db = getDb();
  db.prepare('DELETE FROM drive_watch_roots WHERE id = ?').run(id);
}

export function setWatchRootEnabled(id: number, enabled: boolean): void {
  const db = getDb();
  db.prepare('UPDATE drive_watch_roots SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
}

export function getLastAutoRun(): {
  id: number; startedAt: string; finishedAt: string | null; trigger: string;
  newProjects: number; goalsAdded: number; impactsAdded: number; errors: string[]; status: string;
} | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT id, started_at, finished_at, trigger, new_projects, goals_added, impacts_added, errors_json, status
    FROM auto_runs
    ORDER BY id DESC
    LIMIT 1
  `).get() as {
    id: number; started_at: string; finished_at: string | null; trigger: string;
    new_projects: number; goals_added: number; impacts_added: number; errors_json: string; status: string;
  } | undefined;
  if (!row) return null;
  let errors: string[] = [];
  try { errors = JSON.parse(row.errors_json); } catch { /* */ }
  return {
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    trigger: row.trigger,
    newProjects: row.new_projects,
    goalsAdded: row.goals_added,
    impactsAdded: row.impacts_added,
    errors,
    status: row.status,
  };
}
