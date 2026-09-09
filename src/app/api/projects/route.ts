import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import type { CIOOProject } from '@/lib/types';
import { fetchProjectSummariesForViews } from '@/lib/impact-engine';
import { getDownloadedFilesByProject } from '@/lib/drive-engine';
import { getSession } from '@/lib/auth';
import { getVisibleProjectIds } from '@/lib/access';

export async function GET(request: NextRequest) {
  try {
    const db = getDb();
    const { searchParams } = new URL(request.url);
    const mode = searchParams.get('mode') || 'summary';

    if (mode === 'raw') {
      // Admin/debug path, not wired to any view (PLAN_USER_MANAGEMENT.md
      // §4.1 scopes Fase 2 to the summary path below) — left unfiltered.
      const rows = db.prepare('SELECT * FROM projects ORDER BY review_date DESC').all() as DbRow[];
      const fileCounts = getDownloadedFilesByProject();
      const projects = rows.map(row => ({
        ...mapRowToProject(row),
        filesDownloaded: fileCounts.get(row.project_id) || 0,
      }));
      return NextResponse.json({ projects });
    }

    // Default: delegate to the Impact engine so the views see the same set as Impact
    const allSummaries = fetchProjectSummariesForViews();

    const session = await getSession();
    const visible = getVisibleProjectIds(session);
    const summaries =
      visible === 'ALL' ? allSummaries : allSummaries.filter(s => visible.has(s.projectId));

    // Computed AFTER the filter — a count that doesn't match the list on
    // screen is a visible bug, not a privacy concern under this model (§2.1).
    const stats = {
      totalProjects: summaries.length,
      totalRows: summaries.reduce((sum, s) => sum + s.reviewCount, 0),
      byDDS: countBy(summaries, s => s.dds),
      byGate: countBy(summaries, s => s.currentGate),
      byDecision: countBy(summaries, s => s.latestDecision),
      totalCost: summaries.reduce((sum, s) => sum + (s.costKEur || 0), 0),
    };

    return NextResponse.json({ projects: summaries, stats });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

interface DbRow {
  id: number;
  project_id: string;
  name: string;
  dds: string;
  gate: string;
  cost_keur: number | null;
  description: string;
  remarks: string;
  qa: string;
  review_date: string;
  decision: string;
  decision_mode: string;
  decision_date: string;
  review_status: string;
  documents_status: string;
  restricted: string;
  cost_before_g2: number | null;
  est_gate2_date: string;
  session_start: string;
  session_end: string;
  participants: string;
  link_positions: string;
  link_folder: string;
  link_cioo: string;
  year: number | null;
  month: number | null;
  batch_id: string;
  services?: string;

  // From project_goals JOIN
  digital_technologies?: string;
  change_management?: string;
  security_impacts?: string;
  regional_impacts?: string;
  ia_embedded?: string;
  gio_sl_dds_impacts?: string;
  dds_gio_workload?: string;
  business_apps_cis?: string;
}

function mapRowToProject(row: DbRow): CIOOProject {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    dds: row.dds,
    gate: row.gate,
    costKEur: row.cost_keur,
    description: row.description,
    remarks: row.remarks,
    qa: row.qa,
    reviewDate: row.review_date,
    decision: row.decision,
    decisionMode: row.decision_mode,
    decisionDate: row.decision_date,
    reviewStatus: row.review_status,
    documentsStatus: row.documents_status,
    restricted: row.restricted,
    costBeforeG2: row.cost_before_g2,
    estGate2Date: row.est_gate2_date,
    sessionStart: row.session_start,
    sessionEnd: row.session_end,
    participants: row.participants,
    linkPositions: row.link_positions,
    linkFolder: row.link_folder,
    linkCIOO: row.link_cioo,
    year: row.year,
    month: row.month,
    batchId: row.batch_id,
    services: row.services ? JSON.parse(row.services) : [],
  };
}

function countBy<T>(items: T[], keyFn: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyFn(item) || '(empty)';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}
