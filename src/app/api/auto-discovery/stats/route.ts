import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getTodayLLMStats } from '@/lib/llm';

// Reads mutable state — must not be prerendered at build time. See the note in
// api/drive/projects/route.ts.
export const dynamic = 'force-dynamic';

export async function GET() {
  const today = getTodayLLMStats();

  const db = getDb();
  const recentRuns = db.prepare(`
    SELECT id, started_at, finished_at, trigger, status, new_projects, goals_added, impacts_added, errors_json
    FROM auto_runs
    ORDER BY id DESC
    LIMIT 10
  `).all() as Array<{
    id: number; started_at: string; finished_at: string | null; trigger: string;
    status: string; new_projects: number; goals_added: number; impacts_added: number; errors_json: string;
  }>;

  return NextResponse.json({
    today,
    recentRuns: recentRuns.map(r => ({
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
  });
}
