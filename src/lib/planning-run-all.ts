// "Plan all" runner for the Details view — generates the Project Planning
// panel (see project-planning-engine.ts) for a batch of projects, one at a
// time, tracking per-project status so the UI can render a tiny progress
// indicator under each card. Modeled on drive-sync-all.ts's runner shape,
// but deliberately sequential (concurrency 1) rather than a worker pool:
// each item can itself trigger a Drive sync (project-planning-engine.ts's
// fold-in sync), and Drive downloads are already a single-flight lock
// (drive-engine.ts's module-scoped `downloadStatus`) — running several in
// parallel would just make later ones fail with "sync already running"
// instead of actually going faster. LLM calls also share one daily cap
// (llm.ts), so parallelism here buys nothing but a messier failure mode.

import { getDb } from './db';
import { getOrGeneratePlanning } from './project-planning-engine';
import { LLMCapExceededError } from './llm';
import { isSyncAllRunning } from './drive-sync-all';

export type PlanAllProjectStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped';

export interface PerProjectPlanState {
  projectId: string;
  name: string;
  status: PlanAllProjectStatus;
  // Populated once status is 'done': whether this hit the cache (near-instant)
  // or freshly called the LLM, and whether the project had any documents.
  cached: boolean | null;
  hasDocuments: boolean | null;
  errorMessage: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface PlanAllState {
  status: 'idle' | 'running' | 'stopping' | 'done';
  startedAt: string | null;
  finishedAt: string | null;
  totalProjects: number;
  doneProjects: number;
  stopRequested: boolean;
  // Set once the daily LLM cap is hit mid-run — the run stops immediately
  // since every subsequent call would fail identically.
  capExceeded: boolean;
  perProject: Record<string, PerProjectPlanState>;
}

// ─── Module-scoped state ────────────────────────────────────────────────────
// Same globalThis-symbol trick as drive-sync-all.ts, so Next.js dev-mode
// module duplication can't split this into two independent state objects.

interface InternalState {
  status: PlanAllState['status'];
  startedAt: string | null;
  finishedAt: string | null;
  totalProjects: number;
  stopRequested: boolean;
  capExceeded: boolean;
  order: string[];
  perProject: Map<string, PerProjectPlanState>;
}

const GLOBAL_KEY = '__stromPlanAllStateRef' as const;
type GlobalRef = { current: InternalState };
const g = globalThis as unknown as Record<string, GlobalRef | undefined>;

function emptyState(): InternalState {
  return {
    status: 'idle',
    startedAt: null,
    finishedAt: null,
    totalProjects: 0,
    stopRequested: false,
    capExceeded: false,
    order: [],
    perProject: new Map(),
  };
}

if (!g[GLOBAL_KEY]) {
  g[GLOBAL_KEY] = { current: emptyState() };
}
const stateRef: GlobalRef = g[GLOBAL_KEY]!;

export function isPlanAllRunning(): boolean {
  return stateRef.current.status === 'running' || stateRef.current.status === 'stopping';
}

export function getPlanAllState(): PlanAllState {
  let doneProjects = 0;
  const outPerProject: Record<string, PerProjectPlanState> = {};
  for (const projectId of stateRef.current.order) {
    const p = stateRef.current.perProject.get(projectId);
    if (!p) continue;
    outPerProject[projectId] = p;
    if (p.status === 'done' || p.status === 'error' || p.status === 'skipped') doneProjects++;
  }
  return {
    status: stateRef.current.status,
    startedAt: stateRef.current.startedAt,
    finishedAt: stateRef.current.finishedAt,
    totalProjects: stateRef.current.totalProjects,
    doneProjects,
    stopRequested: stateRef.current.stopRequested,
    capExceeded: stateRef.current.capExceeded,
    perProject: outPerProject,
  };
}

export function requestStopPlanAll(): { stopped: boolean } {
  if (stateRef.current.status !== 'running') return { stopped: false };
  stateRef.current.stopRequested = true;
  stateRef.current.status = 'stopping';
  return { stopped: true };
}

export function resetPlanAllState(): void {
  stateRef.current = emptyState();
}

// ─── Main runner ────────────────────────────────────────────────────────────

export async function runPlanAll(projectIds: string[]): Promise<void> {
  if (isPlanAllRunning()) {
    throw new Error('Plan all is already running');
  }
  if (isSyncAllRunning()) {
    throw new Error('A Drive Sync-all is in progress — wait for it to finish before running Plan all');
  }

  const uniqueIds = [...new Set(projectIds)].filter(Boolean);
  if (uniqueIds.length === 0) {
    throw new Error('No projects to plan');
  }

  const db = getDb();
  const placeholders = uniqueIds.map(() => '?').join(',');
  const nameRows = db.prepare(`
    SELECT project_id, name FROM projects WHERE project_id IN (${placeholders})
  `).all(...uniqueIds) as { project_id: string; name: string }[];
  const nameById = new Map(nameRows.map(r => [r.project_id, r.name]));

  stateRef.current = {
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    totalProjects: uniqueIds.length,
    stopRequested: false,
    capExceeded: false,
    order: uniqueIds,
    perProject: new Map(uniqueIds.map(id => [id, {
      projectId: id,
      name: nameById.get(id) || id,
      status: 'pending' as PlanAllProjectStatus,
      cached: null,
      hasDocuments: null,
      errorMessage: '',
      startedAt: null,
      finishedAt: null,
      durationMs: null,
    }])),
  };

  try {
    for (const projectId of uniqueIds) {
      if (stateRef.current.stopRequested) break;

      const entry = stateRef.current.perProject.get(projectId)!;
      entry.status = 'running';
      entry.startedAt = new Date().toISOString();

      try {
        const result = await getOrGeneratePlanning({ projectId });
        entry.status = 'done';
        entry.cached = result.cached;
        entry.hasDocuments = result.hasDocuments;
        entry.durationMs = result.durationMs;
      } catch (err: unknown) {
        if (err instanceof LLMCapExceededError) {
          stateRef.current.capExceeded = true;
          entry.status = 'skipped';
          entry.errorMessage = 'Daily LLM cap reached';
          entry.finishedAt = new Date().toISOString();
          // Every remaining call would fail the same way — stop the run now.
          break;
        }
        entry.status = 'error';
        entry.errorMessage = err instanceof Error ? err.message : String(err);
      }
      entry.finishedAt = new Date().toISOString();
    }
  } finally {
    for (const projectId of stateRef.current.order) {
      const p = stateRef.current.perProject.get(projectId);
      if (p && p.status === 'pending') {
        p.status = 'skipped';
        p.finishedAt = new Date().toISOString();
      }
    }
    stateRef.current.status = 'done';
    stateRef.current.finishedAt = new Date().toISOString();
  }
}
